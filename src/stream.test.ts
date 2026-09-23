// Unit tests for src/stream.ts. NO_COLOR=1 so ANSI collapses to empty.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NO_COLOR = "1";

const { default: StreamTrace, streamAddress, inlineable, renderInline } = await import("./stream.ts");
type LogEntryWire = Parameters<typeof streamAddress>[0];
type Concluded = Parameters<InstanceType<typeof StreamTrace>["concluded"]>[0];

const event = (entryId: number, over: Partial<{ channel: string; state: string; contentLength: number }> = {}) => ({
    entryId, workerId: 7, target: "python:///0c0ffee1", channel: "stdout", state: "active", contentLength: 12,
    loop_seq: 1, turn_seq: 2, sequence: 1, ...over,
});

const concluded = (over: Partial<{ status: number; summary: string; wakeAction: string; problem: { type: string; title: string } }> = {}): Concluded => {
    const { status = 200, problem, ...rest } = over;
    return {
        entryId: 1, workerId: 7, target: "python:///0c0ffee1", subscriptionId: 1, scheme: "python",
        result: (problem === undefined ? { status } : { status, problem: { ...problem, status } }) as Concluded["result"],
        summary: `python:///0c0ffee1 ${status === 200 ? "completed (exit 0)" : "failed (exit 2)"}; stdout=12 bytes, stderr=0 bytes`,
        wakeAction: "no-op-active-loop", loop_seq: 1, turn_seq: 2, sequence: 1, ...rest,
    };
};

// A started execution's row as the daemon journals it: scheme and pathname null, the stream
// address and the resolved runtime stamped on `attrs`, status 200 with outcome `started`.
const launch = (over: Partial<LogEntryWire> = {}): LogEntryWire => ({
    id: 8, op: "python", origin: "model", signal: null, scheme: null, pathname: null, hostname: null, fragment: null,
    lineMarker: null, status_rx: 200, tx: { runtime: "python", aside: "Run the focused tests", body: "print(1)" },
    rx: { status: 200, outcome: "started" }, attrs: { runtime: "python", stream: "python:///0c0ffee1", coordinate: { loop_seq: 1, turn_seq: 2, sequence: 1 } },
    tags: [], loop_seq: 1, turn_seq: 2, sequence: 1, ...over,
});
const unstarted = (): LogEntryWire => launch({ attrs: undefined, status_rx: 404, rx: { status: 404, problem: { type: "x", title: "Unknown executor", status: 404 } } });

test("[§cli-what-is-not-rendered] start and growth events say nothing in the transcript", () => {
    const t = new StreamTrace();
    assert.equal(t.event(event(1)), null);
    assert.equal(t.event(event(1, { contentLength: 24 })), null);
    assert.equal(t.event(event(1, { channel: "stderr", state: "closed", contentLength: 0 })), null);
});

test("streamAddress: a started execution's row carries the address the daemon stamped on it", () => {
    assert.equal(streamAddress(launch()), "python:///0c0ffee1");
    assert.equal(streamAddress(unstarted()), null, "an execution the daemon refused has no stream");
    assert.equal(streamAddress(launch({ attrs: { runtime: "sh", stream: "sh:///0c0ffee1", detached: true } })), "sh:///0c0ffee1", "a detached execution launches like any other; the following turn shows it grey");
    assert.equal(streamAddress(launch({ attrs: { runtime: "python" } })), null, "no stamped stream, no launch");
    assert.equal(new StreamTrace().launch(launch({ origin: "_plurnk", source: "worker://identity" })), false, "{plurnk#108} a child's execution concludes in the child's Run: its lineage row renders now, never held");
});

test("StreamTrace: launch records a started execution only; a client `!` with no authored executor concludes under the resolved runtime", () => {
    const t = new StreamTrace();
    assert.equal(t.launch(unstarted()), false, "a refused execution is an ordinary row");
    assert.equal(t.launch(launch({ origin: "client", tx: { runtime: "python", aside: null, target: null, body: "printf x" } })), true);
    assert.equal(t.concluded(concluded()), "python\n    printf x", "no executor authored, no aside: the runtime the daemon resolved, the command beneath");
});

test("[§cli-stream-event-and-stream-concluded] [§cli-log-entry-line-format] an execution appears once, at its conclusion, as the fence that launched it", () => {
    const t = new StreamTrace();
    t.launch(launch());
    const line = t.concluded(concluded());
    assert.equal(line, "python Run the focused tests\n    print(1)", "the executor is the identity, the aside rides along, the body previews beneath; no bytes, no code");
    assert.doesNotMatch(line, /completed|stdout=|200/);
});

test("[§cli-log-entry-line-format] a failed execution names its outcome on the row", () => {
    const t = new StreamTrace();
    t.launch(launch());
    assert.equal(t.concluded(concluded({ status: 500 })), "python Run the focused tests — failed (exit 2); stdout=12 bytes, stderr=0 bytes\n    print(1)");
    t.launch(launch());
    assert.equal(t.concluded(concluded({ status: 500, problem: { type: "https://problems.plurnk.xyz/executor/nonzero-exit", title: "Command exited 2" } })),
        "python Run the focused tests — Command exited 2\n    print(1)", "a Problem title outranks the summary");
});

test("StreamTrace: a conclusion consumes its launch; the next conclusion with that address stands alone", () => {
    const t = new StreamTrace();
    t.launch(launch());
    t.concluded(concluded());
    assert.equal(t.concluded(concluded()), "python (python:///0c0ffee1)", "no launch known: the stream's scheme and address");
});

test("StreamTrace: a stream without a launching fence renders from its own payload", () => {
    const t = new StreamTrace();
    const line = t.concluded({ entryId: 9, workerId: 7, target: "sse://feed", subscriptionId: 2, scheme: "sse", result: { status: 499 }, summary: "", wakeAction: "skipped-cancelled" });
    assert.equal(line, "sse (sse://feed) — 499");
    assert.doesNotMatch(line, /resumed|wake/);
});

test("inlineable: short one-or-two-line content only", () => {
    assert.equal(inlineable("Ulaanbaatar\n"), true);
    assert.equal(inlineable("line one\nline two\n"), true);
    assert.equal(inlineable("a\nb\nc\n"), false);
    assert.equal(inlineable(""), false);
    assert.equal(inlineable("x".repeat(161)), false);
});

test("renderInline: indents under the conclusion; stderr is marked", () => {
    assert.equal(renderInline("stdout", "Ulaanbaatar\n"), "    Ulaanbaatar");
    assert.match(renderInline("stderr", "oh no\n"), /^    ! oh no$/);
    // {plurnk#107} — an execution's output previews like any body: the knob's line count.
    const long = renderInline("stdout", Array.from({ length: 40 }, (_, index) => `l${index + 1}`).join("\n")).split("\n");
    assert.equal(long.length, 4);
    assert.equal(long[3], "    … +37 lines");
});

test("[§cli-what-is-not-rendered] an execution still open when the following turn begins is reported once as stale, then concludes normally", () => {
    const t = new StreamTrace();
    t.launch(launch());
    assert.deepEqual(t.staleBefore(1, 2), [], "its own turn: nothing is stale");
    assert.equal(t.staleBefore(1, 3).length, 1, "the following turn: once");
    assert.deepEqual(t.staleBefore(1, 4), [], "never twice");
    assert.equal(t.concluded(concluded()), "python Run the focused tests\n    print(1)", "the conclusion is its second and final appearance");
    assert.deepEqual(t.staleBefore(2, 1), [], "concluded: nothing left");
});
