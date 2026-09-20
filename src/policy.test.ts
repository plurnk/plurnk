import { test } from "node:test";
import assert from "node:assert/strict";
import { promptPolicy, statedLoopPolicy } from "./policy.ts";

test("[§cli-loop-policy] the client states only what its user chose, one knob per choice", () => {
    assert.deepEqual(statedLoopPolicy(undefined, false), {}, "a user with nothing to say leaves the whole policy to the daemon");
    assert.deepEqual(statedLoopPolicy("reject", false), { proposals: "reject" });
    assert.deepEqual(statedLoopPolicy(undefined, true), { attended: false }, "--auto is exactly one statement: nobody is attending");
    assert.deepEqual(statedLoopPolicy("reject", true), { proposals: "reject", attended: false });
    assert.throws(() => statedLoopPolicy("sometimes", false), /proposals must be one of review, accept, reject/);
    assert.throws(() => statedLoopPolicy("", false), /proposals must be one of review, accept, reject/);
});

test("promptPolicy: '?' states review and nothing else", () => {
    const base = { proposals: "accept" as const };
    assert.deepEqual(promptPolicy("? explain this", base), { prompt: "explain this", policy: { proposals: "review" } });
    assert.deepEqual(base, { proposals: "accept" }, "prefix handling does not mutate the stated posture");
    assert.deepEqual(promptPolicy("? explain this"), { prompt: "explain this", policy: { proposals: "review" } });
});

test("promptPolicy: ':' and bare prompts state nothing new", () => {
    const base = statedLoopPolicy("reject", false);
    assert.deepEqual(promptPolicy(": change this", base), { policy: base, prompt: "change this" });
    assert.deepEqual(promptPolicy("change this", base), { policy: base, prompt: "change this" });
    assert.deepEqual(promptPolicy("... additional context", base), { policy: base, prompt: "additional context" });
    assert.deepEqual(promptPolicy("change this"), { policy: {}, prompt: "change this" });
});
