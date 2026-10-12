import {
  COMPLEXITY_MAX_SCORE,
  CONTEXT_WINDOW_TOKENS,
  QUESTIONS,
  askMetrics,
  compactQuestion,
  questionForModels,
  questionStyle,
  tierOfCompactLabel,
  THRESHOLDS,
  deciderURL,
} from "./config.mjs";
import { log } from "./log.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * POSTs one System One request to the local Strands Decider server. Each attempt has its own
 * timeout, and `signal` is the outer deadline for the whole call, so a cold model load can't
 * hold a prompt hostage. No API key: the server is on loopback and only this user can reach it.
 */
export async function systemOne(request, { signal, url = deciderURL(), fetchImpl = fetch } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= THRESHOLDS.deciderMaxRetries; attempt++) {
    if (attempt) await sleep(150);
    const perAttempt = AbortSignal.timeout(THRESHOLDS.deciderTimeoutMs);
    try {
      const res = await fetchImpl(`${url}/v1/systemone`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: signal ? AbortSignal.any([signal, perAttempt]) : perAttempt,
      });
      if (!res.ok) {
        // 422 is a malformed question, which a retry will not fix.
        const detail = (await res.text().catch(() => "")).slice(0, 300);
        const err = new Error(`decider HTTP ${res.status}: ${detail}`);
        if (res.status < 500) throw Object.assign(err, { fatal: true });
        throw err;
      }
      return await res.json();
    } catch (err) {
      lastError = err;
      if (err.fatal || signal?.aborted) break;
    }
  }
  throw lastError;
}

/** Whether the Decider server is up, for a friendly warning at launch. */
export async function deciderHealth({ url = deciderURL(), timeoutMs = 1500, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`${url}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * The first request after the server starts pays for kernel compilation and cache warm-up
 * (noticeably so on Apple silicon), so one throwaway question is sent at launch rather than
 * charging that latency to the user's first prompt.
 */
export function warmUp({ url = deciderURL(), fetchImpl = fetch } = {}) {
  return fetchImpl(`${url}/v1/systemone`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      state: "warm up",
      questions: { ready: { type: "noul", instructions: "Is this a greeting?" } },
    }),
    signal: AbortSignal.timeout(30000),
  }).catch(() => null);
}

/**
 * The System One request for one routing decision. `compact` asks a short tier question over
 * the bare prompt; `detailed` is jev-router's question over every exact model, with session
 * context in the state. The complexity scores are added only when `metrics` is set.
 */
export function buildRequest({
  prompt,
  current,
  contextTokens,
  models,
  style = questionStyle(),
  metrics = askMetrics(),
}) {
  const extra = metrics ? QUESTIONS : {};
  if (style === "compact") {
    const tiers = [...new Set(models.map((model) => model.tier))];
    return { state: prompt, questions: { ...extra, model: compactQuestion(tiers) } };
  }
  return {
    state: {
      request: prompt,
      session: { current_model: current, context_tokens: contextTokens },
      environment: { available_models: models.map((model) => model.id) },
    },
    questions: { ...extra, model: questionForModels(models) },
  };
}

/**
 * Maps a compact answer ("fast") onto the newest model of that tier, so callers always get an
 * exact model id, as they do from the detailed question.
 */
function resolveAnswer(answer, models) {
  const tier = tierOfCompactLabel(answer.choice);
  if (!tier) return answer;
  const idFor = (label) => models.find((model) => model.tier === tierOfCompactLabel(label))?.id;
  const probabilities = {};
  for (const [label, p] of Object.entries(answer.probabilities ?? {})) {
    const id = idFor(label);
    if (id) probabilities[id] = p;
  }
  return { ...answer, choice: idFor(answer.choice) ?? null, probabilities };
}

const scaled = (answer) =>
  answer && Number.isFinite(answer.score) ? answer.score / COMPLEXITY_MAX_SCORE : null;

/**
 * Asks Strands Decider which model fits this prompt. Returns null on any failure, which the
 * policy layer reads as "keep the current model" — routing must never block a prompt.
 *
 * @returns {Promise<?{choice: string, confidence: number, probabilities: object, metrics: object, ms: number}>}
 */
export async function askDecider({ prompt, current, contextTokens, models, send = systemOne, ...options }) {
  if (!models?.length) return null;
  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), THRESHOLDS.deciderDeadlineMs);
  const request = buildRequest({ prompt, current, contextTokens, models, ...options });
  try {
    const result = await send(request, { signal: abort.signal });
    const { model: answer, task_complexity, reasoning_required, tool_complexity } = result.answers;
    return {
      ...resolveAnswer(answer, models),
      request,
      response: result,
      metrics: {
        taskComplexity: scaled(task_complexity),
        reasoningRequired: scaled(reasoning_required),
        toolComplexity: scaled(tool_complexity),
        contextSize: Math.min(contextTokens / CONTEXT_WINDOW_TOKENS, 1),
      },
      ms: Date.now() - started,
    };
  } catch (err) {
    log(`routing failed, keeping ${current}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(deadline);
  }
}
