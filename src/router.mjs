import {
  COMPLEXITY_MAX_SCORE,
  CONTEXT_WINDOW_TOKENS,
  QUESTIONS,
  questionForModels,
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
 * Asks Strands Decider which model fits this prompt. Returns null on any failure, which the
 * policy layer reads as "keep the current model" — routing must never block a prompt.
 *
 * @returns {Promise<?{choice: string, confidence: number, probabilities: object, metrics: object, ms: number}>}
 */
export async function askDecider({ prompt, current, contextTokens, models, send = systemOne }) {
  if (!models?.length) return null;
  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), THRESHOLDS.deciderDeadlineMs);
  const request = {
    state: {
      request: prompt,
      session: { current_model: current, context_tokens: contextTokens },
      environment: { available_models: models.map((model) => model.id) },
    },
    questions: { ...QUESTIONS, model: questionForModels(models) },
  };
  try {
    const result = await send(request, { signal: abort.signal });
    const { model: answer, task_complexity, reasoning_required, tool_complexity } = result.answers;
    return {
      ...answer,
      request,
      response: result,
      metrics: {
        taskComplexity: task_complexity.score / COMPLEXITY_MAX_SCORE,
        reasoningRequired: reasoning_required.score / COMPLEXITY_MAX_SCORE,
        toolComplexity: tool_complexity.score / COMPLEXITY_MAX_SCORE,
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
