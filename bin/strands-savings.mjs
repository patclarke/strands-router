#!/usr/bin/env node
// Reports what routing has cost and saved, from the ledger the proxies write.
//
//   strands-savings                 all time
//   strands-savings --since 7d      last 7 days (also: 24h, 30d, today, all)
//   strands-savings --session ID    one CLI session
//   strands-savings --json          machine-readable totals and breakdowns
import { readEntries, summarize, ledgerFile } from "../src/ledger.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? "") : undefined;
};

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    "usage: strands-savings [--since 24h|7d|30d|today|all] [--session ID] [--json]\n" +
      `ledger: ${ledgerFile()}\n`,
  );
  process.exit(0);
}

function parseSince(value, now = Date.now()) {
  if (!value || value === "all") return 0;
  if (value === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }
  const m = /^(\d+)\s*([hdw])$/i.exec(value);
  if (!m) throw new Error(`--since expects e.g. 24h, 7d, 4w, today or all, not "${value}"`);
  const unit = { h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2].toLowerCase()];
  return now - Number(m[1]) * unit;
}

let since;
try {
  since = parseSince(flag("--since"));
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(2);
}

const entries = readEntries();
const report = summarize(entries, { since, session: flag("--session") });

if (args.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(0);
}

const usd = (v) => `${v < 0 ? "-" : ""}$${Math.abs(v).toFixed(Math.abs(v) < 10 ? 4 : 2)}`;
const tok = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : `${v}`);
const pad = (s, w) => String(s).padEnd(w);
const lpad = (s, w) => String(s).padStart(w);
const { totals, byModel, byDay, byCli } = report;

if (!totals.requests) {
  process.stdout.write(
    `No usage recorded${since ? " in that window" : ""} yet.\n` +
      `Run strands-claude or strands-codex; each billed response is appended to\n  ${ledgerFile()}\n`,
  );
  process.exit(0);
}

const lines = [
  "Strands Router savings",
  "",
  `  Without routing (baseline)  ${lpad(usd(totals.baselineCost), 12)}`,
  `  With routing (actual)       ${lpad(usd(totals.cost), 12)}`,
  `  Saved                       ${lpad(usd(totals.saved), 12)}  (${totals.savedPercent.toFixed(1)}%)`,
  "",
  `  ${totals.turns} routed turns: ${totals.downgradedTurns} to a cheaper model, ` +
    `${totals.upgradedTurns} to a pricier one, ${totals.turns - totals.downgradedTurns - totals.upgradedTurns} unchanged`,
  `  ${totals.requests} billed responses (${totals.routedRequests} routed), tokens: ` +
    `${tok(totals.tokens.input)} in, ${tok(totals.tokens.cacheWrite)} cache write, ` +
    `${tok(totals.tokens.cacheRead)} cache read, ${tok(totals.tokens.output)} out`,
];
if (totals.unpriced) {
  lines.push(`  ${totals.unpriced} responses had no known price and are excluded (add them to pricing.json)`);
}

lines.push("", `  ${pad("Served by", 30)}${lpad("Responses", 10)}${lpad("Actual", 12)}${lpad("Baseline", 12)}${lpad("Saved", 12)}`);
for (const [model, t] of Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost)) {
  lines.push(`  ${pad(model, 30)}${lpad(t.requests, 10)}${lpad(usd(t.cost), 12)}${lpad(usd(t.baselineCost), 12)}${lpad(usd(t.saved), 12)}`);
}

if (Object.keys(byCli).length > 1) {
  lines.push("", `  ${pad("CLI", 30)}${lpad("Responses", 10)}${lpad("Actual", 12)}${lpad("Baseline", 12)}${lpad("Saved", 12)}`);
  for (const [cli, t] of Object.entries(byCli)) {
    lines.push(`  ${pad(cli, 30)}${lpad(t.requests, 10)}${lpad(usd(t.cost), 12)}${lpad(usd(t.baselineCost), 12)}${lpad(usd(t.saved), 12)}`);
  }
}

const days = Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).slice(-14);
if (days.length > 1) {
  lines.push("", `  ${pad("Day (UTC)", 30)}${lpad("Responses", 10)}${lpad("Actual", 12)}${lpad("Baseline", 12)}${lpad("Saved", 12)}`);
  for (const [day, t] of days) {
    lines.push(`  ${pad(day, 30)}${lpad(t.requests, 10)}${lpad(usd(t.cost), 12)}${lpad(usd(t.baselineCost), 12)}${lpad(usd(t.saved), 12)}`);
  }
}

lines.push(
  "",
  "  Estimates at API list prices: the baseline re-prices the same tokens on the model the",
  "  session would have used. On a Claude or ChatGPT subscription this is API-equivalent value.",
);
process.stdout.write(`${lines.join("\n")}\n`);
