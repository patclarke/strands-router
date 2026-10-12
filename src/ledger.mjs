// The savings ledger: one JSON line per billed model response, appended as responses finish.
// It never contains prompt or response text, only model ids, token counts and dollars, so it
// is safe to keep indefinitely and to share when quantifying what routing is worth.
import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const dataDir = () => process.env.STRANDS_HOME ?? join(homedir(), ".strands-router");
export const ledgerFile = () => join(dataDir(), "usage.jsonl");

/** Appends one entry. Failures are swallowed: accounting must never break a session. */
export function appendEntry(entry, file = ledgerFile()) {
  try {
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    return true;
  } catch {
    return false;
  }
}

/** Every entry in the ledger, skipping any line a crash left half-written. */
export function readEntries(file = ledgerFile()) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Truncated line from an interrupted write; ignore it.
    }
  }
  return entries;
}

const emptyTotals = () => ({
  requests: 0,
  routedRequests: 0,
  turns: 0,
  downgradedTurns: 0,
  upgradedTurns: 0,
  unpriced: 0,
  tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 },
  cost: 0,
  baselineCost: 0,
  saved: 0,
});

function add(totals, entry) {
  totals.requests++;
  if (entry.routed) totals.routedRequests++;
  if (entry.turn) {
    totals.turns++;
    if (entry.direction === "down") totals.downgradedTurns++;
    if (entry.direction === "up") totals.upgradedTurns++;
  }
  const u = entry.usage ?? {};
  totals.tokens.input += u.input ?? 0;
  totals.tokens.cacheWrite += (u.cacheWrite5m ?? 0) + (u.cacheWrite1h ?? 0);
  totals.tokens.cacheRead += u.cacheRead ?? 0;
  totals.tokens.output += u.output ?? 0;
  if (entry.cost == null || entry.baselineCost == null) {
    totals.unpriced++;
    return;
  }
  totals.cost += entry.cost;
  totals.baselineCost += entry.baselineCost;
  totals.saved += entry.baselineCost - entry.cost;
}

/**
 * Rolls entries up into overall totals plus breakdowns by served model, by CLI and by day.
 * `saved` is baseline cost minus actual cost, so a turn routed *up* counts against it: the
 * figure is the net value of routing, not just the wins.
 */
export function summarize(entries, { since = 0, session } = {}) {
  const totals = emptyTotals();
  const byModel = {};
  const byDay = {};
  const byCli = {};
  for (const entry of entries) {
    if ((entry.ts ?? 0) < since) continue;
    if (session && entry.session !== session) continue;
    add(totals, entry);
    add((byModel[entry.model ?? "unknown"] ??= emptyTotals()), entry);
    add((byCli[entry.cli ?? "unknown"] ??= emptyTotals()), entry);
    const day = new Date(entry.ts ?? 0).toISOString().slice(0, 10);
    add((byDay[day] ??= emptyTotals()), entry);
  }
  totals.savedPercent = totals.baselineCost > 0 ? (totals.saved / totals.baselineCost) * 100 : 0;
  return { totals, byModel, byDay, byCli };
}
