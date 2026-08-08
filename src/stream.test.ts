// Unit tests for src/stream.ts. NO_COLOR=1 so ANSI collapses to empty.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NO_COLOR = "1";

const { default: StreamTrace, inlineable, renderInline } = await import("./stream.ts");

const event = (entryId: number, over: Partial<{ channel: string; state: string; contentLength: number }> = {}) => ({
    entryId, workerId: 7, target: "python:///1/2/1", channel: "stdout", state: "active", contentLength: 12,
    loop_seq: 1, turn_seq: 2, sequence: 1, ...over,
});

const concluded = (over: Partial<{ status: number; summary: string; wakeAction: string }> = {}) => {
    const { status = 200, ...rest } = over;
    return {
        entryId: 1, workerId: 7, target: "python:///1/2/1", subscriptionId: 1, scheme: "python",
        result: { status }, summary: "python:///1/2/1 completed (exit 0); stdout=12 bytes, stderr=0 bytes",
        wakeAction: "no-op-active-loop", loop_seq: 1, turn_seq: 2, sequence: 1, ...rest,
    };
};

test("StreamTrace: first event announces the stream, every later tick is silent", () => {
    const t = new StreamTrace();
    const first = t.event(event(1));
    assert.ok(first !== null);
    // Blank op slot (2sp) + blank code slot (3sp) hold the waterfall columns:
    // Two lanes (identity · status): `📡 ⏳ ... target` — the in-flight line holds a
    // dim 3-dot reserve in the code column.
    assert.match(first, /📡 ⏳ \.{3} python:\/\/\/1\/2\/1/);
    assert.match(first, /^  01\/02\/01 /, "start line carries the wire coordinate");
    assert.equal(t.event(event(1, { contentLength: 24 })), null);
    assert.equal(t.event(event(1, { channel: "stderr", state: "closed", contentLength: 0 })), null);
});

test("StreamTrace: distinct entries each announce once", () => {
    const t = new StreamTrace();
    assert.ok(t.event(event(1)) !== null);
    assert.ok(t.event(event(2)) !== null);
    assert.equal(t.event(event(2)), null);
});

test("[§cli-stream-event-and-stream-concluded] StreamTrace: conclusion speaks the waterfall grammar and strips the target echo", () => {
    const t = new StreamTrace();
    const line = t.concluded(concluded());
    // Blank op slot between origin and status keeps the code/target columns
    // aligned with op rows (📡 has no op glyph).
    // Routine 200 conclusion badges no ✅ now (blank status slot); code + target stay aligned.
    assert.doesNotMatch(line, /✅/);
    assert.match(line, /📡.*200 python:\/\/\/1\/2\/1/);
    assert.match(line, /^  01\/02\/01 /, "conclusion line carries the wire coordinate");
    assert.match(line, /"completed \(exit 0\); stdout=12 bytes, stderr=0 bytes"/);
    assert.doesNotMatch(line, /python:\/\/\/1\/2\/1 completed/);
    assert.doesNotMatch(line, /no-op-active-loop/);
});

test("StreamTrace: only resumed-loop wakes are user-visible", () => {
    const t = new StreamTrace();
    assert.match(t.concluded(concluded({ wakeAction: "resumed-loop" })), /→ resumed loop$/);
    assert.doesNotMatch(t.concluded(concluded({ wakeAction: "skipped-aborted", status: 499 })), /resumed/);
});

test("StreamTrace: a stream can re-announce after its conclusion", () => {
    const t = new StreamTrace();
    t.event(event(1));
    t.concluded(concluded());
    assert.ok(t.event(event(1)) !== null);
});

test("StreamTrace: failure conclusion gets the failure glyph", () => {
    const t = new StreamTrace();
    assert.match(t.concluded(concluded({ status: 500, summary: "boom" })), /❌ 500/);
    assert.match(t.concluded(concluded({ status: 499, summary: "" })), /✋ 499/);
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

test("StreamTrace: a stream without a coordinate renders without one", () => {
    const t = new StreamTrace();
    const line = t.event({ entryId: 9, workerId: 7, target: "sse://feed", channel: "data", state: "active", contentLength: 5 });
    assert.ok(line !== null);
    assert.doesNotMatch(line, /\d\d\/\d\d\/\d\d/);
    assert.match(line, /📡 ⏳ \.{3} sse:\/\/feed/);
});
