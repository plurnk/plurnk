import test from "node:test";
import assert from "node:assert/strict";
import {
    formatWorkerEffort,
    readWorkerEffort,
    setWorkerEffort,
} from "./effort.ts";

test("[§cli-effort][§cli-plurnk-effort] effort actions preserve the daemon-owned effort and supported choices", async () => {
    const calls: Array<{ method: string; params?: object }> = [];
    const rpc = {
        call: async (method: string, params?: object) => {
            calls.push({ method, params });
            return { effort: method.endsWith(".set") ? "high" : "adaptive", source: method.endsWith(".set") ? "explicit" : "default", supportedEfforts: ["off", "adaptive", "high"] };
        },
    };

    assert.deepEqual(await readWorkerEffort(rpc), {
        effort: "adaptive",
        source: "default",
        supportedEfforts: ["off", "adaptive", "high"],
    });
    assert.deepEqual(await setWorkerEffort(rpc, "high"), {
        effort: "high",
        source: "explicit",
        supportedEfforts: ["off", "adaptive", "high"],
    });
    assert.deepEqual(calls, [
        { method: "worker.effort.get", params: undefined },
        { method: "worker.effort.set", params: { effort: "high" } },
    ]);
});

test("effort text distinguishes the effective effort, its provenance, and the daemon-supported choices", () => {
    assert.equal(
        formatWorkerEffort({ effort: null, source: "default", supportedEfforts: [] }),
        "effort: (unavailable)\nsupported: none\n",
    );
    // {§cli-identity-effort} — the daemon's provenance in words.
    assert.equal(
        formatWorkerEffort({ effort: "low", source: "default", supportedEfforts: ["low", "high"] }),
        "effort: low (provider default)\nsupported: low, high\n",
    );
    assert.equal(
        formatWorkerEffort({ effort: "high", source: "explicit", supportedEfforts: ["low", "high"] }),
        "effort: high (chosen with /effort)\nsupported: low, high\n",
    );
});
