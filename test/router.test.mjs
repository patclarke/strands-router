import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { askDecider, deciderHealth, systemOne } from "../src/router.mjs";
import { questionForModels, describeOption } from "../src/config.mjs";

const MODELS = [
  { id: "claude-haiku-4-5", tier: "haiku", description: "Claude Haiku 4.5" },
  { id: "claude-sonnet-5-5", tier: "sonnet" },
  { id: "claude-opus-5-5", tier: "opus" },
];

/**
 * A stand-in for `strands-decider serve` that enforces the same request rules the real server's
 * pydantic schema does for the fields we send (strands_decider/schema.py), and answers in its
 * response shape.
 */
async function fakeDecider(t, { status = 200, onRequest } = {}) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      calls++;
      if (req.url === "/health") {
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ status: "ok", model: "strands-decider-2B-hobson-v19" }));
      }
      const body = JSON.parse(Buffer.concat(chunks));
      onRequest?.(body);
      const problems = [];
      for (const [name, q] of Object.entries(body.questions)) {
        if (q.type === "choice") {
          const values = Object.values(q.criteria);
          if (values.length < 2) problems.push(`${name}: choice needs 2+ options`);
          if (values.some((v) => typeof v !== "string")) problems.push(`${name}: criteria must be strings`);
        }
        if (q.type === "score" && !(q.criteria.length >= 2 && q.criteria.length <= 10)) {
          problems.push(`${name}: score needs 2-10 levels`);
        }
      }
      res.setHeader("content-type", "application/json");
      if (status !== 200 || problems.length) {
        res.statusCode = problems.length ? 422 : status;
        return res.end(JSON.stringify({ detail: problems }));
      }
      const score = (s) => ({ type: "score", score: s, legend: {}, probabilities: {}, confidence: 0.8 });
      res.end(
        JSON.stringify({
          model: "strands-decider-2B-hobson-v19",
          answers: {
            task_complexity: score(1.8),
            reasoning_required: score(0.9),
            tool_complexity: score(2.7),
            model: {
              type: "choice",
              choice: "claude-haiku-4-5",
              probabilities: { "claude-haiku-4-5": 0.8, "claude-sonnet-5-5": 0.15, "claude-opus-5-5": 0.05 },
              confidence: 0.7,
            },
          },
          usage: { input_tokens: 400, output_tokens: 4 },
          latency_ms: 180.5,
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, calls: () => calls };
}

test("choice options are flattened to the strings Decider requires", () => {
  const q = questionForModels(MODELS);
  assert.equal(q.type, "choice");
  for (const value of Object.values(q.criteria)) assert.equal(typeof value, "string");
  assert.match(q.criteria["claude-haiku-4-5"], /^model: Claude Haiku 4\.5\. what: Trivial/);
  assert.doesNotMatch(q.criteria["claude-haiku-4-5"], /\.\./, "no doubled full stops");
  assert.equal(describeOption("already a string"), "already a string");
});

test("asks the local Decider and maps its answer onto a routing choice", async (t) => {
  const decider = await fakeDecider(t);
  const answer = await askDecider({
    prompt: "fix the typo",
    current: "claude-opus-5-5",
    contextTokens: 1000,
    models: MODELS,
    send: (request, options) => systemOne(request, { ...options, url: decider.url }),
  });
  assert.equal(answer.choice, "claude-haiku-4-5");
  assert.equal(answer.confidence, 0.7);
  assert.equal(answer.metrics.taskComplexity, 0.2);
  assert.equal(answer.response.model, "strands-decider-2B-hobson-v19");
});

test("a rejected request is not retried; a server error is retried once", async (t) => {
  const bad = await fakeDecider(t);
  await assert.rejects(
    systemOne({ state: "x", questions: { q: { type: "choice", instructions: "?", criteria: { a: {}, b: {} } } } }, { url: bad.url }),
    /HTTP 422/,
  );
  assert.equal(bad.calls(), 1);

  const flaky = await fakeDecider(t, { status: 503 });
  await assert.rejects(systemOne({ state: "x", questions: {} }, { url: flaky.url }), /HTTP 503/);
  assert.equal(flaky.calls(), 2);
});

test("routing fails open when no Decider is listening", async () => {
  const answer = await askDecider({
    prompt: "anything",
    current: "claude-opus-5-5",
    contextTokens: 0,
    models: MODELS,
    send: (request, options) => systemOne(request, { ...options, url: "http://127.0.0.1:9" }),
  });
  assert.equal(answer, null);
  assert.equal(await deciderHealth({ url: "http://127.0.0.1:9" }), null);
});

test("health reports the served checkpoint", async (t) => {
  const decider = await fakeDecider(t);
  assert.equal((await deciderHealth({ url: decider.url })).model, "strands-decider-2B-hobson-v19");
});
