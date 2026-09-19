import { test } from "node:test";
import assert from "node:assert/strict";
import { composeLoopPolicy, parseLoopPolicy, promptPolicy } from "./policy.ts";

test("promptPolicy: '?' requests review without introducing private capability restrictions", () => {
    const base = { proposals: "accept" as const, attended: true };
    assert.deepEqual(promptPolicy("? explain this", base), { prompt: "explain this", policy: { proposals: "review", attended: true } });
    assert.deepEqual(base, { proposals: "accept", attended: true }, "prefix handling does not mutate configured posture");
});

test("promptPolicy: ':' and bare prompts preserve the general base policy", () => {
    const base = composeLoopPolicy(undefined, "reject");
    assert.deepEqual(promptPolicy(": change this", base), { policy: base, prompt: "change this" });
    assert.deepEqual(promptPolicy("change this", base), { policy: base, prompt: "change this" });
    assert.deepEqual(promptPolicy("... additional context", base), { policy: base, prompt: "additional context" });
});

test("loop policy admits the proposal disposition and the run's attendance, nothing else", () => {
    assert.deepEqual(parseLoopPolicy("--policy", '{"proposals":"reject"}'), { proposals: "reject", attended: true },
        "a policy written before attendance existed keeps its meaning");
    assert.deepEqual(parseLoopPolicy("--policy", '{"attended":false}'), { proposals: "review", attended: false });
    assert.throws(() => parseLoopPolicy("--policy", '{"capabilities":{}}'), /unsupported field/);
    assert.deepEqual(composeLoopPolicy(), { proposals: "review", attended: true });
    assert.deepEqual(composeLoopPolicy(undefined, "accept", false), { proposals: "accept", attended: false });
});
