import test from "node:test";
import assert from "node:assert/strict";
import { presentPlan } from "./plan.ts";

test("presentPlan: preserves ACP order and projects statuses as width-stable glyphs", () => {
    assert.deepEqual(presentPlan({
        body: {
            entries: [
                { content: "Settled contract", priority: "medium", status: "completed" },
                { content: "Update clients", priority: "high", status: "in_progress" },
                { content: "Run local drills", priority: "low", status: "pending" },
            ],
        },
    }), [
        { glyph: "✅", text: "Settled contract" },
        { glyph: "🚧", text: "[high] Update clients" },
        { glyph: "⬜", text: "[low] Run local drills" },
    ]);
});

test("presentPlan: collapses each entry to one human line", () => {
    assert.deepEqual(presentPlan({
        body: {
            entries: [{
                content: "  Inspect the parser\n\tthen verify the result.  ",
                priority: "medium",
                status: "in_progress",
            }],
        },
    }), [{ glyph: "🚧", text: "Inspect the parser then verify the result." }]);
});

test("presentPlan: rejects a PLAN row without the canonical body", () => {
    assert.throws(() => presentPlan(null), /canonical ACP Plan body/);
});
