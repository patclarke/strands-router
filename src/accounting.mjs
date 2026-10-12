// Prices each billed response twice — as the model that actually served it, and as the
// baseline model the session would have used without routing — and records the difference.
import { costOf } from "./pricing.mjs";
import { usageReader } from "./usage.mjs";
import { appendEntry } from "./ledger.mjs";
import { readSavings, writeSavings } from "./status.mjs";
import { debug } from "./log.mjs";

/**
 * The model a session would have run without the router. STRANDS_BASELINE_MODEL wins (an exact
 * id, or a tier name such as `opus`); then the user's own saved default; then the strong tier,
 * which is what both CLIs start a routed session on.
 *
 * @param {(tier: string) => string} modelForTier  resolves a tier to this account's model id
 * @param {(model: string) => ?string} tierOf       recognises a tier from a model id
 */
export function resolveBaseline({ configured, saved, modelForTier, tierOf, tiers }) {
  for (const candidate of [process.env.STRANDS_BASELINE_MODEL, configured, saved]) {
    if (!candidate) continue;
    if (tiers.includes(candidate)) return modelForTier(candidate);
    // Aliases such as "opus[1m]" or "sonnet" name a tier, not a model we can price.
    if (/\d/.test(candidate.replace(/\[.*\]$/, ""))) return candidate;
    const tier = tierOf(candidate);
    if (tier) return modelForTier(tier);
  }
  return modelForTier("opus");
}

/**
 * Starts accounting for one upstream response. Returns an observer the proxy feeds response
 * chunks to (`write`) and closes (`end`); on close the usage is priced and appended to the
 * ledger, and the session's running totals are refreshed for the status line.
 */
export function trackResponse({
  cli,
  provider,
  session,
  routed,
  model,
  baseline,
  reason = null,
  turn = false,
  direction = null,
  deciderMs = null,
  record = appendEntry,
}) {
  const reader = usageReader(provider);
  let ended = false;
  return {
    write: (chunk) => reader.write(chunk),
    end() {
      if (ended) return null;
      ended = true;
      const result = reader.result();
      if (!result) return null;
      const served = result.model ?? model;
      const cost = costOf(served, result.usage);
      // A request the user (or the CLI itself) chose a model for was never routed, so routing
      // neither saved nor cost anything on it.
      const baselineModel = routed ? baseline : served;
      const baselineCost = routed ? costOf(baselineModel, result.usage) : cost;
      const entry = {
        ts: Date.now(),
        cli,
        session: session || null,
        routed,
        turn,
        direction,
        reason,
        model: served,
        baseline: baselineModel,
        usage: result.usage,
        cost,
        baselineCost,
        ...(deciderMs != null ? { deciderMs } : {}),
      };
      record(entry);
      if (session && cost != null && baselineCost != null) {
        const totals = readSavings(session) ?? { cost: 0, baselineCost: 0, requests: 0 };
        totals.cost += cost;
        totals.baselineCost += baselineCost;
        totals.requests++;
        writeSavings(session, totals);
      }
      debug(
        `usage ${served} in=${result.usage.input} cw=${result.usage.cacheWrite5m + result.usage.cacheWrite1h} ` +
          `cr=${result.usage.cacheRead} out=${result.usage.output} ` +
          `$${cost?.toFixed(4) ?? "?"} vs ${baselineModel} $${baselineCost?.toFixed(4) ?? "?"}`,
      );
      return entry;
    },
  };
}

/** Whether a routed turn went to a cheaper or pricier model than the baseline, by tier rank. */
export function directionOf(rankOf, tier, baselineTier) {
  if (tier == null || baselineTier == null) return null;
  const delta = rankOf(tier) - rankOf(baselineTier);
  return delta < 0 ? "down" : delta > 0 ? "up" : "same";
}
