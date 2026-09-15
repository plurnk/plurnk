// {§cli-inspection} — the human's look: the fence composed from `/look`'s arguments and the
// readout that prints above the composer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { lookFence, lookHeading, renderLook } from "./look.ts";

const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

test("lookFence puts the address in its parentheses and keeps scope and pattern as typed", () => {
    assert.equal(lookFence("worker:///plan.md"), "```LOOK (worker:///plan.md)```");
    assert.equal(lookFence("  worker:///plan.md <1,20> /needle/i "), "```LOOK (worker:///plan.md) <1,20> /needle/i```");
    assert.equal(lookFence("(worker:///plan.md) ~query"), "```LOOK (worker:///plan.md) ~query```", "an address the user parenthesized passes through");
    assert.equal(lookFence("   "), null, "nothing to look at");
});

test("lookHeading is the heading as submitted, without its fence", () => {
    assert.equal(lookHeading("```LOOK (worker:///plan.md) <1,20>```"), "LOOK (worker:///plan.md) <1,20>");
    assert.equal(lookHeading("````LOOK (worker:///x)\n~needle\n````"), "LOOK (worker:///x)", "a body matcher stays off the heading");
});

test("renderLook: the heading, then the content verbatim", () => {
    const out = stripAnsi(renderLook("```LOOK (worker:///note.md)```", { status: 200, content: "line one\nline two\n" }));
    assert.equal(out, "LOOK (worker:///note.md)\nline one\nline two");
});

test("renderLook: an empty result says so in the daemon's words", () => {
    assert.equal(stripAnsi(renderLook("```LOOK (worker:///empty.md)```", { status: 200, content: "" })), "LOOK (worker:///empty.md) — (empty)");
    assert.equal(stripAnsi(renderLook("```LOOK (pets_*.md)```", { status: 204, content: null, detail: "No path matched pets_*.md" })), "LOOK (pets_*.md) — No path matched pets_*.md");
});

test("renderLook: an unsuccessful look names the Problem title, with detail and recovery beneath", () => {
    const out = stripAnsi(renderLook("```LOOK (worker:///missing.md)```", {
        status: 404,
        problem: { type: "x", title: "Entry not found", status: 404, detail: "No entry at worker:///missing.md.", recovery: "Check the address." } as never,
    }));
    assert.equal(out, "LOOK (worker:///missing.md) — Entry not found\n  No entry at worker:///missing.md.\n  Check the address.");
    assert.equal(stripAnsi(renderLook("```LOOK (worker:///x)```", { status: 500 })), "LOOK (worker:///x) — 500", "without a Problem, the bare status");
});
