import test from "node:test";
import assert from "node:assert/strict";
import { accrueTurnAccounting, turnAccountingFromNotice } from "./status.ts";
import { renderSummary } from "./render.ts";

process.env.NO_COLOR = "1";

const incomplete = {
    costUsd: null, knownCostUsd: "0.25",
    inputTokens: null, knownInputTokens: 100,
    outputTokens: null, knownOutputTokens: 20,
};
const complete = {
    costUsd: "0.1", knownCostUsd: "0.1",
    inputTokens: 10, knownInputTokens: 10,
    outputTokens: 2, knownOutputTokens: 2,
};
const usage = {
    accounting: { requests: [{}, {}], usage: null, knownUsage: { inputTokens: 100, outputTokens: 20 }, costUsd: null, knownCostUsd: "0.25" },
    curationWeight: null, curationBudget: null, contextTokens: null, contextCapacity: null, meta: {},
};

test("incomplete request accounting survives notices and later complete turns", () => {
    const first = turnAccountingFromNotice({ source: "engine:turn", kind: "turn_generated", accounting: incomplete });
    assert.deepEqual(first, incomplete);
    assert.deepEqual(accrueTurnAccounting(first, complete), {
        costUsd: null, knownCostUsd: "0.35", inputTokens: null, knownInputTokens: 110, outputTokens: null, knownOutputTokens: 22,
    });
});

test("final summary explicitly labels known subtotals, including zero", () => {
    const line = renderSummary(1, 100, { status: 200 }, false, usage);
    assert.match(line, /↓100\+\? ↑20\+\?/);
    assert.match(line, /loop \$0\.2500 \+ \?/);
    const zero = renderSummary(1, 100, { status: 200 }, false, {
        ...usage, accounting: { ...usage.accounting, knownCostUsd: "0" },
    });
    assert.match(zero, /loop \$0\.0000 \+ \?/);
});
