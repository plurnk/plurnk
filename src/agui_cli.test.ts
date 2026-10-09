// Unit tests for the CLI's AG-UI consumer. Scripted AG-UI events + capturing
// sinks — no daemon. Asserts the family-client rendering (plurnk.row →
// trace/answer), proposal settlement through AG-UI resumes, and the exit code
// from RUN_FINISHED/RUN_ERROR.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventType } from "@ag-ui/core";
import { consumeCliRun, exitCodeForExec, settleExec, type CliRunSinks } from "./agui_cli.ts";
import type { AguiEvent } from "./agui.ts";
import type { LogEntryWire } from "./render.ts";
import type { Resolution } from "./proposal.ts";
import ToolAcceptance from "./tool-acceptance.ts";

const entry = (o: Partial<LogEntryWire> = {}): LogEntryWire => ({
    id: 1, op: "READ", origin: "model", signal: null,
    loop_seq: 1, turn_seq: 1, sequence: 1,
    scheme: null, pathname: null, hostname: null, fragment: null,
    lineMarker: null, status_rx: 200, tx: null,
    rx: o.op === "SEND" && o.scheme == null ? { answers: [] } : null, tags: [], ...o,
});

const row = (e: Partial<LogEntryWire>): AguiEvent => ({ type: EventType.CUSTOM, name: "plurnk.row", value: entry(e) });
const workerRow = (e: Partial<LogEntryWire>, workerId: number): AguiEvent => ({ type: EventType.CUSTOM, name: "plurnk.row", value: { ...entry(e), worker_id: workerId } });
// A whole status gauge as the daemon sends it; each specimen overrides what it is about.
const STATUS = { waitUntil: null, preparation: [], children: 0, descendants: { requests: 0, usage: null, knownUsage: null, costUsd: null, knownCostUsd: null } };
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
    curationWeight: 20,
    curationBudget: 6848,
    contextTokens: 10,
    contextCapacity: 65536,
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
        acceptance: new ToolAcceptance(() => {}),
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
        // it is a dead stream (502) — the fixture matches the protocol.
        { type: EventType.CUSTOM, name: "plurnk.terminated", value: { workspaceId: 1, loopId: 1, hitMaxTurns: false, turnIds: [1], result: { status: 200 } } },
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" },
    ]), io);
    assert.equal(exitCode, 0);
    assert.equal(out.join(""), "Jupiter is the largest planet.\n", "only the answer on stdout");
    assert.ok(err.length >= 2, "every row traced to stderr");
});

test("[§cli-provider-reasoning] consumeCliRun: standard readable reasoning renders once before its paired SEND trace", async () => {
    const { io, out, err } = sink();
    await consumeCliRun(stream([
        { type: EventType.REASONING_START, messageId: "1/1/2/SEND/reasoning" },
        { type: EventType.REASONING_MESSAGE_START, messageId: "1/1/2/SEND/reasoning", role: "reasoning" },
        { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "1/1/2/SEND/reasoning", delta: "compare " },
        { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "1/1/2/SEND/reasoning", delta: "the evidence" },
        { type: EventType.REASONING_MESSAGE_END, messageId: "1/1/2/SEND/reasoning" },
        { type: EventType.REASONING_END, messageId: "1/1/2/SEND/reasoning" },
        terminalSend("Jupiter."),
        terminated(),
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r", outcome: { type: "success" } },
    ]), io);
    assert.equal(out.join(""), "Jupiter.\n");
    assert.deepEqual(err.slice(0, 3), ["💭 compare ", "the evidence", "\n"], "reasoning deltas reach stderr before completion");
    const trace = err.join("");
    assert.match(trace, /💭 compare the evidence/);
    assert.ok(trace.indexOf("💭") < trace.indexOf("SEND"), "reasoning precedes the SEND row");
});

test("[§cli-provider-reasoning] multiline reasoning preserves indentation across delta boundaries", async () => {
    const { io, err } = sink();
    await consumeCliRun(stream([
        { type: EventType.REASONING_MESSAGE_START, messageId: "reasoning-2", role: "reasoning" },
        { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "reasoning-2", delta: "first\n" },
        { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "reasoning-2", delta: "second\nthird\n" },
        { type: EventType.REASONING_MESSAGE_END, messageId: "reasoning-2" },
        terminated(),
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r", outcome: { type: "success" } },
    ]), io);
    assert.equal(err.slice(0, 2).join(""), "💭 first\n   second\n   third\n");
});

test("consumeCliRun: RUN_ERROR without the exact Problem is a transport contract failure", async () => {
    const { io, err } = sink();
    const result = await consumeCliRun(stream([
        { type: EventType.RUN_ERROR, message: "loop terminated 429 (maxTurns)", code: "429" },
    ]), io);
    assert.equal(result.exitCode, 4);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/client/transport/problem-missing");
    assert.match(err.join(""), /required Problem Details/);
    assert.doesNotMatch(err.join(""), /maxTurns/, "the client does not reconstruct failure truth from lossy RUN_ERROR fields");
});

test("[§cli-log-entry-line-format] the AG-UI CLI trace displays a server's tool failure explanation", async () => {
    const { io, err, out } = sink();
    const result = await consumeCliRun(stream([
        row({ op: "brave", tx: { runtime: "brave", target: { kind: "local", raw: "brave_web_search" } },
            attrs: { stream: "brave:///0c0ffee1" }, rx: { status: 200, outcome: "started" } }),
        { type: EventType.CUSTOM, name: "plurnk.stream", value: {
            entryId: 1, workerId: 11, subscriptionId: 1, scheme: "brave", target: "brave:///0c0ffee1",
            result: { status: 502, problem: { type: "https://problems.plurnk.xyz/executor/mcp/tool-reported-error",
                title: "Tool reported error", status: 502, detail: "The MCP tool reported an error.", diagnostic: "No web results found" } },
            summary: "", wakeAction: "no-op-active-loop",
        } },
        terminalSend("The search returned no results."), terminated(),
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" },
    ]), io);
    assert.match(err.join(""), /brave \(brave:\/\/\/0c0ffee1\) — Tool reported error: No web results found/);
    assert.equal(out.join(""), "The search returned no results.\n", "diagnostics stay out of the answer channel");
    assert.equal(result.exitCode, 0, "a recovered tool failure does not rewrite the loop's result");
});

test("consumeCliRun: plurnk.problem preserves the terminal failure that RUN_ERROR cannot encode", async () => {
    const problem = {
        type: "https://problems.plurnk.xyz/engine/rails/strike-threshold",
        title: "Strike threshold",
        status: 500,
        detail: "The loop reached its strike threshold after 3 model turns because consecutive turns failed.",
        turns: 3,
        stage: "loop",
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
    assert.deepEqual(r.pendingResume, { interruptId: "prop:9", status: "resolved", payload: { decision: "accept", body: "edited" } }, "the resume tool-result carries the reviewed decision");
});

test("consumeCliRun: a proposal without the matching interrupt outcome returns an exact Problem", async () => {
    const { io } = sink({ json: true });
    const events = proposalCall(9).slice(0, -1);
    const result = await consumeCliRun(stream(events), io);
    assert.equal(result.pendingResume, null);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/client/transport/interrupt-mismatch");
    assert.equal(result.problem?.interruptId, "prop:9");
});

test("consumeCliRun: malformed proposal arguments return an exact Problem", async () => {
    const { io } = sink({ json: true });
    const result = await consumeCliRun(stream([
        { type: EventType.TOOL_CALL_START, toolCallId: "prop:12", toolCallName: "request_approval" },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "prop:12", delta: "{" },
        { type: EventType.TOOL_CALL_END, toolCallId: "prop:12" },
    ]), io);
    assert.equal(result.problem?.type, "https://problems.plurnk.xyz/client/transport/proposal-invalid");
    assert.equal(result.problem?.logEntryId, 12);
});

test("[§cli-yolo-plurnkyolo] consumeCliRun: yolo auto-accepts a proposal without review", async () => {
    let reviewed = false;
    const { io } = sink({ yolo: true, review: async () => { reviewed = true; return { decision: "accept" }; } });
    const r = await consumeCliRun(stream(proposalCall(3)), io);
    assert.equal(reviewed, false, "yolo skips review");
    assert.deepEqual(r.pendingResume, { interruptId: "prop:3", status: "resolved", payload: { decision: "accept", outcome: "client_yolo" } });
});

test("{§cli-tool-acceptance} configured tools accept through ordinary resumes while unmatched tools reject without a terminal", async (t) => {
    const original = process.env;
    process.env = { ...original, PLURNK_CLIENT_ACCEPT_brave: "1", PLURNK_CLIENT_ACCEPT_brave_TOOLS: '["brave_web_search"]' };
    t.after(() => { process.env = original; });
    for (const [op, tool, decision, outcome] of [
        ["brave", "brave_web_search", "accept", "auto: brave (brave_web_search)"],
        ["brave", "brave_other_search", "reject", "client_no_review_channel"],
        ["other", "brave_web_search", "reject", "client_no_review_channel"],
    ]) {
        const { io } = sink({ noReviewChannel: true, review: async () => { throw new Error("no reviewer is available"); } });
        const result = await consumeCliRun(stream(proposalCall(5, {
            op, target: { scheme: null, pathname: tool }, attrs: { runtime: op, target: tool },
        })), io);
        assert.deepEqual(result.pendingResume, { interruptId: "prop:5", status: "resolved", payload: { decision, outcome } });
    }
});

test("[§cli-fail-closed-no-review-channel] consumeCliRun: no review channel rejects the proposal (fail-closed, no hang)", async () => {
    const { io } = sink({ noReviewChannel: true });
    const r = await consumeCliRun(stream(proposalCall(4)), io);
    assert.deepEqual(r.pendingResume, { interruptId: "prop:4", status: "resolved", payload: { decision: "reject", outcome: "client_no_review_channel" } });
});

test("consumeCliRun: no tool-call → no pendingResume (server-owned proposals never reach the wire)", async () => {
    const { io } = sink();
    const r = await consumeCliRun(stream([terminated(), { type: EventType.RUN_FINISHED, threadId: "t", runId: "r", outcome: { type: "success" } }]), io);
    assert.equal(r.pendingResume, null, "a clean run carries no resume");
});

test("consumeCliRun: one-shot input requests return ordinary cancelled resumes, without changing workspace permissions", async () => {
    const { io } = sink({ noReviewChannel: true, yolo: true });
    const r = await consumeCliRun(stream([
        { type: EventType.TOOL_CALL_START, toolCallId: "int:8", toolCallName: "question" },
        { type: EventType.TOOL_CALL_ARGS, toolCallId: "int:8", delta: '{"message":"Which branch?"}' },
        { type: EventType.TOOL_CALL_END, toolCallId: "int:8" },
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r", outcome: { type: "interrupt", interrupts: [
            { id: "int:8", toolCallId: "int:8", reason: "tool_call" },
        ] } },
    ]), io);
    assert.deepEqual(r.pendingResume, { interruptId: "int:8", status: "cancelled" });
    assert.equal(r.problem, null, "a supported interruption is not a missing terminal outcome");
});

const outside = (text: string): AguiEvent => ({ type: EventType.CUSTOM, name: "plurnk.outside", value: { coordinate: "alice-1-2", text, tokens: 7 } });

test("[§cli-outside-text] consumeCliRun: plurnk.outside is trace on stderr, never the answer on stdout", async () => {
    const { io, out, err } = sink();
    const result = await consumeCliRun(stream([
        outside("Thinking aloud **outside** the fences."),
        terminalSend("Jupiter is the largest planet."),
        terminated(),
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r", outcome: { type: "success" } },
    ]), io);
    assert.equal(out.join(""), "Jupiter is the largest planet.\n", "stdout carries only the delivered answer");
    assert.equal(err.join(""), "Thinking aloud **outside** the fences.\n[200] model SEND\n", "stderr traces the outside text verbatim, then the rows");
    assert.equal(result.response, "Jupiter is the largest planet.", "response accounting is the delivered SEND's alone");
});

test("[§cli-outside-text] consumeCliRun --json: plurnk.outside is silent and absent from the run record's response", async () => {
    const { io, out, err } = sink({ json: true });
    const result = await consumeCliRun(stream([
        outside("Thinking aloud outside the fences."),
        terminalSend("Jupiter is the largest planet."),
        terminated(),
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r", outcome: { type: "success" } },
    ]), io);
    assert.equal(out.join(""), "", "json mode writes nothing during the run");
    assert.equal(err.join(""), "", "json mode traces nothing");
    assert.equal(result.response, "Jupiter is the largest planet.", "the record's response excludes the outside text");
    assert.deepEqual(result.entries.map((entry) => entry.op), ["SEND"], "outside text is not an entry");
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

test("consumeCliRun: indexing state is quiet and indexing failures remain diagnostics", async () => {
    const progress: unknown[] = [];
    const notices: unknown[] = [];
    const { io } = sink({
        onStatus: (status) => progress.push(status.activity),
        notice: (notice) => notices.push(notice),
    });
    await consumeCliRun(stream([
        { type: EventType.STATE_SNAPSHOT, snapshot: {
            plurnk: { status: { ...STATUS, lifecycle: "running", model: null, loopId: 1, packetCount: 0,
                activity: { kind: "derivation", phase: "indexing", completed: 3, total: 10, percent: 30 } } }, budget: {},
        } },
        { type: EventType.STATE_DELTA, delta: [{ op: "replace", path: "/plurnk/status/activity", value: null }] },
        { type: EventType.CUSTOM, name: "plurnk.notice", value: {
            source: "engine:derivation", kind: "search_progress", level: "error", phase: "failed",
            message: "Search indexing failed: SQLite database is locked",
        } },
        terminated(),
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r", outcome: { type: "success" } },
    ]), io);
    assert.deepEqual(progress, [{ label: "indexing", percent: 30 }, null]);
    assert.deepEqual(notices, [{
        source: "engine:derivation", kind: "search_progress", level: "error", phase: "failed",
        message: "Search indexing failed: SQLite database is locked",
    }], "only the explicit failure enters the transcript");
});

test("[§cli-status-preparation] snapshots, progress, and clearing stay in status, not the transcript", async () => {
    const preparations: unknown[] = [];
    const { io, out, err } = sink({ onStatus: (status) => preparations.push(status.preparation) });
    const preparation = [{ family: "mcp", alias: "search", phase: "preparing", since: new Date(1000).toISOString() }];
    await consumeCliRun(stream([
        { type: EventType.STATE_SNAPSHOT, snapshot: { plurnk: { status: {
            ...STATUS, lifecycle: "queued", model: null, loopId: 1, packetCount: 0, activity: null, preparation,
        } }, budget: {} } },
        { type: EventType.STATE_DELTA, delta: [{ op: "replace", path: "/plurnk/status/preparation", value: [] }] },
        terminated(),
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r", outcome: { type: "success" } },
    ]), io);
    assert.deepEqual(preparations, [preparation, []]);
    assert.equal(out.join(""), "");
    assert.equal(err.join(""), "");
});

test("[§cli-status-project-root] consumeCliRun projects the authoritative gauge and bound folder", async () => {
    const statuses: unknown[] = [];
    const { io } = sink({ onStatus: (status) => statuses.push(status) });
    await consumeCliRun(stream([
        {
            type: EventType.STATE_SNAPSHOT,
            snapshot: {
                plurnk: {
                    workspace: { id: 1, name: "work", projectRoot: "/projects/client" },
                    status: { ...STATUS, lifecycle: "running", model: { alias: "deepdumb", provider: "deepseek", model: "deepseek-v4-flash" }, loopId: 7, packetCount: 0, activity: null },
                },
                budget: {},
            },
        },
        { type: EventType.STATE_DELTA, delta: [{ op: "replace", path: "/plurnk/status/packetCount", value: 3 }] },
        terminated(),
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r", outcome: { type: "success" } },
    ]), io);
    assert.deepEqual(statuses, [
        { lifecycle: "running", model: "deepdumb", loopId: 7, packetCount: 0, activity: null, children: 0, waitUntil: null, preparation: [], descendants: null, projectRoot: "/projects/client" },
        { lifecycle: "running", model: "deepdumb", loopId: 7, packetCount: 3, activity: null, children: 0, waitUntil: null, preparation: [], descendants: null, projectRoot: "/projects/client" },
    ]);
});

test("consumeCliRun: json mode stays silent + accumulates the full record", async () => {
    const { io, out, err } = sink({ json: true });
    const res = await consumeCliRun(stream([
        workerRow({ op: "NOTE", origin: "model", tx: { body: "Find evidence" } }, 42),
        workerRow({ op: "FIND", scheme: "file", pathname: "/x", origin: "model" }, 42),
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
                curationWeight: 40,
                curationBudget: 6848,
                contextTokens: 20,
                contextCapacity: 65536,
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
                    type: "https://problems.plurnk.xyz/lifecycle/cancel/loop-cancelled",
                    title: "Loop cancelled",
                    status: 499,
                    detail: "The loop was cancelled.",
                },
            },
        }),
    ]), io);
    assert.equal(exitCode, 3, "499 cancel → exit 3 (exitCodeForLoop)");
});

test("consumeCliRun: a child worker's SEND cannot duplicate or replace the run response", async () => {
    const { io, out } = sink();
    const result = await consumeCliRun(stream([
        workerRow({ op: "SEND", signal: 200, tx: { body: { raw: "parent answer" } } }, 11),
        workerRow({ op: "SEND", signal: null, tx: { body: { raw: "child cancelled" } } }, 12),
        terminated({ workerId: 11 }),
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r", outcome: { type: "success" } },
    ]), io);
    assert.equal(result.response, "parent answer");
    assert.equal(out.join(""), "parent answer\n", "a foreign message must not repeat the parent's output");
});

for (const json of [false, true]) test(`consumeCliRun: ordered response messages survive failure (json=${json})`, async () => {
    const { io, out } = sink({ json });
    const result = await consumeCliRun(stream([
        workerRow({ id: 10, op: "SEND", tx: { body: { raw: "First." } } }, 11),
        workerRow({ id: 11, op: "SEND", scheme: "worker", pathname: "/", hostname: "child", tx: { body: { raw: "Instructions." } } }, 11),
        workerRow({ id: 12, op: "SEND", status_rx: 400, tx: { body: { raw: "Undelivered." } } }, 11),
        workerRow({ id: 13, op: "SEND", tx: { body: { raw: "Second." } } }, 11),
        workerRow({ id: 14, op: "SEND", status_rx: 200, tx: { body: { raw: "Verification failed." } }, rx: { status: 200, answers: [] } }, 11),
        terminated({ workerId: 11, result: { status: 499, problem: {
            type: "https://problems.plurnk.xyz/lifecycle/failed", title: "Task failed", status: 499, detail: "Verification failed.",
        } } }),
    ]), io);
    assert.equal(result.response, "First.\n\nSecond.\n\nVerification failed.");
    assert.equal(result.terminated?.result.status, 499);
    assert.equal(result.exitCode, 3);
    assert.equal(out.join(""), json ? "" : "First.\n\nSecond.\n\nVerification failed.\n");
});

test("consumeCliRun: exact and foreign-worker replies reach stdout only for this conversation", async () => {
    const { io, out } = sink();
    const receipt = (thread: string) => ({ answers: [`agui://anonymous/threads/${thread}/messages/m1`] });
    const result = await consumeCliRun(stream([
        { type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
        workerRow({ op: "SEND", scheme: "agui", pathname: "/threads/t/messages/m1", tx: { body: { raw: "Direct answer." } }, rx: receipt("t") }, 11),
        workerRow({ op: "SEND", origin: "_plurnk", source: "worker://peer", attrs: { kind: "reply" }, tx: { body: { raw: "Peer answer." } }, rx: receipt("t") }, 11),
        workerRow({ op: "SEND", tx: { body: { raw: "Other conversation." } }, rx: receipt("other") }, 11),
        workerRow({ op: "SEND", tx: { body: { raw: "Peer work." } }, rx: { answers: ["worker://peer/?message=abcdef01"] } }, 11),
        terminated({ workerId: 11 }),
    ]), io);
    assert.equal(result.response, "Direct answer.\n\nPeer answer.");
    assert.equal(out.join(""), "Direct answer.\n\nPeer answer.\n");
});

test("consumeCliRun: plurnk.stream routes start (state) and conclusion (result) to the trace", async () => {
    const { io, err } = sink();
    await consumeCliRun(stream([
        { type: EventType.CUSTOM, name: "plurnk.stream", value: { entryId: 1, target: "python:///0c0ffee1", channel: "stdout", state: "active", contentLength: 5, loop_seq: 1, turn_seq: 1, sequence: 1 } },
        { type: EventType.CUSTOM, name: "plurnk.stream", value: { entryId: 1, workerId: 7, target: "python:///0c0ffee1", subscriptionId: 1, scheme: "python", result: { status: 200 }, summary: "done", wakeAction: "no-op-active-loop", loop_seq: 1, turn_seq: 1, sequence: 1 } },
        { type: EventType.RUN_FINISHED, threadId: "t", runId: "r", outcome: { type: "success" } },
    ]), io);
    const trace = err.join("").replace(/\x1b\[[0-9;]*m/g, "");   // the row is styled; the assertion is about its words
    assert.match(trace, /python:\/\/\/0c0ffee1/, "stream lines traced to stderr");
    assert.doesNotMatch(trace, /(?:^|\s)200(?:\s|$)/, "a routine conclusion carries no code (plurnk#21)");
    assert.match(trace, /python \(python:\/\/\/0c0ffee1\)/, "the conclusion traces as the stream in the operation grammar");
});

test("runScript segments: a run with NO parse result must not report success", async () => {
    // consumeCliRun sees a stream that ends without plurnk.action.result — the
    // caller (runScriptViaAgui) must treat a missing parse as failure, so the
    // sink-level contract here: no onActionResult fired, pendingResume null,
    // and the CALLER-visible marker (parse missing) is testable via the sink.
    let fired = false;
    const { io } = sink({ onActionResult: () => { fired = true; } });
    const r = await consumeCliRun(stream([{ type: EventType.RUN_FINISHED, threadId: "t", runId: "r", outcome: { type: "success" } }]), io);
    assert.equal(fired, false);
    assert.equal(r.pendingResume, null);
});

// A `! command`'s op.exec Run, as the daemon delivers it ({§agui-broadcast-fan}).
const execConclusion = (target: string, status = 200) => ({
    entryId: 52, workerId: 7, target, subscriptionId: 1, scheme: "sh", loop_seq: 1, turn_seq: 1, sequence: 1,
    result: status === 200
        ? { status, exitCode: 0 }
        : { status, exitCode: 3, problem: { type: "https://problems.plurnk.xyz/executor/subprocess/nonzero-exit", title: "Nonzero exit", status, detail: "'sh' exited with code 3." } },
    summary: `${target} completed`, wakeAction: "no-loop",
});
const execAdmitted = { kind: "op.exec", ok: true, result: { status: 200, outcome: "client_yolo" } } as const;

test("[§cli-prompt-prefixes] consumeCliRun: rows and stream conclusions reach their hooks in either output mode", async () => {
    for (const json of [false, true]) {
        const rows: number[] = [];
        const concluded: string[] = [];
        const { io } = sink({ json, onRow: (e) => rows.push(e.id), onStreamConcluded: (c) => concluded.push(c.target) });
        await consumeCliRun(stream([
            row({ id: 58, op: "sh", origin: "client", attrs: { stream: "sh:///4d0f8d50" } }),
            { type: EventType.CUSTOM, name: "plurnk.stream", value: { entryId: 52, workerId: 7, target: "sh:///4d0f8d50", channel: "stdout", state: "closed", contentLength: 3 } },
            { type: EventType.CUSTOM, name: "plurnk.stream", value: execConclusion("sh:///4d0f8d50") },
            { type: EventType.CUSTOM, name: "plurnk.action.result", value: execAdmitted },
            { type: EventType.RUN_FINISHED, threadId: "t", runId: "r", outcome: { type: "success" } },
        ]), io);
        assert.deepEqual(rows, [58], `json=${json}`);
        assert.deepEqual(concluded, ["sh:///4d0f8d50"], `a channel event is not a conclusion (json=${json})`);
    }
});

test("[§cli-prompt-prefixes] a `! command` exits by its execution's conclusion: 200 → 0, 499 → 3, anything else → 4", () => {
    assert.deepEqual([200, 499, 500, 404, 202].map(exitCodeForExec), [0, 3, 4, 4, 4]);
});

test("[§cli-prompt-prefixes] settleExec: a refusal is the action's Problem; an admitted execution settles with its own stream's conclusion", () => {
    const refusal = { type: "https://problems.plurnk.xyz/proposal/rejected", title: "Rejected", status: 400, detail: "The proposal was rejected (client_no_review_channel)." };
    const mine = execConclusion("sh:///mine", 500);
    const other = execConclusion("sh:///other");
    const conclusions = new Map([[other.target, other], [mine.target, mine]]);
    assert.deepEqual(
        settleExec({ result: { kind: "op.exec", ok: false, problem: refusal }, stream: "sh:///mine", conclusions, problem: null }),
        { problem: refusal },
        "the daemon refused the execution; a conclusion cannot outrank that",
    );
    assert.deepEqual(
        settleExec({ result: execAdmitted, stream: "sh:///mine", conclusions, problem: null }),
        { conclusion: mine },
        "the conclusion of the stream the started row announced, never another's",
    );
});

test("[§cli-prompt-prefixes] settleExec: without its stream's conclusion the Run failed, with its own Problem when it reported one", () => {
    const type = (settled: ReturnType<typeof settleExec>): string => "problem" in settled ? settled.problem.type : "concluded";
    const other = execConclusion("sh:///other");
    const conclusions = new Map([[other.target, other]]);
    assert.equal(type(settleExec({ result: execAdmitted, stream: "sh:///mine", conclusions, problem: null })),
        "https://problems.plurnk.xyz/client/transport/terminal-missing", "the Run finished before its stream concluded");
    assert.equal(type(settleExec({ result: execAdmitted, stream: null, conclusions, problem: null })),
        "https://problems.plurnk.xyz/client/transport/terminal-missing", "no started row announced a stream");
    assert.equal(type(settleExec({ result: null, stream: null, conclusions: new Map(), problem: null })),
        "https://problems.plurnk.xyz/client/action/result-missing");
    const broken = { type: "https://problems.plurnk.xyz/client/transport/problem-missing", title: "Problem missing", status: 502, detail: "The AG-UI stream reported a failed run without its required Problem Details." };
    assert.deepEqual(settleExec({ result: null, stream: null, conclusions: new Map(), problem: broken }), { problem: broken });
});
