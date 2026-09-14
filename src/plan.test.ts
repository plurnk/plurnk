import test from "node:test";
import assert from "node:assert/strict";
import { presentPlan } from "./plan.ts";

test("presentPlan: preserves Plan order and projects statuses as width-stable glyphs", () => {
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

test("presentPlan: task content never overrides its status or loses a prefix", () => {
    assert.deepEqual(presentPlan({
        body: {
            entries: [{
                content: "Memory: One baseline owns the schema",
                priority: "medium",
                status: "completed",
            }],
        },
    }), [{ glyph: "✅", text: "Memory: One baseline owns the schema" }]);
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

test("presentPlan: ACP waiting and failed subtypes keep their native meaning", () => {
    assert.deepEqual(presentPlan({ body: { entries: [
        { content: "Waiting: Child results", priority: "medium", status: "in_progress", _meta: { "plurnk.xyz/status": "waiting" } },
        { content: "Failed: Command failed", priority: "high", status: "completed", _meta: { "plurnk.xyz/status": "failed" } },
        { content: "Failed: is literal prose", priority: "medium", status: "completed" },
    ] } }), [
        { glyph: "💤", text: "Waiting: Child results" },
        { glyph: "✋", text: "[high] Failed: Command failed" },
        { glyph: "✅", text: "Failed: is literal prose" },
    ]);
});

test("presentPlan: rejects a PLAN row without the canonical body", () => {
    assert.throws(() => presentPlan(null), /canonical Plan body/);
    assert.throws(() => presentPlan({
        body: [{ content: "internal task", status: "pending" }],
    }), /canonical Plan body/, "the client consumes ACP, never the daemon's model-native array");
});

const { planColumns } = await import("./plan.ts");

test("[§cli-plan-rendering] planColumns groups entries under their native status in the stable order, populated columns only", () => {
    assert.deepEqual(planColumns({ body: { entries: [
        { content: "Compose the response", priority: "medium", status: "pending" },
        { content: "Read the docs", priority: "medium", status: "completed" },
        { content: "Map the workspaces", priority: "high", status: "in_progress" },
        { content: "Verify the build", priority: "medium", status: "completed" },
    ] } }), [
        { status: "todo", entries: ["Compose the response"] },
        { status: "in_progress", entries: ["[high] Map the workspaces"] },
        { status: "completed", entries: ["Read the docs", "Verify the build"] },
    ], "todo is the native name of ACP pending; waiting and failed columns are absent when empty");
});

test("[§cli-plan-rendering] planColumns keeps the waiting and failed subtypes as their own columns", () => {
    assert.deepEqual(planColumns({ body: { entries: [
        { content: "Receive the review", priority: "medium", status: "in_progress", _meta: { "plurnk.xyz/status": "waiting" } },
        { content: "Run the tests", priority: "medium", status: "completed", _meta: { "plurnk.xyz/status": "failed" } },
    ] } }), [
        { status: "waiting", entries: ["Receive the review"] },
        { status: "failed", entries: ["Run the tests"] },
    ]);
    assert.deepEqual(planColumns({ body: { entries: [] } }), []);
    assert.throws(() => planColumns(null), /canonical Plan body/);
});
