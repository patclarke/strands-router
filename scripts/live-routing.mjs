// Asks a running Strands Decider (`scripts/decider.sh serve`) to route a few sample prompts.
// Not part of `npm test`: it needs the real model. Usage: node scripts/live-routing.mjs
try {
  process.loadEnvFile();
} catch {
  // No .env; STRANDS_DECIDER_URL may still come from the real environment.
}
const { askDecider } = await import("../src/router.mjs");
const models = [
  { id: "claude-haiku-4-5", tier: "haiku", description: "Claude Haiku 4.5" },
  { id: "claude-sonnet-5-5", tier: "sonnet", description: "Claude Sonnet 5.5" },
  { id: "claude-opus-5-5", tier: "opus", description: "Claude Opus 5.5" },
];
const prompts = [
  "fix the typo 'recieve' in README.md",
  "add a unit test for the existing formatDate helper",
  "users intermittently get logged out after deploy, figure out why",
  "migrate the entire monorepo from webpack to vite",
];
for (const prompt of prompts) {
  const a = await askDecider({ prompt, current: "claude-opus-5-5", contextTokens: 0, models });
  if (!a) {
    console.log(`FAIL  ${prompt}`);
    continue;
  }
  const p = Object.entries(a.probabilities).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(" ");
  console.log(`${a.choice.padEnd(18)} conf=${a.confidence.toFixed(2)} ${String(a.ms).padStart(5)}ms | ${p} | ${prompt}`);
}
