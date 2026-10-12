// List prices used to turn token usage into dollars. Every figure is USD per million tokens at
// standard (non-batch) API rates. Review these when prices change, or override any of them in
// ~/.strands-router/pricing.json without touching the code (see README).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "./ledger.mjs";

/**
 * Anthropic first-party API rates. Cache writes are 1.25x input for the 5-minute TTL and 2x for
 * the 1-hour TTL on every model; cache reads vary by model, so they are listed explicitly.
 * `longContext` covers models whose rates step up past a prompt size.
 */
const CLAUDE = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1.0 },
  "claude-mythos-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    longContext: { above: 100000, input: 0.5, output: 2.5, cacheRead: 0.05 },
  },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

/**
 * OpenAI rates for the Codex tiers, as community-reported for October 2026 (sources disagree
 * on gpt-5.6-sol; the lower published figure is used). gpt-6-astra is left out because no
 * reliable figure was found: add it to pricing.json if you enable the long tier.
 */
const OPENAI = {
  "gpt-5.6-sol": { input: 4, output: 20, cacheRead: 0.4 },
  "gpt-5.6-terra": { input: 2, output: 12, cacheRead: 0.2 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02 },
};

export const DEFAULT_PRICES = { ...CLAUDE, ...OPENAI };

/** Claude Opus fast mode (`usage.speed: "fast"`) bills every token class at 2x. */
const FAST_MULTIPLIER = 2;

let overrides;
function loadOverrides() {
  if (overrides !== undefined) return overrides;
  try {
    overrides = JSON.parse(readFileSync(join(dataDir(), "pricing.json"), "utf8"));
  } catch {
    overrides = {};
  }
  return overrides;
}

/**
 * Price entry for a model id. Matches the longest known id the model starts with, so dated
 * snapshots (`claude-haiku-4-5-20251001`) and context suffixes (`claude-opus-5-5[1m]`) resolve
 * to their family's rates. Returns null for a model we cannot price.
 */
export function priceFor(model, prices = { ...DEFAULT_PRICES, ...loadOverrides() }) {
  if (typeof model !== "string") return null;
  const id = model.toLowerCase().replace(/\[.*\]$/, "");
  const key = Object.keys(prices)
    .filter((k) => id === k || id.startsWith(`${k}-`) || id.startsWith(`${k}@`))
    .sort((a, b) => b.length - a.length)[0];
  return key ? { model: key, ...prices[key] } : null;
}

/**
 * Dollar cost of one response's usage when billed as `model`. Usage is the normalised shape
 * from usage.mjs: uncached input, 5m and 1h cache writes, cache reads, and output. Returns null
 * when the model has no price, so unknown models are reported rather than counted as free.
 */
export function costOf(model, usage, { prices } = {}) {
  const price = priceFor(model, prices);
  if (!price || !usage) return null;
  const promptTokens = usage.input + usage.cacheWrite5m + usage.cacheWrite1h + usage.cacheRead;
  const rate = price.longContext && promptTokens > price.longContext.above
    ? { ...price, ...price.longContext }
    : price;
  const cacheRead = rate.cacheRead ?? rate.input * 0.1;
  const dollars =
    (usage.input * rate.input +
      usage.cacheWrite5m * rate.input * 1.25 +
      usage.cacheWrite1h * rate.input * 2 +
      usage.cacheRead * cacheRead +
      usage.output * rate.output) /
    1e6;
  return usage.speed === "fast" ? dollars * FAST_MULTIPLIER : dollars;
}
