// Unit tests for src/stream.ts. NO_COLOR=1 so ANSI collapses to empty.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NO_COLOR = "1";

const { renderStreamEvent, renderStreamConcluded } = await import("./stream.ts");

test("renderStreamEvent: 📡 stream/event with all metadata fields", () => {
    const out = renderStreamEvent({
        entryId: 42,
        channel: "stdout",
        state: "active",
        contentLength: 1234,
    });
    assert.match(out, /📡/);
    assert.match(out, /stream\/event/);
    assert.match(out, /entry=42/);
    assert.match(out, /channel=stdout/);
    assert.match(out, /state=active/);
    assert.match(out, /len=1234/);
    assert.match(out, /^  /);
});

test("renderStreamEvent: state transitions render verbatim", () => {
    for (const state of ["static", "active", "closed", "errored"]) {
        const out = renderStreamEvent({ entryId: 1, channel: "c", state, contentLength: 0 });
        assert.match(out, new RegExp(`state=${state}`));
    }
});

test("renderStreamConcluded: full payload", () => {
    const out = renderStreamConcluded({
        entryId: 42,
        subscriptionId: 1,
        scheme: "exec",
        closeStatus: 200,
        summary: "ls -la done",
        wakeAction: "opened-loop",
        wakeLoopId: 7,
    });
    assert.match(out, /📡/);
    assert.match(out, /stream\/concluded/);
    assert.match(out, /entry=42/);
    assert.match(out, /scheme=exec/);
    assert.match(out, /status=200/);
    assert.match(out, /wake=opened-loop/);
    assert.match(out, /"ls -la done"/);
});

test("renderStreamConcluded: empty summary omits the quoted block", () => {
    const out = renderStreamConcluded({
        entryId: 1,
        subscriptionId: 1,
        scheme: "exec",
        closeStatus: 200,
        summary: "",
        wakeAction: "no-op-active-loop",
    });
    assert.doesNotMatch(out, /""/);
});
