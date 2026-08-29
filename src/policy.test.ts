import { test } from "node:test";
import assert from "node:assert/strict";
import { CapabilityAdmission } from "@plurnk/plurnk-contracts";
import {
    EXEC_DENIED_CAPABILITIES,
    NONINTERACTIVE_CAPABILITIES,
    composeLoopPolicy,
    promptPolicy,
} from "./policy.ts";

test("promptPolicy: '?' is ordinary subtractive loop policy, not a named mode", () => {
    const base = {
        capabilities: { deny: [{ traits: ["web"] as [string] }] },
        proposals: "accept" as const,
    };
    const projected = promptPolicy("? explain this", base);
    assert.equal(projected.prompt, "explain this");
    assert.equal(projected.policy.proposals, "review");
    assert.equal(CapabilityAdmission.allows(projected.policy.capabilities, {
        operation: "EXEC", runtime: "sh", access: "execute", traits: [],
    }), false);
    assert.equal(CapabilityAdmission.allows(projected.policy.capabilities, {
        operation: "READ", scheme: "https", access: "observe", traits: ["web"],
    }), false);
    assert.equal(CapabilityAdmission.allows(projected.policy.capabilities, {
        operation: "READ", scheme: "file", access: "observe", traits: [],
    }), true);
});

test("promptPolicy: ':' and bare prompts preserve the general base policy", () => {
    const base = composeLoopPolicy(undefined, [EXEC_DENIED_CAPABILITIES], "reject");
    assert.deepEqual(promptPolicy(": change this", base), { policy: base, prompt: "change this" });
    assert.deepEqual(promptPolicy("change this", base), { policy: base, prompt: "change this" });
    assert.deepEqual(promptPolicy("... additional context", base), { policy: base, prompt: "additional context" });
});

test("composeLoopPolicy intersects independent client-topology restrictions", () => {
    const policy = composeLoopPolicy(undefined, [EXEC_DENIED_CAPABILITIES, NONINTERACTIVE_CAPABILITIES]);
    assert.equal(policy.capabilities.deny?.length, 2);
    assert.equal(policy.proposals, "review");
});
