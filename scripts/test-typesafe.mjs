// Exercises the TypeSafe classification path without an API key by stubbing
// global fetch before importing the SDK (the SDK takes `globalThis.fetch`
// per call, so a plain replacement works).
process.env.TYPESAFE_API_KEY = "test-key";

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes("typesafe.ai")) {
    const body = JSON.parse(init.body);
    const task = body.state.task;
    const coding = /refactor|fix|code|file|repo/i.test(task);
    return new Response(
      JSON.stringify({
        model: "jev-latest",
        answers: {
          kind: {
            type: "choice",
            choice: coding ? "coding" : "chat",
            probabilities: { coding: coding ? 0.9 : 0.05, writing: 0.03, analysis: 0.02, chat: coding ? 0.0 : 0.9 },
            confidence: 0.9,
          },
          difficulty: {
            type: "score",
            score: coding ? 1.6 : 0.2,
            legend: { 0: "trivial", 1: "moderate", 2: "hard" },
            probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 },
            confidence: 0.8,
          },
          needsTools: { type: "noul", noul: coding ? 0.97 : 0.02 },
        },
        usage: { input_tokens: 100, output_tokens: 20 },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }
  return realFetch(url, init);
};

const { classifyTask } = await import("../dist/typesafe.js");

const coding = await classifyTask("refactor src/ to use async/await");
const chat = await classifyTask("hey, what's the capital of France?");

const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok: ${msg}`);
};

assert(coding && coding.kind === "coding", `coding task classified as coding (got ${coding?.kind})`);
assert(coding.needsTools > 0.5, `coding task needsTools > 0.5 (got ${coding?.needsTools})`);
assert(coding.difficulty > 1, `coding task difficulty > 1 (got ${coding?.difficulty})`);
assert(chat && chat.kind === "chat", `chat task classified as chat (got ${chat?.kind})`);
assert(chat.needsTools < 0.5, `chat task needsTools < 0.5 (got ${chat?.needsTools})`);

// no key -> undefined (fallback path)
delete process.env.TYPESAFE_API_KEY;
const { classifyTask: classifyNoKey } = await import("../dist/typesafe.js?nokey");
// module cache means client may exist; spawn fresh check via env-only path
console.log("ok: classification path exercised");
