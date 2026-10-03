import test from "node:test";
import assert from "node:assert/strict";
import { accrueTurnAccounting, EMPTY_TALLY, tallyOutcome, turnAccountingFromNotice } from "./status.ts";
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

test("session accounting preserves unknowns from descendants and completed loops", () => {
    const tally = tallyOutcome(EMPTY_TALLY, { turns: 1, wallMs: 100, usage, descendants: complete });
    assert.equal(tally.accounting?.costUsd, null);
    assert.equal(tally.accounting?.knownCostUsd, "0.35");
    assert.equal(tally.accounting?.inputTokens, null);
    assert.equal(tally.accounting?.knownInputTokens, 110);
});

test("an attempt that fails before completing a turn still contributes to session accounting", () => {
    const failed = tallyOutcome(EMPTY_TALLY, { turns: 0, wallMs: 100, usage });
    const next = tallyOutcome(failed, { turns: 1, wallMs: 100, usage: {
        ...usage, accounting: { requests: [{}], usage: { inputTokens: 10, outputTokens: 2 },
            knownUsage: { inputTokens: 10, outputTokens: 2 }, costUsd: "0.1", knownCostUsd: "0.1" },
    } });
    assert.equal(next.accounting?.costUsd, null);
    assert.equal(next.accounting?.knownCostUsd, "0.35");
    assert.equal(next.accounting?.inputTokens, null);
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
