// Unit tests for the bridge CLI consumer (plurnk-agui#1 slice 2). Scripted AG-UI
// events + capturing sinks — no bridge, no daemon. Asserts the family-client
// rendering (plurnk.row → trace/answer), proposal settlement over /resolve, and
// the exit code from RUN_FINISHED/RUN_ERROR.

import { test } from "node:test";
import assert from "node:assert/strict";
import { consumeCliRun, type CliRunSinks } from "./agui_cli.ts";
import type { AguiEvent } from "./agui.ts";
import type { LogEntryWire } from "./render.ts";
import type { Resolution } from "./proposal.ts";

const entry = (o: Partial<LogEntryWire> = {}): LogEntryWire => ({
    id: 1, op: "READ", suffix: "", origin: "model", signal: null,
    loop_seq: 1, turn_seq: 1, sequence: 1,
    scheme: null, pathname: null, hostname: null, fragment: null,
    status_rx: 200, tx: null, rx: null, ...o,
});

const row = (e: Partial<LogEntryWire>): AguiEvent => ({ type: "CUSTOM", name: "plurnk.row", value: entry(e) });
const rowRun = (e: Partial<LogEntryWire>, runId: number): AguiEvent => ({ type: "CUSTOM", name: "plurnk.row", value: { ...entry(e), run_id: runId } });
const terminalSend = (text: string): AguiEvent => row({ op: "SEND", scheme: null, pathname: null, signal: 200, status_rx: 200, tx: { body: { raw: text } } });
const terminated = (over: Record<string, unknown> = {}): AguiEvent => ({ type: "CUSTOM", name: "plurnk.terminated", value: { sessionId: 7, loopId: 3, finalStatus: 200, hitMaxTurns: false, turnIds: [1, 2], usage: { promptTokens: 10, completionTokens: 5, costPico: 42, contextTokens: 10, contextSize: 6848, meta: {} }, ...over } });

async function* stream(events: AguiEvent[]): AsyncGenerator<AguiEvent> { for (const e of events) yield e; }

const sink = (over: Partial<CliRunSinks> = {}) => {
    const out: string[] = [], err: string[] = [], resolved: unknown[] = [];
    const io: CliRunSinks = {
        out: (s) => out.push(s), err: (s) => err.push(s), telemetry: () => {},
        json: false, yolo: false, noReviewChannel: false,
        review: async () => ({ decision: "accept" } as Resolution),
        resolve: async (r) => { resolved.push(r); },
        ...over,
    };
    return { io, out, err, resolved };
};

test("consumeCliRun: terminal broadcast body → stdout (answer), rows → stderr (trace), exit 0", async () => {
    const { io, out, err } = sink();
    const { exitCode } = await consumeCliRun(stream([
        row({ op: "FIND", scheme: "file", pathname: "/x" }),
        terminalSend("Jupiter is the largest planet."),
        { type: "RUN_FINISHED", threadId: "t", runId: "r" },
    ]), io);
    assert.equal(exitCode, 0);
    assert.equal(out.join(""), "Jupiter is the largest planet.\n", "only the answer on stdout");
    assert.ok(err.length >= 2, "every row traced to stderr");
});

test("consumeCliRun: RUN_ERROR carries the finalStatus into the exit code + a maxTurns read", async () => {
    const { io, err } = sink();
    const { exitCode } = await consumeCliRun(stream([
        { type: "RUN_ERROR", message: "loop terminated 429 (maxTurns)", code: "429" },
    ]), io);
    assert.equal(exitCode, 2, "maxTurns → exit 2");
    assert.match(err.join(""), /loop terminated 429/);
});

test("consumeCliRun: a proposal is reviewed then resolved over the bridge", async () => {
    const { io, resolved } = sink({ review: async () => ({ decision: "accept", body: "edited" }) });
    await consumeCliRun(stream([
        { type: "CUSTOM", name: "plurnk.proposal", value: { logEntryId: 9, op: "EDIT", target: {}, body: "diff", attrs: {}, flags: {} } },
        { type: "RUN_FINISHED" },
    ]), io);
    assert.deepEqual(resolved, [{ logEntryId: 9, decision: "accept", body: "edited" }]);
});

test("consumeCliRun: yolo auto-accepts a proposal without review", async () => {
    let reviewed = false;
    const { io, resolved } = sink({ yolo: true, review: async () => { reviewed = true; return { decision: "accept" }; } });
    await consumeCliRun(stream([{ type: "CUSTOM", name: "plurnk.proposal", value: { logEntryId: 3, op: "EDIT", target: {}, body: "", attrs: {}, flags: {} } }]), io);
    assert.equal(reviewed, false, "yolo skips review");
    assert.deepEqual(resolved, [{ logEntryId: 3, decision: "accept" }]);
});

test("consumeCliRun: no review channel rejects the proposal (fail-closed, no hang)", async () => {
    const { io, resolved } = sink({ noReviewChannel: true });
    await consumeCliRun(stream([{ type: "CUSTOM", name: "plurnk.proposal", value: { logEntryId: 4, op: "EDIT", target: {}, body: "", attrs: {}, flags: {} } }]), io);
    assert.deepEqual(resolved, [{ logEntryId: 4, decision: "reject" }]);
});

test("consumeCliRun: a server-resolved proposal (flags.yolo) is skipped — client would race", async () => {
    const { io, resolved } = sink();
    await consumeCliRun(stream([{ type: "CUSTOM", name: "plurnk.proposal", value: { logEntryId: 5, op: "EDIT", target: {}, body: "", attrs: {}, flags: { yolo: true } } }]), io);
    assert.deepEqual(resolved, [], "no client resolve for a server-settled proposal");
});

test("consumeCliRun: plurnk.telemetry routes to the telemetry sink; generic AG-UI events are ignored", async () => {
    const tele: unknown[] = [];
    const { io, out, err } = sink({ telemetry: (e) => tele.push(e) });
    await consumeCliRun(stream([
        { type: "TEXT_MESSAGE_CONTENT", messageId: "1", delta: "ignored-generic" },
        { type: "CUSTOM", name: "plurnk.telemetry", value: { source: "engine", kind: "note", level: "info" } },
        { type: "RUN_FINISHED" },
    ]), io);
    assert.equal(tele.length, 1, "telemetry captured");
    assert.equal(out.join(""), "", "generic TEXT_MESSAGE not rendered by the family client");
    assert.equal(err.join(""), "", "no row → no trace");
});

test("consumeCliRun: json mode stays silent + accumulates the full record", async () => {
    const { io, out, err } = sink({ json: true });
    const res = await consumeCliRun(stream([
        rowRun({ op: "PLAN", origin: "model" }, 42),
        rowRun({ op: "FIND", scheme: "file", pathname: "/x", origin: "model" }, 42),
        terminalSend("Jupiter."),
        terminated({ sessionId: 512, loopId: 9, turnIds: [1, 2, 3], usage: { promptTokens: 20, completionTokens: 8, costPico: 4200, contextTokens: 20, contextSize: 6848, meta: {} } }),
        { type: "RUN_FINISHED" },
    ]), io);
    assert.equal(out.join(""), "", "json mode: silent stdout");
    assert.equal(err.join(""), "", "json mode: silent stderr");
    assert.equal(res.exitCode, 0);
    assert.equal(res.entries.length, 3, "all rows accumulated");
    assert.equal(res.response, "Jupiter.", "terminal broadcast captured");
    assert.equal(res.modelRunId, 42, "modelRunId derived from the first model row's run_id");
    assert.equal(res.terminated?.sessionId, 512, "sessionId from plurnk.terminated");
    assert.equal(res.terminated?.usage.costPico, 4200, "cost from plurnk.terminated");
});

test("consumeCliRun: plurnk.terminated is authoritative for the exit code", async () => {
    const { io } = sink();
    const { exitCode } = await consumeCliRun(stream([
        terminated({ finalStatus: 499, turnIds: [] }),
    ]), io);
    assert.equal(exitCode, 3, "499 cancel → exit 3 (exitCodeForLoop)");
});
