import assert from "node:assert/strict";

process.env.TYPESAFE_API_KEY = "test-key";
process.env.HARMONY_CONFIG_DIR = "/tmp/harmony-optional-typesafe-test";
const { classifyTask } = await import("../dist/typesafe.js");
const result = await classifyTask("inspect the repository");
assert.equal(result, undefined);
console.log("optional TypeSafe fallback: ok");