// Benchmarks routing against a running Strands Decider (`scripts/decider.sh serve`), through
// the router's own request code and policy. Each labelled prompt is routed with every question
// style; the summary shows how often each style picks the expected tier, how confident it is,
// what the policy would actually do starting from Opus, and how long a decision takes.
//
//   node scripts/live-routing.mjs            all styles
//   node scripts/live-routing.mjs compact    one style
try {
  process.loadEnvFile();
} catch {
  // No .env; STRANDS_DECIDER_URL may still come from the real environment.
}
// A benchmark should measure slow answers, not give up on them.
process.env.STRANDS_DECIDER_TIMEOUT_MS ??= "120000";
process.env.STRANDS_DECIDER_DEADLINE_MS ??= "120000";

const { askDecider } = await import("../src/router.mjs");
const { decide } = await import("../src/policy.mjs");
const { THRESHOLDS } = await import("../src/config.mjs");

const models = [
  { id: "claude-haiku-4-5", tier: "haiku", description: "Claude Haiku 4.5" },
  { id: "claude-sonnet-5-5", tier: "sonnet", description: "Claude Sonnet 5.5" },
  { id: "claude-opus-5-5", tier: "opus", description: "Claude Opus 5.5" },
];
const tierOf = (id) => models.find((m) => m.id === id)?.tier ?? "?";

const PROMPTS = [
  ["haiku", "fix the typo 'recieve' in README.md"],
  ["haiku", "rename the variable usr to user in src/auth.py"],
  ["haiku", "what does git rebase --onto do?"],
  ["sonnet", "add a unit test for the existing formatDate helper"],
  ["sonnet", "add pagination to the /users endpoint the same way /orders does it"],
  ["opus", "users intermittently get logged out after deploy, figure out why"],
  ["opus", "find the race condition that causes duplicate payments under load"],
  ["opus", "design a migration of auth from server sessions to JWT across all our services"],
];

const STYLES = {
  compact: { style: "compact", metrics: false },
  "compact+scores": { style: "compact", metrics: true },
  detailed: { style: "detailed", metrics: false },
  "detailed+scores": { style: "detailed", metrics: true },
};
const only = process.argv[2];
const styles = Object.entries(STYLES).filter(([name]) => !only || name === only);
if (!styles.length) throw new Error(`unknown style ${only}; one of ${Object.keys(STYLES).join(", ")}`);

// One untimed call first, so GPU warm-up doesn't land in the first style's numbers.
await askDecider({ prompt: "warm up", current: "claude-opus-5-5", contextTokens: 0, models, ...styles[0][1] });

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? NaN;
const summary = [];
for (const [name, options] of styles) {
  console.log(`\n== ${name}`);
  const rows = [];
  for (const [expected, prompt] of PROMPTS) {
    const a = await askDecider({ prompt, current: "claude-opus-5-5", contextTokens: 0, models, ...options });
    if (!a) {
      console.log(`  FAIL (no answer)      | ${prompt}`);
      rows.push({ failed: true });
      continue;
    }
    const picked = tierOf(a.choice);
    const final = decide({
      prompt,
      decider: { ...a, choice: picked },
      current: "opus",
      available: ["haiku", "sonnet", "opus"],
      contextTokens: 0,
    });
    rows.push({ ok: picked === expected, confidence: a.confidence, ms: a.ms, routed: final.tier, expected });
    console.log(
      `  ${picked === expected ? "ok  " : "MISS"} ${picked.padEnd(6)} conf=${a.confidence.toFixed(2)} ` +
        `${String(a.ms).padStart(6)}ms -> policy: ${final.tier.padEnd(6)} (${final.reason}) | ${prompt}`,
    );
  }
  const answered = rows.filter((r) => !r.failed);
  summary.push({
    name,
    correct: answered.filter((r) => r.ok).length,
    total: rows.length,
    failed: rows.length - answered.length,
    meanConf: answered.reduce((s, r) => s + r.confidence, 0) / (answered.length || 1),
    actedOn: answered.filter((r) => r.confidence >= THRESHOLDS.minConfidence).length,
    routedRight: answered.filter((r) => r.routed === r.expected).length,
    medianMs: median(answered.map((r) => r.ms)),
  });
}

console.log(`\n== summary (policy acts on confidence >= ${THRESHOLDS.minConfidence}; every prompt starts on opus)`);
console.log("  style              right  confident  routed-right  mean conf  median ms  failed");
for (const s of summary) {
  console.log(
    `  ${s.name.padEnd(18)} ${`${s.correct}/${s.total}`.padStart(5)}  ${`${s.actedOn}/${s.total}`.padStart(9)}` +
      `  ${`${s.routedRight}/${s.total}`.padStart(12)}  ${s.meanConf.toFixed(2).padStart(9)}  ${String(s.medianMs).padStart(9)}  ${String(s.failed).padStart(6)}`,
  );
}
