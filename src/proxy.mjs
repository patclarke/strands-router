import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  TIERS,
  TIER_NAMES,
  tierOf,
  idOf,
  rankOf,
  availableTiers,
  tierSpec,
  isAuto,
  shouldUseExactModel,
} from "./config.mjs";
import { directionOf, resolveBaseline, trackResponse } from "./accounting.mjs";
import { appendEntry } from "./ledger.mjs";
import { askDecider } from "./router.mjs";
import { decide } from "./policy.mjs";
import { log } from "./log.mjs";
import { writeDecision, writeStatus } from "./status.mjs";

const ANTHROPIC_BASE_URL = "https://api.anthropic.com";
const debug = (line) => process.env.STRANDS_DEBUG && log(line);

/**
 * Claude Code converts draft-04 relics in MCP tool schemas before sending them first-party,
 * but skips that when ANTHROPIC_BASE_URL is set, so the API rejects the request. In draft
 * 2020-12 `exclusiveMinimum`/`exclusiveMaximum` are numbers, not booleans.
 */
export function sanitizeSchema(node) {
  if (Array.isArray(node)) return node.forEach(sanitizeSchema);
  if (!node || typeof node !== "object") return;
  for (const [key, bound] of [
    ["exclusiveMinimum", "minimum"],
    ["exclusiveMaximum", "maximum"],
  ]) {
    if (typeof node[key] === "boolean") {
      if (node[key] && typeof node[bound] === "number") {
        node[key] = node[bound];
        delete node[bound];
      } else {
        delete node[key];
      }
    }
  }
  for (const v of Object.values(node)) sanitizeSchema(v);
}

/**
 * Claude Code's gateway hint headers, which label each request so a router doesn't have to
 * infer it from the body. Sent behind a custom base URL only with
 * CLAUDE_CODE_GATEWAY_HINT_HEADERS=1, which strands-claude sets. `requestClass` is `main`,
 * `subagent`, `workflow`, `compaction` or `auxiliary` (v2.1.273+); `promptId` is shared by every
 * request serving one user prompt, its subagents included (v2.1.283+). Either may be null.
 * https://code.claude.com/docs/en/llm-gateway-protocol#gateway-hint-headers
 */
export function hintsOf(headers = {}) {
  const value = (name) => {
    const v = headers[name];
    return typeof v === "string" && v ? v : null;
  };
  return {
    requestClass: value("x-claude-code-request-class"),
    promptId: value("x-claude-code-prompt-id"),
  };
}

/** Requests that never start a turn: conversation summaries, and titles and classifiers. */
const NEVER_A_TURN = new Set(["compaction", "auxiliary"]);

/**
 * Text the user typed in the latest message, skipping trailing mid-conversation system messages
 * (newer Claude Code appends reminders after the prompt). Claude Code also injects
 * `<system-reminder>` blocks into the user message, which are noise to a router and measurably
 * blunt the decider's confidence, so they are removed. Null when there is no typed text, or when
 * `toolResults` is "reject" and the message carries tool results.
 */
function userText(body, { toolResults = "reject" } = {}) {
  const last = body?.messages?.findLast((message) => message?.role !== "system");
  if (!last || last.role !== "user") return null;
  let text;
  if (typeof last.content === "string") {
    text = last.content;
  } else if (Array.isArray(last.content)) {
    if (toolResults === "reject" && last.content.some((b) => b.type === "tool_result")) return null;
    text = last.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } else {
    return null;
  }
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim() || null;
}

/**
 * The text of a genuinely new user turn, or null.
 *
 * A turn can continue for many requests while Claude works through tool calls. Routing those
 * would re-ask the decider on every tool call and let the model flip mid-task, so only the
 * opening request of a turn counts.
 *
 * With hint headers this is exact: labelled compaction and auxiliary requests never count, and
 * with a prompt id a turn starts precisely when the id differs from `lastPromptId`, the one last
 * seen in this conversation. Without them (older Claude Code, or hints turned off) it falls back
 * to reading the body: auxiliary calls carry no tools, and tool-loop continuations end in a
 * `tool_result` rather than typed text.
 */
export function newTurnPrompt(body, hints = {}, lastPromptId = null) {
  if (NEVER_A_TURN.has(hints.requestClass)) return null;
  if (hints.requestClass && hints.promptId) {
    if (hints.promptId === lastPromptId) return null;
    return userText(body, { toolResults: "ignore" });
  }
  if (!Array.isArray(body?.tools) || body.tools.length === 0) return null; // auxiliary call
  return userText(body);
}

/**
 * Points a request at a tier, removing request fields that tier cannot accept. Claude Code
 * composes the body for whatever model it thinks it is talking to, so downgrading to Haiku
 * while leaving `thinking: {type:"adaptive"}` in place is a hard 400.
 */
export function applyTier(body, tierName, model = idOf(tierName)) {
  const tier = tierSpec(tierName);
  if (!tier) return body;
  body.model = model;
  if (!tier.thinking) {
    delete body.thinking;
    // A context-management strategy that prunes thinking blocks is itself rejected once
    // thinking is gone, so it has to go with it.
    const edits = body.context_management?.edits;
    if (Array.isArray(edits)) {
      body.context_management.edits = edits.filter((e) => !/thinking/i.test(e?.type ?? ""));
      if (body.context_management.edits.length === 0) delete body.context_management;
    }
  }
  if (!tier.effort && body.output_config) {
    delete body.output_config.effort;
    if (Object.keys(body.output_config).length === 0) delete body.output_config;
  }
  return body;
}

/** Exact Claude models reported by the account, newest first; static ids are the cold-start fallback. */
export function claudeModels(catalog = []) {
  const models = catalog
    .filter((model) => tierOf(model?.id))
    .map((model) => ({
      id: model.id,
      tier: tierOf(model.id),
      description: [
        model.display_name,
        model.created_at && `released ${model.created_at.slice(0, 10)}`,
        model.max_input_tokens && `${model.max_input_tokens} input tokens`,
      ].filter(Boolean).join("; "),
    }));
  return models.length
    ? models
    : TIERS.map((tier) => ({ id: tier.id, tier: tier.name, description: tier.id }));
}

const modelForTier = (models, tier) => models.find((model) => model.tier === tier)?.id ?? idOf(tier);

/**
 * Identifies the conversation a request belongs to. Claude Code runs sub-agents through the
 * same endpoint, so a single pinned model would let a sub-agent's choice leak into the main
 * conversation.
 *
 * Only stable fields may be used. Claude Code moves its `cache_control` breakpoint between
 * requests and rewrites message metadata, so the key is built from the session id plus the
 * text of the first message, which is fixed once a conversation starts and differs between
 * the main agent and each sub-agent.
 */
/**
 * Session id Claude Code embeds in request metadata, or "" when it isn't present.
 * `metadata.user_id` is a JSON string, not a plain id.
 */
export function sessionOf(body) {
  try {
    return JSON.parse(body?.metadata?.user_id ?? "{}").session_id ?? "";
  } catch {
    return "";
  }
}

export function conversationKey(body) {
  const session = sessionOf(body);
  const content = body?.messages?.[0]?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
        : "";
  return createHash("sha1").update(`${session}|${text}`).digest("hex").slice(0, 12);
}

/**
 * Records the tier Claude Code is asking for and reports whether the user has taken manual
 * control. The first tier seen in a conversation is the baseline; any later change means the
 * user picked a model with /model, and an explicit choice must beat the router. Compared by
 * tier rather than exact model id, because Claude Code varies the id within a tier.
 */
export function observeModel(state, current) {
  state.baseline ??= current;
  if (current !== state.baseline) state.manual = true;
  return state.manual;
}


/** Billed message requests; token counting and model listing cost nothing. */
const isBilled = (method, url = "") => method === "POST" && /^\/v1\/messages(?:\?|$)/.test(url);

export async function startProxy({
  upstreamURL = ANTHROPIC_BASE_URL,
  route = askDecider,
  baselineModel,
  record = appendEntry,
} = {}) {
  // Tier routed for each conversation's turn in flight, reused by its follow-up requests and
  // by the cache-rebuild guard, which needs to know what the prompt cache was built on.
  const convos = new Map();
  const catalog = new Map();
  const stateFor = (key) => {
    let s = convos.get(key);
    if (!s) {
      if (convos.size > 50) convos.delete(convos.keys().next().value);
      convos.set(key, (s = { tier: null }));
    }
    return s;
  };

  const server = http.createServer((req, res) => {
    // Claude Code probes the base URL before its first request.
    if (req.method === "HEAD") return res.writeHead(200).end();

    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      let out = Buffer.concat(chunks);
      // What to bill this response as, filled in once the request body is understood.
      let tracking = null;

      if (/^\/v1\/messages/.test(req.url ?? "")) {
        try {
          const body = JSON.parse(out.toString());
          // Claude Code's request shape is undocumented and moves; STRANDS_DUMP captures it.
          if (process.env.STRANDS_DUMP) {
            writeFileSync(`${process.env.STRANDS_DUMP}.${Date.now()}.json`, JSON.stringify(body, null, 2));
          }
          body.tools?.forEach((t) => sanitizeSchema(t.input_schema));

          // Anything that is not the sentinel is a model the user chose, and an explicit
          // choice beats the router. That also covers Claude Code's own cheap Haiku calls
          // for titles and summaries, which must never be pinned up to the session's tier.
          if (!isAuto(body.model)) {
            debug(`passthrough, user selected ${body.model}`);
            // Only a real agent turn reflects the user's choice. Claude Code's own auxiliary
            // calls carry no tools and must not flip the status line to manual mid-session.
            if (Array.isArray(body.tools)) {
              writeStatus(sessionOf(body), { manual: true, at: Date.now() });
            }
            tracking = { routed: false, model: body.model, session: sessionOf(body) || conversationKey(body) };
          } else {
            const key = conversationKey(body);
            const state = stateFor(key);
            const baseline = resolveBaseline({
              saved: baselineModel,
              modelForTier: (t) => modelForTier(claudeModels([...catalog.values()]), t),
              tierOf,
              tiers: TIER_NAMES,
            });
            // A session starts on the model it would have used without routing, so every saving
            // the ledger records comes from a routing decision, not from where routing began.
            const startTier = availableTiers().includes(tierOf(baseline)) ? tierOf(baseline) : "opus";
            // The baseline itself when a tier is the baseline's, so a session that is never moved
            // runs exactly the model it is compared against (minus Claude Code's "[1m]" alias).
            const modelFor = (tier) =>
              tier === tierOf(baseline)
                ? baseline.replace(/\[.*\]$/, "")
                : modelForTier(claudeModels([...catalog.values()]), tier);
            // What the prompt cache was built on, which is what a downgrade would discard.
            const current = state.tier ?? startTier;
            const hints = hintsOf(req.headers);
            const prompt = newTurnPrompt(body, hints, state.promptId);
            // Remember which prompt this conversation is serving, so its follow-up requests
            // (tool calls, retries) reuse the turn's decision instead of asking again.
            if (hints.promptId && !NEVER_A_TURN.has(hints.requestClass)) state.promptId = hints.promptId;
            const explaining = prompt?.includes("<strands-explain>");
            let fresh = null;
            if (prompt && !explaining) {
              const models = claudeModels([...catalog.values()]).filter((model) =>
                availableTiers().includes(model.tier),
              );
              const available = [...new Set(models.map((model) => model.tier))];
              const currentModel = state.model ?? modelFor(current);
              const contextTokens = Math.round(JSON.stringify(body.messages).length / 4);
              const decider = await route({ prompt, current: currentModel, contextTokens, models });
              const chosen = models.find((model) => model.id === decider?.choice);
              const tierAnswer = decider && { ...decider, choice: chosen?.tier };
              const { tier, reason } = decide({
                prompt,
                decider: tierAnswer,
                current,
                available,
                contextTokens,
              });
              const model =
                shouldUseExactModel(reason, chosen?.tier, tier)
                  ? chosen.id
                  : tier === current
                    ? currentModel
                    : modelForTier(models, tier);
              state.tier = tier;
              state.model = model;
              state.reason = reason;
              fresh = {
                prompt,
                model,
                confidence: decider?.confidence ?? null,
                metrics: decider?.metrics ?? null,
                reason,
                ms: decider?.ms ?? null,
                decider: decider ? { request: decider.request, response: decider.response } : null,
              };
              debug(
                `${key} ${decider ? `${decider.ms}ms p=${decider.confidence.toFixed(2)}` : "no-decider"} ` +
                  `${current} -> ${tier} (${reason}) ctx~${contextTokens} ` +
                  `turn:${hints.promptId ? "hints" : "body"} | ${prompt.slice(0, 60)}`,
              );
            }
            // The sentinel is not a real model, so every routed request must be rewritten,
            // including follow-ups that reuse the tier chosen for the turn.
            const tier = state.tier ?? current;
            const model = state.model ?? modelFor(tier);
            debug(`${key} rewrite ${body.model} -> ${model}`);
            applyTier(body, tier, model);
            // Publish what went out. Claude Code's UI shows the row you picked, not the tier
            // it resolved to, so the status line is the only place this is visible.
            // `claude -p` omits metadata on the first request of a session, so there is no
            // session id to file the decision under and it would be dropped. The conversation
            // key is stable for the same conversation and is already what `debug` prints, so
            // it is the identifier a user can pass to `strands-explain` for a print-mode run.
            if (fresh && !explaining) {
              writeDecision(sessionOf(body) || key, { tier, ...fresh, at: Date.now() });
            }
            tracking = {
              routed: true,
              model,
              baseline,
              session: sessionOf(body) || key,
              reason: state.reason ?? null,
              turn: Boolean(fresh),
              direction: fresh ? directionOf(rankOf, tier, tierOf(baseline)) : null,
              deciderMs: fresh?.ms ?? null,
            };
          }
          out = Buffer.from(JSON.stringify(body));
        } catch (err) {
          debug(`passthrough, could not process body: ${err.message}`);
        }
      }

      const target = new URL(upstreamURL);
      const transport = target.protocol === "http:" ? http : https;
      const headers = { ...req.headers, host: target.host };
      delete headers["content-length"];
      if (req.method === "GET" && /^\/v1\/models(?:\?|$)/.test(req.url ?? "")) {
        delete headers["accept-encoding"];
      }
      // Under STRANDS_DEBUG, ask for an uncompressed stream so the model the API reports can be
      // read back out of it. Not worth the bandwidth cost in normal operation.
      if (process.env.STRANDS_DEBUG) delete headers["accept-encoding"];
      // Usage is read from the response as it streams past, which needs it uncompressed.
      // Message bodies are mostly small SSE frames, so the bandwidth cost is slight.
      if (!isBilled(req.method, req.url)) tracking = null;
      if (tracking) delete headers["accept-encoding"];
      const upstream = transport.request(
        {
          hostname: target.hostname,
          port: target.port || undefined,
          path: `${target.pathname.replace(/\/$/, "")}${req.url}`,
          method: req.method,
          headers,
        },
        (up) => {
          const isModels = req.method === "GET" && /^\/v1\/models(?:\?|$)/.test(req.url ?? "");
          if (isModels) {
            const chunks = [];
            up.on("data", (chunk) => chunks.push(chunk));
            up.on("end", () => {
              const data = Buffer.concat(chunks);
              try {
                for (const model of JSON.parse(data.toString()).data ?? []) {
                  if (tierOf(model?.id)) catalog.set(model.id, model);
                }
              } catch (err) {
                debug(`could not read Claude model catalog: ${err.message}`);
              }
              const headers = { ...up.headers };
              delete headers["content-length"];
              res.writeHead(up.statusCode, headers);
              res.end(data);
            });
            return;
          }
          res.writeHead(up.statusCode, up.headers);
          const encoding = up.headers["content-encoding"];
          if (
            tracking &&
            up.statusCode >= 200 &&
            up.statusCode < 300 &&
            (!encoding || encoding === "identity")
          ) {
            const tracker = trackResponse({ cli: "claude", provider: "anthropic", record, ...tracking });
            up.on("data", (chunk) => tracker.write(chunk));
            up.on("end", () => tracker.end());
            up.on("aborted", () => tracker.end());
          }
          // Report the model the API itself says it used, so the routing can be confirmed
          // from the wire rather than trusted from our own decision log. Claude Code's UI
          // always shows the model it asked for, never the one we rewrote to.
          if (process.env.STRANDS_DEBUG) {
            let seen = false;
            up.on("data", (c) => {
              if (seen) return;
              const m = /"model"\s*:\s*"([^"]+)"/.exec(c.toString("utf8"));
              if (!m) return;
              seen = true;
              debug(`${up.statusCode} served by ${m[1]}`);
            });
          }
          up.pipe(res);
        },
      );
      upstream.on("error", (e) => {
        debug(`upstream error: ${e.message}`);
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { message: e.message } }));
      });
      if (out.length) upstream.write(out);
      upstream.end();
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => server.close() };
}
