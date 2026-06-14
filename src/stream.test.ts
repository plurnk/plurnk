// Unit tests for src/stream.ts. NO_COLOR=1 so ANSI collapses to empty.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NO_COLOR = "1";

const { default: StreamTrace, inlineable, renderInline, coordFromTarget } = await import("./stream.ts");

const event = (entryId: number, over: Partial<{ channel: string; state: string; contentLength: number }> = {}) => ({
    entryId, target: "exec://python/1/2/1", channel: "stdout", state: "active", contentLength: 12, ...over,
});

const concluded = (over: Partial<{ closeStatus: number; summary: string; wakeAction: string }> = {}) => ({
    entryId: 1, target: "exec://python/1/2/1", subscriptionId: 1, scheme: "exec",
    closeStatus: 200, summary: "exec://python/1/2/1 completed (exit 0); stdout=12 bytes, stderr=0 bytes",
    wakeAction: "no-op-active-loop", ...over,
});

test("StreamTrace: first event announces the stream, every later tick is silent", () => {
    const t = new StreamTrace();
    const first = t.event(event(1));
    assert.ok(first !== null);
    assert.match(first, /📡 ⏳ exec:\/\/python\/1\/2\/1/);
    assert.match(first, /^  01\/02\/01 /, "start line carries the exec coordinate");
    assert.equal(t.event(event(1, { contentLength: 24 })), null);
    assert.equal(t.event(event(1, { channel: "stderr", state: "closed", contentLength: 0 })), null);
});

test("StreamTrace: distinct entries each announce once", () => {
    const t = new StreamTrace();
    assert.ok(t.event(event(1)) !== null);
    assert.ok(t.event(event(2)) !== null);
    assert.equal(t.event(event(2)), null);
});

test("StreamTrace: conclusion speaks the waterfall grammar and strips the target echo", () => {
    const t = new StreamTrace();
    const line = t.concluded(concluded());
    assert.match(line, /📡 ✅ 200 exec:\/\/python\/1\/2\/1/);
    assert.match(line, /^  01\/02\/01 /, "conclusion line carries the exec coordinate");
    assert.match(line, /"completed \(exit 0\); stdout=12 bytes, stderr=0 bytes"/);
    assert.doesNotMatch(line, /exec:\/\/python\/1\/2\/1 completed/);
    assert.doesNotMatch(line, /no-op-active-loop/);
});

test("StreamTrace: only opened-loop wakes are user-visible", () => {
    const t = new StreamTrace();
    assert.match(t.concluded(concluded({ wakeAction: "opened-loop" })), /→ woke loop$/);
    assert.doesNotMatch(t.concluded(concluded({ wakeAction: "skipped-aborted", closeStatus: 499 })), /woke/);
});

test("StreamTrace: a stream can re-announce after its conclusion", () => {
    const t = new StreamTrace();
    t.event(event(1));
    t.concluded(concluded());
    assert.ok(t.event(event(1)) !== null);
});

test("StreamTrace: failure conclusion gets the failure glyph", () => {
    const t = new StreamTrace();
    assert.match(t.concluded(concluded({ closeStatus: 500, summary: "boom" })), /❌ 500/);
    assert.match(t.concluded(concluded({ closeStatus: 499, summary: "" })), /✋ 499/);
});

test("inlineable: short one-or-two-line content only", () => {
    assert.equal(inlineable("Ulaanbaatar\n"), true);
    assert.equal(inlineable("line one\nline two\n"), true);
    assert.equal(inlineable("a\nb\nc\n"), false);
    assert.equal(inlineable(""), false);
    assert.equal(inlineable("x".repeat(161)), false);
});

test("renderInline: indents under the conclusion; stderr is marked", () => {
    assert.equal(renderInline("stdout", "Ulaanbaatar\n"), "     Ulaanbaatar");
    assert.match(renderInline("stderr", "oh no\n"), /^     ! oh no$/);
});

test("coordFromTarget: extracts the trailing L/T/S from an exec URI", () => {
    assert.match(coordFromTarget("exec://python/1/2/1"), /01\/02\/01 /);
    assert.match(coordFromTarget("exec://search/12/3/45"), /12\/03\/45 /);
});
