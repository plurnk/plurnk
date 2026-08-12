// Unit tests for the bridge CLI consumer (plurnk-agui#1 slice 2). Scripted AG-UI
// events + capturing sinks — no bridge, no daemon. Asserts the family-client
// rendering (plurnk.row → trace/answer), proposal settlement over /resolve, and
// the exit code from RUN_FINISHED/RUN_ERROR.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventType } from "@ag-ui/core";
import { consumeCliRun, type CliRunSinks } from "./agui_cli.ts";
import type { AguiEvent } from "./agui.ts";
import type { LogEntryWire } from "./render.ts";
import type { Resolution } from "./proposal.ts";

const entry = (o: Partial<LogEntryWire> = {}): LogEntryWire => ({
    id: 1, op: "READ", suffix: "", origin: "model", signal: null,
    loop_seq: 1, turn_seq: 1, sequence: 1,
    scheme: null, pathname: null, hostname: null, fragment: null,
    status_rx: 200, tx: null, rx: null, tags: [], ...o,
});

const row = (e: Partial<LogEntryWire>): AguiEvent => ({ type: EventType.CUSTOM, name: "plurnk.row", value: entry(e) });
const rowRun = (e: Partial<LogEntryWire>, runId: number): AguiEvent => ({ type: EventType.CUSTOM, name: "plurnk.row", value: { ...entry(e), worker_id: runId } });
const terminalSend = (text: string): AguiEvent => row({ op: "SEND", scheme: null, pathname: null, signal: 200, status_rx: 200, tx: { body: { raw: text } } });
const loopUsage = (costUsd: string | null = "0.0042") => ({
    accounting: {
        requests: [{
            provider: "provider:test",
            model: "test",
            outcome: "response",
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            cost: costUsd === null
                ? { kind: "unknown", reason: "provider supplied no monetary evidence" }
                : {
                    kind: "estimated",
                    amount: { amount: costUsd, currency: "USD" },
                    source: "fixture",
                },
        }],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        costUsd,
    },
    contextTokens: 10,
    promptBudget: 6848,
    meta: {},
});
const terminated = (over: Record<string, unknown> = {}): AguiEvent => ({ type: EventType.CUSTOM, name: "plurnk.terminated", value: { workspaceId: 7, workerId: 11, loopId: 3, hitMaxTurns: false, turnIds: [1, 2], usage: loopUsage(), result: { status: 200 }, ...over } });

async function* stream(events: AguiEvent[]): AsyncGenerator<AguiEvent> { for (const e of events) yield e; }
// AG-UI+ dialect: a client-owned proposal is a request_approval tool-call triple.
const proposalCall = (logEntryId: number, args: Record<string, unknown> = {}): AguiEvent[] => [
    { type: EventType.TOOL_CALL_START, toolCallId: `prop:${logEntryId}`, toolCallName: "request_approval" },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: `prop:${logEntryId}`, delta: JSON.stringify({ op: "EDIT", target: {}, body: "diff", attrs: {}, ...args }) },
    { type: EventType.TOOL_CALL_END, toolCallId: `prop:${logEntryId}` },
    { type: EventType.RUN_FINISHED, threadId: "t", runId: "r", outcome: { type: "interrupt", interrupts: [{ id: `prop:${logEntryId}`, reason: "tool_call", toolCallId: `prop:${logEntryId}` }] } },
];

const sink = (over: Partial<CliRunSinks> = {}) => {
    const out: string[] = [], err: string[] = [], resolved: unknown[] = [];
    const io: CliRunSinks = {
        out: (s) => out.push(s), err: (s) => err.push(s), notice: () => {},
        json: false, yolo: false, noReviewChannel: false,
        review: async () => ({ decision: "accept" } as Resolution),
        ...over,
    };
    return { io, out, err, resolved };
};

test("[§cli-one-shot-mode][§cli-output-channels] consumeCliRun: terminal broadcast body → stdout (answer), rows → stderr (trace), exit 0", async () => {
    const { io, out, err } = sink();
    const { exitCode } = await consumeCliRun(stream([
        row({ op: "FIND", scheme: "file", pathname: "/x" }),
        terminalSend("Jupiter is the largest planet."),
        // The real wire ALWAYS emits terminated before RUN_FINISHED; a stream without
        // it is a dead stream (502, svc#478) — the fixture matches the protocol.
        { type: EventType.CUSTOM, name: "plurnk.terminated", value: { workspaceId: 1, loopId: 1, hitMaxTurns: false, turnIds: [1], result: { status: 200 } } },
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" },
    ]), io);
    assert.equal(exitCode, 0);
    assert.equal(out.join(""), "Jupiter is the largest planet.\n", "only the answer on stdout");
    assert.ok(err.length >= 2, "every row traced to stderr");
});

test("consumeCliRun: RUN_ERROR without the exact Problem is a transport contract failure", async () => {
    const { io, err } = sink();
    const result = await consumeCliRun(stream([
        { type: EventType.RUN_ERROR, message: "loop terminated 429 (maxTurns)", code: "429" },
    ]), io);
    assert.equal(result.exitCode, 4);
    assert.equal(result.problem?.type, "https://problems.plurnk.dev/client/transport/problem-missing");
    assert.match(err.join(""), /required Problem Details/);
    assert.doesNotMatch(err.join(""), /maxTurns/, "the client does not reconstruct failure truth from lossy RUN_ERROR fields");
});

test("consumeCliRun: plurnk.problem preserves the terminal failure that RUN_ERROR cannot encode", async () => {
    const problem = {
        type: "https://problems.plurnk.dev/engine/generation/invalid-emission-exhausted",
        title: "Invalid emission exhausted",
        status: 500,
        detail: "The model did not emit a valid turn in three attempts.",
        attempts: 3,
        recovery: "Use a model that can emit the required turn structure.",
        retryable: false,
    };
    const { io } = sink({ json: true });
    const result = await consumeCliRun(stream([
        { type: EventType.CUSTOM, name: "plurnk.problem", value: problem },
        { type: EventType.RUN_ERROR, message: problem.detail, code: problem.type },
    ]), io);
    assert.equal(result.exitCode, 4);
    assert.deepEqual(result.problem, problem);
});

test("[§cli-one-shot-flow] consumeCliRun: a proposal tool-call is reviewed; the decision rides pendingResume", async () => {
    const { io } = sink({ review: async () => ({ decision: "accept", body: "edited" }) });
    const r = await consumeCliRun(stream(proposalCall(9)), io);
    assert.deepEqual(r.pendingResume, { logEntryId: 9, decision: "accept", body: "edited" }, "the resume tool-result carries the reviewed decision");
});

test("consumeCliRun: a proposal without the matching interrupt outcome returns an exact Problem", async () => {
    const { io } = sink({ json: true });
    const events = proposalCall(9).slice(0, -1);
    const result = await consumeCliRun(stream(events), io);
    assert.equal(result.pendingResume, null);
    assert.equal(result.problem?.type, "https://problems.plurnk.dev/client/transport/interrupt-mismatch");
    assert.equal(result.problem?.logEntryId, 9);
});

test("consumeCliRun: malformed proposal arguments return an exact Problem", async () => {
    const { io } = sink({ json: true });
    const result = await consumeCliRun(stream([
        { type: EventType.TOOL_CALL_START, toolCallId: "prop:12", toolCallName: "request_approval" },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "prop:12", delta: "{" },
        { type: EventType.TOOL_CALL_END, toolCallId: "prop:12" },
    ]), io);
    assert.equal(result.problem?.type, "https://problems.plurnk.dev/client/transport/proposal-invalid");
    assert.equal(result.problem?.logEntryId, 12);
});

test("[§cli-yolo-plurnkyolo] consumeCliRun: yolo auto-accepts a proposal without review", async () => {
    let reviewed = false;
    const { io } = sink({ yolo: true, review: async () => { reviewed = true; return { decision: "accept" }; } });
    const r = await consumeCliRun(stream(proposalCall(3)), io);
    assert.equal(reviewed, false, "yolo skips review");
    assert.deepEqual(r.pendingResume, { logEntryId: 3, decision: "accept" });
});

test("[§cli-what-one-shot-mode-does-not-do] consumeCliRun: no review channel rejects the proposal (fail-closed, no hang)", async () => {
    const { io } = sink({ noReviewChannel: true });
    const r = await consumeCliRun(stream(proposalCall(4)), io);
    assert.deepEqual(r.pendingResume, { logEntryId: 4, decision: "reject" });
});

test("consumeCliRun: no tool-call → no pendingResume (server-owned proposals never reach the wire)", async () => {
    const { io } = sink();
    const r = await consumeCliRun(stream([terminated(), { type: EventType.RUN_FINISHED, threadId: "t", runId: "r", outcome: { type: "success" } }]), io);
    assert.equal(r.pendingResume, null, "a clean run carries no resume");
});

test("[§cli-channel-posture] consumeCliRun: plurnk.notice routes to the Notice sink; generic AG-UI events are ignored", async () => {
    const notices: unknown[] = [];
    const { io, out, err } = sink({ notice: (notice) => notices.push(notice) });
    await consumeCliRun(stream([
        { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "1", delta: "ignored-generic" },
        { type: EventType.CUSTOM, name: "plurnk.notice", value: { source: "engine", kind: "note", level: "info" } },
        terminated(),
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r", outcome: { type: "success" } },
    ]), io);
    assert.equal(notices.length, 1, "Notice captured");
    assert.equal(out.join(""), "", "generic TEXT_MESSAGE not rendered by the family client");
    assert.equal(err.join(""), "", "no row → no trace");
});

test("consumeCliRun: json mode stays silent + accumulates the full record", async () => {
    const { io, out, err } = sink({ json: true });
    const res = await consumeCliRun(stream([
        rowRun({ op: "PLAN", origin: "model" }, 42),
        rowRun({ op: "FIND", scheme: "file", pathname: "/x", origin: "model" }, 42),
        terminalSend("Jupiter."),
        terminated({
            workspaceId: 512,
            loopId: 9,
            turnIds: [1, 2, 3],
            usage: {
                accounting: {
                    requests: [{
                        provider: "provider:test",
                        model: "test",
                        outcome: "response",
                        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
                        cost: { kind: "unknown", reason: "provider supplied no monetary evidence" },
                    }],
                    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
                    costUsd: null,
                },
                contextTokens: 20,
                promptBudget: 6848,
                meta: {},
            },
        }),
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r", outcome: { type: "success" } },
    ]), io);
    assert.equal(out.join(""), "", "json mode: silent stdout");
    assert.equal(err.join(""), "", "json mode: silent stderr");
    assert.equal(res.exitCode, 0);
    assert.equal(res.entries.length, 3, "all rows accumulated");
    assert.equal(res.response, "Jupiter.", "terminal broadcast captured");
    assert.equal(res.modelWorkerId, 42, "modelWorkerId derived from the first model row's worker_id");
    assert.equal(res.terminated?.workspaceId, 512, "workspaceId from plurnk.terminated");
    assert.equal(res.terminated?.usage.accounting.costUsd, null, "unknown money stays unknown");
    assert.deepEqual(res.terminated?.usage.accounting.requests[0], {
        provider: "provider:test",
        model: "test",
        outcome: "response",
        usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        cost: { kind: "unknown", reason: "provider supplied no monetary evidence" },
    }, "the physical request evidence remains intact");
});

test("consumeCliRun: plurnk.terminated is authoritative for the exit code", async () => {
    const { io } = sink();
    const { exitCode } = await consumeCliRun(stream([
        terminated({
            turnIds: [],
            result: {
                status: 499,
                problem: {
                    type: "https://problems.plurnk.dev/lifecycle/cancel/loop-cancelled",
                    title: "Loop cancelled",
                    status: 499,
                    detail: "The loop was cancelled.",
                },
            },
        }),
    ]), io);
    assert.equal(exitCode, 3, "499 cancel → exit 3 (exitCodeForLoop)");
});

test("consumeCliRun: a child worker's terminal SEND cannot replace the run response", async () => {
    const { io } = sink({ json: true });
    const result = await consumeCliRun(stream([
        rowRun({ op: "SEND", signal: 200, tx: { body: { raw: "parent answer" } } }, 11),
        rowRun({ op: "SEND", signal: 499, tx: { body: { raw: "child cancelled" } } }, 12),
        terminated({ workerId: 11 }),
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r", outcome: { type: "success" } },
    ]), io);
    assert.equal(result.response, "parent answer");
});

test("consumeCliRun: plurnk.stream routes start (state) and conclusion (result) to the trace", async () => {
    const { io, err } = sink();
    await consumeCliRun(stream([
        { type: EventType.CUSTOM, name: "plurnk.stream", value: { entryId: 1, target: "python:///1/1/1", channel: "stdout", state: "active", contentLength: 5, loop_seq: 1, turn_seq: 1, sequence: 1 } },
        { type: EventType.CUSTOM, name: "plurnk.stream", value: { entryId: 1, workerId: 7, target: "python:///1/1/1", subscriptionId: 1, scheme: "python", result: { status: 200 }, summary: "done", wakeAction: "no-op-active-loop", loop_seq: 1, turn_seq: 1, sequence: 1 } },
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r", outcome: { type: "success" } },
    ]), io);
    const trace = err.join("");
    assert.match(trace, /python:\/\/\/1\/1\/1/, "stream lines traced to stderr");
    assert.match(trace, /200/, "the conclusion carries the close status");
});

test("runScript segments: a run with NO parse result must not report success", async () => {
    // consumeCliRun sees a stream that ends without plurnk.action.result — the
    // caller (runScriptViaBridge) must treat a missing parse as failure, so the
    // sink-level contract here: no onActionResult fired, pendingResume null,
    // and the CALLER-visible marker (parse missing) is testable via the sink.
    let fired = false;
    const { io } = sink({ onActionResult: () => { fired = true; } });
    const r = await consumeCliRun(stream([{ type: EventType.RUN_FINISHED, threadId: "t", runId: "r", outcome: { type: "success" } }]), io);
    assert.equal(fired, false);
    assert.equal(r.pendingResume, null);
});
