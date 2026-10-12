import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STRANDS_HOME = mkdtempSync(join(tmpdir(), "strands-savings-"));

const { priceFor, costOf } = await import("../src/pricing.mjs");
const { usageReader } = await import("../src/usage.mjs");
const { appendEntry, readEntries, summarize, ledgerFile } = await import("../src/ledger.mjs");
const { resolveBaseline, trackResponse } = await import("../src/accounting.mjs");
const { startProxy } = await import("../src/proxy.mjs");
const { startCodexProxy } = await import("../src/codex-proxy.mjs");
const { readSavings } = await import("../src/status.mjs");

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const usage = (over = {}) => ({ input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0, ...over });

test("prices resolve dated snapshots and context suffixes to their family", () => {
  assert.equal(priceFor("claude-haiku-4-5-20251001").model, "claude-haiku-4-5");
  assert.equal(priceFor("claude-opus-5-5[1m]").model, "claude-opus-5-5");
  assert.equal(priceFor("claude-opus-5").model, "claude-opus-5", "not swallowed by opus-5-5");
  assert.equal(priceFor("claude-opus-5-5").model, "claude-opus-5-5", "longest match wins");
  assert.equal(priceFor("gpt-5.6-luna").model, "gpt-5.6-luna");
  assert.equal(priceFor("mystery-model"), null);
  assert.equal(priceFor(undefined), null);
});

test("cost covers every token class at its own rate", () => {
  // Opus 5.5: $4 in, $20 out, $0.20 cache read; writes 1.25x / 2x input.
  close(costOf("claude-opus-5-5", usage({ input: 1e6 })), 4);
  close(costOf("claude-opus-5-5", usage({ output: 1e6 })), 20);
  close(costOf("claude-opus-5-5", usage({ cacheRead: 1e6 })), 0.2);
  close(costOf("claude-opus-5-5", usage({ cacheWrite5m: 1e6 })), 5);
  close(costOf("claude-opus-5-5", usage({ cacheWrite1h: 1e6 })), 8);
  close(costOf("claude-opus-5-5", usage({ output: 1e6, speed: "fast" })), 40, 1e-9);
  assert.equal(costOf("mystery-model", usage({ input: 1 })), null, "unknown is not free");
});

test("Haiku 5.5 switches to its long-context rate past 100K prompt tokens", () => {
  close(costOf("claude-haiku-5-5", usage({ input: 100000 })), 0.01);
  close(costOf("claude-haiku-5-5", usage({ input: 200000 })), 0.1);
});

test("reads Anthropic streaming usage across awkward chunk boundaries", () => {
  const sse = [
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-4-5-20251001",',
    '"usage":{"input_tokens":12,"cache_creation_input_tokens":300,"cache_read_input_tokens":4000,',
    '"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":200},"output_tokens":1}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":250}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");
  const reader = usageReader("anthropic");
  for (let i = 0; i < sse.length; i += 7) reader.write(Buffer.from(sse.slice(i, i + 7)));
  assert.deepEqual(reader.result(), {
    model: "claude-haiku-4-5-20251001",
    usage: { input: 12, cacheWrite5m: 100, cacheWrite1h: 200, cacheRead: 4000, output: 250 },
  });
});

test("reads a non-streaming Anthropic body, and an OpenAI stream", () => {
  const plain = usageReader("anthropic");
  plain.write('{"model":"claude-sonnet-5","usage":{"input_tokens":5,"cache_creation_input_tokens":40,"output_tokens":9}}');
  assert.deepEqual(plain.result().usage, { input: 5, cacheWrite5m: 40, cacheWrite1h: 0, cacheRead: 0, output: 9 });

  const openai = usageReader("openai");
  openai.write('event: response.created\ndata: {"type":"response.created"}\n\n');
  openai.write(
    'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-5.6-luna",' +
      '"usage":{"input_tokens":1000,"input_tokens_details":{"cached_tokens":800},"output_tokens":50}}}\n\n',
  );
  assert.deepEqual(openai.result(), {
    model: "gpt-5.6-luna",
    usage: { input: 200, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 800, output: 50 },
  });

  const error = usageReader("anthropic");
  error.write('{"type":"error","error":{"message":"overloaded"}}');
  assert.equal(error.result(), null, "an error body records nothing");
});

test("summaries net out upgrades and report unpriced entries instead of guessing", () => {
  const entries = [
    { ts: 1000, cli: "claude", session: "a", routed: true, turn: true, direction: "down", model: "m1", usage: usage({ input: 10 }), cost: 1, baselineCost: 5 },
    { ts: 2000, cli: "claude", session: "a", routed: true, turn: true, direction: "up", model: "m2", usage: usage({ output: 5 }), cost: 6, baselineCost: 5 },
    { ts: 3000, cli: "codex", session: "b", routed: false, model: "m3", usage: usage(), cost: 2, baselineCost: 2 },
    { ts: 4000, cli: "codex", session: "b", routed: true, model: "??", usage: usage(), cost: null, baselineCost: null },
  ];
  const { totals, byModel, byCli } = summarize(entries);
  assert.equal(totals.requests, 4);
  assert.equal(totals.turns, 2);
  assert.equal(totals.downgradedTurns, 1);
  assert.equal(totals.upgradedTurns, 1);
  assert.equal(totals.unpriced, 1);
  close(totals.cost, 9);
  close(totals.baselineCost, 12);
  close(totals.saved, 3);
  close(totals.savedPercent, 25);
  close(byModel.m2.saved, -1);
  assert.equal(byCli.codex.requests, 2);
  assert.equal(summarize(entries, { since: 2500 }).totals.requests, 2);
  assert.equal(summarize(entries, { session: "a" }).totals.requests, 2);
});

test("the ledger is private and survives a half-written line", () => {
  const file = join(process.env.STRANDS_HOME, "ledger-test.jsonl");
  appendEntry({ ts: 1, cost: 1 }, file);
  appendEntry({ ts: 2, cost: 2 }, file);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
  appendFileSync(file, '{"ts":3,"co');
  assert.deepEqual(readEntries(file).map((e) => e.ts), [1, 2]);
});

test("baseline prefers the env override, then the saved default, then the strong tier", () => {
  const tiers = ["haiku", "sonnet", "opus", "fable"];
  const modelForTier = (t) => `claude-${t}-x-9`;
  const tierOf = (m) => tiers.find((t) => m.includes(t)) ?? null;
  const resolve = (saved) => resolveBaseline({ saved, modelForTier, tierOf, tiers });
  assert.equal(resolve(undefined), "claude-opus-x-9");
  assert.equal(resolve("sonnet"), "claude-sonnet-x-9", "an alias names a tier");
  assert.equal(resolve("opus[1m]"), "claude-opus-x-9", "a context suffix is not a version");
  assert.equal(resolve("claude-sonnet-4-6"), "claude-sonnet-4-6", "an exact id is kept");
  assert.equal(resolve("default"), "claude-opus-x-9");
  process.env.STRANDS_BASELINE_MODEL = "haiku";
  try {
    assert.equal(resolve("claude-sonnet-4-6"), "claude-haiku-x-9");
  } finally {
    delete process.env.STRANDS_BASELINE_MODEL;
  }
});

test("a passthrough response is recorded with no savings either way", () => {
  const recorded = [];
  const tracker = trackResponse({
    cli: "claude",
    provider: "anthropic",
    session: "",
    routed: false,
    model: "claude-haiku-4-5",
    baseline: "claude-opus-5-5",
    record: (e) => recorded.push(e),
  });
  tracker.write('{"model":"claude-haiku-4-5","usage":{"input_tokens":1000,"output_tokens":100}}');
  tracker.end();
  tracker.end();
  assert.equal(recorded.length, 1, "end is idempotent");
  assert.equal(recorded[0].baseline, "claude-haiku-4-5");
  assert.equal(recorded[0].cost, recorded[0].baselineCost);
});

const listen = async (t, handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
};

const sseOf = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

test("Claude proxy records a routed turn's cost against the Opus baseline", async (t) => {
  let acceptEncoding;
  const upstreamURL = await listen(t, (req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url.startsWith("/v1/models")) {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ data: [{ id: "claude-haiku-4-5" }, { id: "claude-opus-5-5" }] }));
      }
      acceptEncoding = req.headers["accept-encoding"];
      res.setHeader("content-type", "text/event-stream");
      res.write(sseOf([{ type: "message_start", message: { model: "claude-haiku-4-5", usage: { input_tokens: 2000, output_tokens: 1 } } }]));
      res.end(sseOf([{ type: "message_delta", usage: { output_tokens: 500 } }, { type: "message_stop" }]));
    });
  });
  const recorded = [];
  let resolveRecord;
  const done = new Promise((resolve) => (resolveRecord = resolve));
  const proxy = await startProxy({
    upstreamURL,
    route: async () => ({ choice: "claude-haiku-4-5", confidence: 0.95, ms: 42 }),
    record: (entry) => {
      recorded.push(entry);
      resolveRecord();
    },
  });
  t.after(proxy.close);

  await fetch(`http://127.0.0.1:${proxy.port}/v1/models`).then((r) => r.json());
  const sid = `savings-${randomUUID()}`; // unique: per-session totals persist across runs in the temp dir
  const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "accept-encoding": "gzip, br" },
    body: JSON.stringify({
      model: "strands-router",
      metadata: { user_id: JSON.stringify({ session_id: sid }) },
      tools: [{ name: "Bash" }],
      messages: [{ role: "user", content: "fix the typo in README" }],
    }),
  });
  assert.match(await res.text(), /message_stop/, "the stream still reaches the CLI intact");
  await done;

  assert.equal(acceptEncoding, undefined, "usage needs an uncompressed stream");
  const [entry] = recorded;
  assert.equal(entry.model, "claude-haiku-4-5");
  assert.equal(entry.baseline, "claude-opus-5-5");
  assert.equal(entry.routed, true);
  assert.equal(entry.turn, true);
  assert.equal(entry.direction, "down");
  assert.equal(entry.deciderMs, 42);
  // Haiku 4.5: 2000 * $1 + 500 * $5 per MTok; Opus 5.5: 2000 * $4 + 500 * $20.
  close(entry.cost, 0.0045);
  close(entry.baselineCost, 0.018);
  const session = readSavings(sid);
  close(session.baselineCost - session.cost, 0.0135);
});

test("Codex proxy records the Responses API usage of a routed turn", async (t) => {
  const upstreamURL = await listen(t, (req, res) => {
    req.resume();
    req.on("end", () => {
      res.setHeader("content-type", "text/event-stream");
      res.end(
        sseOf([
          { type: "response.created" },
          {
            type: "response.completed",
            response: { model: "gpt-5.6-luna", usage: { input_tokens: 10000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1000 } },
          },
        ]),
      );
    });
  });
  const recorded = [];
  let resolveRecord;
  const done = new Promise((resolve) => (resolveRecord = resolve));
  const proxy = await startCodexProxy({
    chatgptBaseURL: upstreamURL,
    apiBaseURL: upstreamURL,
    statusId: `codex-test-${process.pid}`,
    route: async ({ models }) => ({ choice: models.find((m) => m.tier === "haiku").id, confidence: 0.9, ms: 7 }),
    record: (entry) => {
      recorded.push(entry);
      resolveRecord();
    },
  });
  t.after(proxy.close);

  const res = await fetch(`http://127.0.0.1:${proxy.port}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "strands-router",
      input: [{ type: "additional_tools" }, { role: "user", content: [{ type: "input_text", text: "rename foo to bar" }] }],
    }),
  });
  await res.text();
  await done;
  const [entry] = recorded;
  assert.equal(entry.cli, "codex");
  assert.equal(entry.model, "gpt-5.6-luna");
  assert.equal(entry.baseline, "gpt-5.6-sol");
  // Luna: 10000 * $0.20 + 1000 * $1.20; Sol: 10000 * $4 + 1000 * $20 (per MTok).
  close(entry.cost, 0.0032);
  close(entry.baselineCost, 0.06);
});

test("the default ledger lives under STRANDS_HOME", () => {
  assert.equal(ledgerFile(), join(process.env.STRANDS_HOME, "usage.jsonl"));
});
