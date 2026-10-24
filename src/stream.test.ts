// Unit tests for src/stream.ts. NO_COLOR=1 so ANSI collapses to empty.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NO_COLOR = "1";

const { default: StreamTrace, openLaunches, streamAddress, inlineable, inlineOutput, renderInline } = await import("./stream.ts");
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
    id: 8, op: "python", origin: "model", signal: null, target: null,
    lineMarker: null, status_rx: 200, tx: { runtime: "python", aside: "Run the focused tests", body: "print(1)" },
    rx: { status: 200, outcome: "started" }, attrs: { runtime: "python", stream: "python:///0c0ffee1", coordinate: { loop_seq: 1, turn_seq: 2, sequence: 1 } },
    loop_seq: 1, turn_seq: 2, sequence: 1, ...over,
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
    assert.equal(t.concluded(concluded(), 80), "⚙️ python\n    printf x", "no executor authored, no aside: the runtime the daemon resolved, the command beneath");
});

test("[§cli-stream-event-and-stream-concluded] a stream address alone never hides a refused or unadmitted operation", () => {
    for (const status of [0, 201, 400, 403, 404, 499, 500]) {
        const row = launch({ origin: "client", status_rx: status, rx: { status } });
        const trace = new StreamTrace();
        assert.equal(streamAddress(row), null, `status ${status} did not admit a producer`);
        assert.equal(trace.launch(row), false);
        assert.deepEqual(trace.staleBefore(1, 3), [], "no unfinished execution was manufactured");
    }
    assert.equal(streamAddress(launch({ rx: { status: 200, outcome: "auto: sh" } })), "python:///0c0ffee1", "approval outcome text is not admission state");
    const queued = launch({ status_rx: 202, rx: { status: 202, outcome: "queued" } });
    assert.equal(streamAddress(queued), "python:///0c0ffee1");
    const trace = new StreamTrace();
    assert.equal(trace.launch(queued), true, "queued work will also conclude");
    assert.equal(trace.concluded(concluded(), 80), "⚙️ python Run the focused tests\n    print(1)");
    assert.equal(streamAddress(launch({ status_rx: 202, rx: { status: 202, outcome: "accepted" } })), "python:///0c0ffee1");
});

test("[§cli-stream-event-and-stream-concluded] [§cli-log-entry-line-format] an execution appears once, at its conclusion, as the fence that launched it", () => {
    const t = new StreamTrace();
    t.launch(launch());
    const line = t.concluded(concluded(), 80);
    assert.equal(line, "⚙️ python Run the focused tests\n    print(1)", "the executor is the identity, the aside rides along, the body previews beneath; no bytes, no code");
    assert.doesNotMatch(line, /completed|stdout=|200/);
});

test("[§cli-log-entry-line-format] a failed execution names its outcome on the row", () => {
    const t = new StreamTrace();
    t.launch(launch());
    assert.equal(t.concluded(concluded({ status: 500 }), 80), "⚙️ python Run the focused tests — failed (exit 2); stdout=12 bytes, stderr=0 bytes\n    print(1)");
    t.launch(launch());
    assert.equal(t.concluded(concluded({ status: 500, problem: { type: "https://problems.plurnk.xyz/executor/nonzero-exit", title: "Command exited 2" } }), 80),
        "⚙️ python Run the focused tests — Command exited 2\n    print(1)", "a Problem title outranks the summary");
});

test("StreamTrace: a conclusion consumes its launch; the next conclusion with that address stands alone", () => {
    const t = new StreamTrace();
    t.launch(launch());
    t.concluded(concluded(), 80);
    assert.equal(t.concluded(concluded(), 80), "⚙️ python (python:///0c0ffee1)", "no launch known: the stream's scheme and address");
});

test("[§cli-log-entry-line-format] stream failures retain diagnostics with and without a known launch", () => {
    const t = new StreamTrace();
    const result = { status: 502, problem: { type: "https://problems.plurnk.xyz/executor/mcp/tool-reported-error",
        title: "Tool reported error", status: 502, detail: "The MCP tool reported an error.", diagnostic: "No web results found" } };
    const event: Concluded = { ...concluded(), scheme: "brave", target: "brave:///0c0ffee1", result };
    t.launch(launch({ op: "brave", tx: { runtime: "brave", target: { kind: "local", raw: "brave_web_search" } }, attrs: { stream: event.target } }));
    assert.equal(t.concluded(event, 80), "⚙️ brave (brave_web_search) — Tool reported error: No web results found");
    assert.equal(t.concluded(event, 80), "⚙️ brave (brave:///0c0ffee1) — Tool reported error: No web results found");
});

test("StreamTrace: a stream without a launching fence renders from its own payload", () => {
    const t = new StreamTrace();
    const line = t.concluded({ entryId: 9, workerId: 7, target: "sse://feed", subscriptionId: 2, scheme: "sse", result: { status: 499 }, summary: "", wakeAction: "skipped-cancelled" }, 80);
    assert.equal(line, "⚙️ sse (sse://feed) — 499");
    assert.doesNotMatch(line, /resumed|wake/);
});

// A subsystem command the daemon runs inside its settlement: its row settles with the verb's own status.
const members = { target: "members:///4c848a41", scheme: "members" } as const;
const settledRow = (status: number): LogEntryWire => launch({
    op: "members", state: "resolved", status_rx: status, rx: { status },
    tx: { runtime: "members", aside: "include the docs", target: { kind: "local", raw: "add" }, body: "{\"files\":[\"docs/**\"]}" },
    attrs: { runtime: "members", stream: members.target },
});
const membersConcluded = (status: number): Concluded => ({
    ...concluded({ status, summary: `${members.target} completed; results=48 bytes`, wakeAction: "no-op-active-loop" }), ...members,
    ...(status >= 400 ? { result: { status, problem: { type: "https://problems.plurnk.xyz/functionality/alias-exists", title: "Alias exists", status, detail: "'docs/**' already has a different definition." } } } : {}),
});

test("[§cli-stream-event-and-stream-concluded] a result succeeds below 400: only a failure names its outcome", () => {
    for (const status of [200, 201, 204, 400, 409, 500]) {
        const launched = new StreamTrace();
        launched.launch(launch());
        const paired = launched.concluded(concluded(status < 400
            ? { status, summary: "python:///0c0ffee1 completed (exit 0); stdout=12 bytes, stderr=0 bytes" }
            : { status, summary: "python:///0c0ffee1 executor threw; stdout=12 bytes, stderr=0 bytes", problem: { type: "https://problems.plurnk.xyz/scheme/exec/executor-threw", title: "Executor threw" } }), 80);
        const unpaired = new StreamTrace().concluded(membersConcluded(status), 80);
        if (status < 400) {
            assert.equal(paired, "⚙️ python Run the focused tests\n    print(1)", `${status}: the launching fence, no outcome text`);
            assert.equal(unpaired, "⚙️ members (members:///4c848a41)", `${status}: no launch known, scheme and address only`);
        } else {
            assert.match(paired, / — Executor threw/u, `${status}: a failure names its Problem`);
            assert.equal(unpaired, "⚙️ members (members:///4c848a41) — Alias exists", `${status}: the Problem's title`);
        }
    }
});

test("[§cli-stream-event-and-stream-concluded] a conclusion that arrives while its call awaits its settled row renders with that row, once", () => {
    for (const status of [201, 409]) {
        const t = new StreamTrace();
        const conclusion = membersConcluded(status);
        assert.equal(t.concluded(conclusion, 80, true), null, `${status}: the call has not settled; the conclusion waits`);
        const row = settledRow(status);
        assert.equal(t.settled(row), conclusion, `${status}: the settled row arrives and claims its conclusion`);
        const rendered = t.renderSettled(row, conclusion, 80);
        assert.match(rendered, /^⚙️ members \(add\) include the docs/u, `${status}: one row, the fence that launched it`);
        if (status < 400) assert.doesNotMatch(rendered, / — /u, "a success names no outcome");
        else assert.match(rendered, / — Alias exists/u, "a failure names its Problem");
        assert.equal(t.settled(row), null, `${status}: claimed once`);
    }
    const launched = new StreamTrace();
    launched.launch(launch());
    assert.equal(launched.concluded(concluded(), 80, true), "⚙️ python Run the focused tests\n    print(1)", "a known launch renders at once, awaited or not");
    assert.equal(new StreamTrace().settled(settledRow(201)), null, "a row with no held conclusion claims nothing");
});

test("inlineable: short one-or-two-line content only", () => {
    assert.equal(inlineable("Ulaanbaatar\n"), true);
    assert.equal(inlineable("line one\nline two\n"), true);
    assert.equal(inlineable("a\nb\nc\n"), false);
    assert.equal(inlineable(""), false);
    assert.equal(inlineable("x".repeat(161)), false);
});

test("renderInline: indents under the conclusion; stderr is marked", () => {
    assert.equal(renderInline("stdout", "Ulaanbaatar\n", 80), "    Ulaanbaatar");
    assert.match(renderInline("stderr", "oh no\n", 80), /^    ! oh no$/);
    // {plurnk#107} — an execution's output previews like any body: the knob's line count.
    const long = renderInline("stdout", Array.from({ length: 40 }, (_, index) => `l${index + 1}`).join("\n"), 80).split("\n");
    assert.equal(long.length, 4);
    assert.equal(long[3], "    … +37 lines");
});

test("{plurnk#108} a turn advance greys only the same worker's open executions", () => {
    const t = new StreamTrace();
    t.launch(launch({ worker_id: 20 }));
    assert.deepEqual(t.staleBefore(1, 3, 10), [], "another worker's turn never greys a descendant's execution");
    assert.equal(t.staleBefore(1, 3, 20).length, 1, "its own worker's turn does, once");
});

test("[§cli-what-is-not-rendered] an execution still open when the following turn begins is reported once as stale, then concludes normally", () => {
    const t = new StreamTrace();
    t.launch(launch());
    assert.deepEqual(t.staleBefore(1, 2), [], "its own turn: nothing is stale");
    assert.equal(t.staleBefore(1, 3).length, 1, "the following turn: once");
    assert.deepEqual(t.staleBefore(1, 4), [], "never twice");
    assert.equal(t.concluded(concluded(), 80), "⚙️ python Run the focused tests\n    print(1)", "the conclusion is its second and final appearance");
    assert.deepEqual(t.staleBefore(2, 1), [], "concluded: nothing left");
});

test("{plurnk#162} an execution's output previews one row per line, stderr's marker included", () => {
    const stdout = renderInline("stdout", `${"y".repeat(29_290)}\nshort\n`, 60).split("\n");
    assert.deepEqual(stdout, [`    ${"y".repeat(55)}…`, "    short"]);
    const stderr = renderInline("stderr", "z".repeat(20_621), 60);
    assert.equal(stderr, `    ! ${"z".repeat(53)}…`);
    assert.equal(renderInline("stdout", "w".repeat(500), Number.POSITIVE_INFINITY), `    ${"w".repeat(500)}`, "an unbounded width cuts nothing");
});

test("[§cli-what-is-not-rendered] an execution's inline preview is followed by one blank line, and an execution with no output adds none (#182)", () => {
    const render = (channel: string, content: string) => `${channel}:${content.trim()}`;
    assert.deepEqual(inlineOutput({}, render), [], "no channels add no lines");
    assert.deepEqual(inlineOutput({ stdout: { content: "" }, stderr: { content: "  \n" } }, render), [], "blank output adds no lines");
    assert.deepEqual(inlineOutput({ stdout: { content: "done\n" } }, render), ["stdout:done", ""]);
    assert.deepEqual(inlineOutput({ stdout: { content: "out" }, stderr: { content: "err" } }, render), ["stdout:out", "stderr:err", ""],
        "every channel with output, then one separator");
});

// {§cli-status-streams} — plurnk-service {§acp-status-streams}: an execution still open at attach concludes as its launch.
test("[§cli-status-streams] a history's launch rows of streams the worker still holds open are the ones adopted", () => {
    const launch = (id: number, stream: string | null) => ({ id, worker_id: 1, origin: "model", op: "sh", source: null, signal: null, status_rx: 200,
        attrs: stream === null ? {} : { stream }, tx: { runtime: "sh", body: "sleep 9" }, rx: null, target: null, lineMarker: null,
        loop_seq: 1, turn_seq: 1, sequence: id }) as unknown as LogEntryWire;
    const entries = [launch(1, "sh:///aaaa1111"), launch(2, "sh:///bbbb2222"), launch(3, null)];
    assert.deepEqual(openLaunches(entries, ["sh:///bbbb2222"]).map(({ id }) => id), [2], "the one still open");
    assert.deepEqual(openLaunches(entries, []), [], "none open, none adopted");
    const trace = new StreamTrace();
    for (const entry of openLaunches(entries, ["sh:///bbbb2222"])) assert.equal(trace.launch(entry), true);
    assert.equal(trace.launchedBy("sh:///bbbb2222")?.id, 2, "its conclusion finds its launch");
});
