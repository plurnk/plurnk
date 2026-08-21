import test from "node:test";
import assert from "node:assert/strict";
import {
    formatWorkerReasoning,
    readWorkerReasoning,
    setWorkerReasoning,
} from "./reasoning.ts";

test("[§cli-reasoning-policy][§cli-plurnk-reasoning] reasoning actions preserve the daemon-owned policy and supported choices", async () => {
    const calls: Array<{ method: string; params?: object }> = [];
    const rpc = {
        call: async (method: string, params?: object) => {
            calls.push({ method, params });
            return { policy: method.endsWith(".set") ? "high" : "adaptive", supportedPolicies: ["off", "adaptive", "high"] };
        },
    };

    assert.deepEqual(await readWorkerReasoning(rpc), {
        policy: "adaptive",
        supportedPolicies: ["off", "adaptive", "high"],
    });
    assert.deepEqual(await setWorkerReasoning(rpc, "high"), {
        policy: "high",
        supportedPolicies: ["off", "adaptive", "high"],
    });
    assert.deepEqual(calls, [
        { method: "worker.reasoning.get", params: undefined },
        { method: "worker.reasoning.set", params: { policy: "high" } },
    ]);
});

test("reasoning text distinguishes the effective policy from daemon-supported choices", () => {
    assert.equal(
        formatWorkerReasoning({ policy: "adaptive", supportedPolicies: ["off", "adaptive", "high"] }),
        "reasoning: adaptive\nsupported: off, adaptive, high\n",
    );
    assert.equal(
        formatWorkerReasoning({ policy: null, supportedPolicies: [] }),
        "reasoning: (unavailable)\nsupported: none\n",
    );
});
