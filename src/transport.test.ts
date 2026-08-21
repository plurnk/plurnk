// Unit tests for the transport seam. WsTransport against a fake Rpc (persistent
// forwarding + loopId-keyed done); BridgeTransport against a mock SSE bridge
// (un-projection + done from plurnk.terminated). No live daemon.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BridgeTransport, type RunHandlers } from "./transport.ts";
import { ProblemError } from "./diagnostics.ts";

const collectingHandlers = () => {
    const seen: { entries: unknown[]; reasoning: unknown[]; proposals: unknown[]; streams: unknown[]; notices: unknown[]; problems: unknown[]; branches: unknown[]; terminated: unknown[] } = { entries: [], reasoning: [], proposals: [], streams: [], notices: [], problems: [], branches: [], terminated: [] };
    const h: RunHandlers = {
        onEntry: (e) => seen.entries.push(e),
        onReasoning: (reasoning) => seen.reasoning.push(reasoning),
        onProposal: (p) => seen.proposals.push(p),
        onStream: (s) => seen.streams.push(s),
        onNotice: (notice) => seen.notices.push(notice),
        onProblem: (problem) => seen.problems.push(problem),
        onBranchBatch: (event) => seen.branches.push(event),
        onTerminated: (t) => seen.terminated.push(t),
    };
    return { h, seen };
};

// ── BridgeTransport ──────────────────────────────────────────────────

const bootMock = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
    const captured: Array<{ url: string | undefined; body: unknown }> = [];
    const server = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => { captured.push({ url: req.url, body: body.length > 0 ? JSON.parse(body) : null }); handler(req, res); });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}`, captured, close: () => new Promise<void>((r) => server.close(() => r())) };
};
const frame = (event: Record<string, unknown>): string => {
    const lifecycle = event.type === "RUN_STARTED" || event.type === "RUN_FINISHED"
        ? { threadId: "th", runId: "r", ...event }
        : event;
    return `data: ${JSON.stringify(lifecycle)}\n\n`;
};

test("[§cli-conformance] BridgeTransport: run() un-projects plurnk.* to daemon shapes; done resolves from plurnk.terminated", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "generic", delta: "generic-ignored" }));
        res.write(frame({ type: "REASONING_START", messageId: "1/1/2/SEND/reasoning" }));
        res.write(frame({ type: "REASONING_MESSAGE_START", messageId: "1/1/2/SEND/reasoning", role: "reasoning" }));
        res.write(frame({ type: "REASONING_MESSAGE_CONTENT", messageId: "1/1/2/SEND/reasoning", delta: "checked " }));
        res.write(frame({ type: "REASONING_MESSAGE_CONTENT", messageId: "1/1/2/SEND/reasoning", delta: "the evidence" }));
        res.write(frame({ type: "REASONING_MESSAGE_END", messageId: "1/1/2/SEND/reasoning" }));
        res.write(frame({ type: "REASONING_END", messageId: "1/1/2/SEND/reasoning" }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.row", value: { id: 5, op: "PLAN" } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.stream", value: { entryId: 2, state: "active" } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.notice", value: { source: "grammar", kind: "parse_advisory", level: "warn" } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.branch_batch", value: { batchId: 9, state: "running", branch: "feature/x", completed: 1, total: 2 } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { workspaceId: 7, loopId: 3, hitMaxTurns: false, turnIds: [1], result: { status: 200 } } }));
        res.write(frame({ type: "RUN_FINISHED" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th", { projectRoot: "/proj", constraints: [{ effect: "pick", glob: "src/**" }], settings: { questions: true } });
        const { h, seen } = collectingHandlers();
        bt.subscribe(h);
        const t = await bt.run("largest planet?", { alias: "opus" }).done;
        assert.deepEqual(seen.entries, [{ id: 5, op: "PLAN" }]);
        assert.deepEqual(seen.reasoning, [{ messageId: "1/1/2/SEND/reasoning", content: "checked the evidence" }]);
        assert.equal((seen.notices[0] as { source: string }).source, "grammar");
        assert.deepEqual(seen.branches, [{ batchId: 9, state: "running", branch: "feature/x", completed: 1, total: 2 }]);
        assert.equal(seen.entries.length, 1, "the generic TEXT_MESSAGE was ignored");
        assert.equal(t.workspaceId, 7, "done resolves with the terminated outcome incl. workspaceId");
        assert.deepEqual((mock.captured[0].body as { forwardedProps: unknown }).forwardedProps, { plurnk: { workspace: "th", projectRoot: "/proj", constraints: [{ effect: "pick", glob: "src/**" }], settings: { questions: true }, alias: "opus" } }, "the workspace (world) + options + per-run knobs ride the first run's forwardedProps");
    } finally { await mock.close(); }
});

test("BridgeTransport: plurnk.problem supplies the exact terminal status instead of parsing RUN_ERROR.code", async () => {
    const problem = {
        type: "https://problems.plurnk.dev/engine/rails/max-turns",
        title: "Max turns",
        status: 429,
        detail: "The configured turn ceiling is exhausted.",
        maximumTurns: 8,
        retryable: false,
    };
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "CUSTOM", name: "plurnk.problem", value: problem }));
        res.write(frame({ type: "RUN_ERROR", message: problem.detail, code: problem.type }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        const { h, seen } = collectingHandlers();
        bt.subscribe(h);
        const result = await bt.run("go", {}).done;
        assert.equal(result.finalStatus, 429);
        assert.deepEqual(seen.problems, [problem]);
    } finally { await mock.close(); }
});

test("BridgeTransport: RUN_ERROR without the exact Problem returns a client contract Problem", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "RUN_ERROR", message: "loop terminated 429", code: "429" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        const { h } = collectingHandlers();
        bt.subscribe(h);
        const result = await bt.run("go", {}).done;
        assert.equal(result.finalStatus, 502);
        assert.equal(result.result.problem?.type, "https://problems.plurnk.dev/client/transport/problem-missing");
    } finally { await mock.close(); }
});

test("BridgeTransport: plurnk.terminated.result is the ordinary terminal truth", async () => {
    const problem = {
        type: "https://problems.plurnk.dev/lifecycle/cancel/loop-cancelled",
        title: "Loop cancelled",
        status: 499,
        detail: "The loop was cancelled.",
        retryable: false,
    };
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({
            type: "CUSTOM",
            name: "plurnk.terminated",
            value: {
                workspaceId: 7,
                loopId: 3,
                hitMaxTurns: false,
                turnIds: [1],
                result: { status: problem.status, problem },
            },
        }));
        res.write(frame({ type: "RUN_ERROR", message: problem.detail, code: problem.type }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        const { h, seen } = collectingHandlers();
        bt.subscribe(h);
        const result = await bt.run("go", {}).done;
        assert.equal(result.finalStatus, 499);
        assert.deepEqual(result.result, { status: 499, problem });
        assert.deepEqual(seen.problems, [problem]);
    } finally { await mock.close(); }
});

test("BridgeTransport.rpc: an action failure throws its exact Problem", async () => {
    const problem = {
        type: "https://problems.plurnk.dev/agui/action/unknown-action",
        title: "Unknown action",
        status: 404,
        detail: "Unknown action 'missing'.",
        retryable: false,
    };
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: "missing", ok: false, problem } }));
        res.write(frame({ type: "RUN_FINISHED" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        await assert.rejects(
            () => bt.rpc("missing"),
            (error: unknown) => error instanceof ProblemError && error.problem.type === problem.type,
        );
    } finally { await mock.close(); }
});

test("BridgeTransport.rpc: a proposal-gated action resumes and returns its result", async () => {
    let call = 0;
    const mock = await bootMock((_req, res) => {
        call += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (call === 1) {
            res.write(frame({ type: "TOOL_CALL_START", toolCallId: "prop:42", toolCallName: "request_approval" }));
            res.write(frame({ type: "TOOL_CALL_ARGS", toolCallId: "prop:42", delta: JSON.stringify({ op: "EXEC", target: null, body: "printf done" }) }));
            res.write(frame({ type: "TOOL_CALL_END", toolCallId: "prop:42" }));
            res.write(frame({ type: "RUN_FINISHED", outcome: { type: "interrupt", interrupts: [{ id: "prop:42", reason: "tool_call", toolCallId: "prop:42" }] } }));
        } else {
            res.write(frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: "op.exec", ok: true, result: { status: 200 } } }));
            res.write(frame({ type: "RUN_FINISHED" }));
        }
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        const { h, seen } = collectingHandlers();
        bt.subscribe({
            ...h,
            onProposal: (proposal) => {
                seen.proposals.push(proposal);
                void bt.resolve({ logEntryId: proposal.logEntryId, decision: "accept", outcome: "client_yolo" });
            },
        });
        assert.deepEqual(await bt.rpc("op.exec", { command: "printf done" }), { status: 200 });
        assert.equal(seen.proposals.length, 1);
        assert.equal(call, 2);
        const resume = mock.captured[1].body as { resume: Array<{ interruptId: string; status: string; payload: unknown }> };
        assert.deepEqual(resume.resume, [{ interruptId: "prop:42", status: "resolved", payload: { decision: "accept" } }]);
    } finally { await mock.close(); }
});

test("BridgeTransport.rpc: an action stream without a result or interrupt fails explicitly", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "RUN_FINISHED" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        await assert.rejects(
            () => bt.rpc("op.exec", { command: "printf done" }),
            (error: unknown) => error instanceof ProblemError
                && error.problem.type === "https://problems.plurnk.dev/client/action/result-missing",
        );
    } finally { await mock.close(); }
});

test("BridgeTransport: inject + rpc ride §3 action runs (AG-UI+ — no /plurnk/rpc side-channel)", async () => {
    const mock = await bootMock((req, res) => {
        // An action run answers on its own SSE: result custom + RUN_FINISHED.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: "x", ok: true, result: { action: "injected_next_turn", loopId: 7 } } }));
        res.write(frame({ type: "RUN_FINISHED" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        await bt.inject("steer mid-run");
        const providers = await bt.rpc<{ action: string }>("providers.list");
        assert.equal(providers.action, "injected_next_turn", "the action result returns verbatim");
        const injectRun = mock.captured.find((c) => c.url === "/" && (c.body as { forwardedProps?: { plurnk?: { action?: { kind: string } } } }).forwardedProps?.plurnk?.action?.kind === "loop.inject");
        assert.ok(injectRun !== undefined, "inject rides an action run");
        assert.deepEqual((injectRun?.body as { forwardedProps: { plurnk: { action: unknown } } }).forwardedProps.plurnk.action, { kind: "loop.inject", prompt: "steer mid-run" });
        const rpcRun = mock.captured.find((c) => (c.body as { forwardedProps?: { plurnk?: { action?: { kind: string } } } })?.forwardedProps?.plurnk?.action?.kind === "providers.list");
        assert.ok(rpcRun !== undefined, "verbs ride action runs");
    } finally { await mock.close(); }
});

test("[§cli-cancellation] BridgeTransport: cancel() aborts the SSE and done resolves (499), not a throw", async () => {
    const mock = await bootMock((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(frame({ type: "RUN_STARTED" })); });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        bt.subscribe(collectingHandlers().h);
        const handle = bt.run("go", {});
        await new Promise((r) => setTimeout(r, 50));
        handle.cancel();
        assert.equal((await handle.done).finalStatus, 499, "cancel → clean 499 outcome");
    } finally { await mock.close(); }
});

test("BridgeTransport.useSession: re-maps the threadId — the next run addresses the new workspace", async () => {
    const mock = await bootMock((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { hitMaxTurns: false, result: { status: 200 } } })); res.write(frame({ type: "RUN_FINISHED" })); res.end(); });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "old");
        const s = await bt.useSession("new-thread", {});
        assert.equal(s.name, "new-thread");
        bt.subscribe(collectingHandlers().h);
        await bt.run("go", {}).done;
        assert.equal((mock.captured[0].body as { threadId: string }).threadId, "new-thread", "the run targets the re-mapped thread");
    } finally { await mock.close(); }
});

test("BridgeTransport: terminate-resume — a proposal tool-call pauses done; resolve() resumes with the tool-result", async () => {
    let call = 0;
    const mock = await bootMock((_req, res) => {
        call += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (call === 1) {
            res.write(frame({ type: "TOOL_CALL_START", toolCallId: "prop:42", toolCallName: "request_approval" }));
            res.write(frame({ type: "TOOL_CALL_ARGS", toolCallId: "prop:42", delta: JSON.stringify({ op: "EDIT", target: { scheme: "file", pathname: "a.ts" }, body: "diff" }) }));
            res.write(frame({ type: "TOOL_CALL_END", toolCallId: "prop:42" }));
            res.write(frame({ type: "RUN_FINISHED", threadId: "th", runId: "r1", outcome: { type: "interrupt", interrupts: [{ id: "prop:42", reason: "tool_call", toolCallId: "prop:42" }] } }));
        } else {
            res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { hitMaxTurns: false, turnIds: [1], result: { status: 200 } } }));
            res.write(frame({ type: "RUN_FINISHED" }));
        }
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        const { h, seen } = collectingHandlers();
        bt.subscribe(h);
        const handle = bt.run("edit it", {});
        // the proposal surfaces mid-run as an unprojected tool-call
        while (seen.proposals.length === 0) await new Promise((r) => setTimeout(r, 10));
        assert.equal((seen.proposals[0] as { logEntryId: number; op: string }).logEntryId, 42);
        assert.equal((seen.proposals[0] as { op: string }).op, "EDIT");
        await bt.resolve({ logEntryId: 42, decision: "accept", body: "edited" });
        const t = await handle.done;
        assert.equal(t.finalStatus, 200, "done spans the pause/resume chain");
        const resume = mock.captured[1].body as { resume: Array<{ interruptId: string; status: string; payload: unknown }> };
        assert.deepEqual(resume.resume, [{ interruptId: "prop:42", status: "resolved", payload: { decision: "accept", body: "edited" } }], "the standard resume carries the decision + edited body");
    } finally { await mock.close(); }
});

test("BridgeTransport: a proposal without the matching interrupt outcome returns an exact Problem", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "TOOL_CALL_START", toolCallId: "prop:42", toolCallName: "request_approval" }));
        res.write(frame({ type: "TOOL_CALL_ARGS", toolCallId: "prop:42", delta: JSON.stringify({ op: "EDIT", target: {}, body: "diff" }) }));
        res.write(frame({ type: "TOOL_CALL_END", toolCallId: "prop:42" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        const { h, seen } = collectingHandlers();
        bt.subscribe(h);
        const result = await bt.run("edit it", {}).done;
        assert.equal(result.finalStatus, 502);
        assert.equal(result.result.problem?.type, "https://problems.plurnk.dev/client/transport/interrupt-mismatch");
        assert.deepEqual(seen.problems, [result.result.problem]);
    } finally { await mock.close(); }
});

test("BridgeTransport: malformed proposal arguments return an exact Problem", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "TOOL_CALL_START", toolCallId: "prop:42", toolCallName: "request_approval" }));
        res.write(frame({ type: "TOOL_CALL_ARGS", toolCallId: "prop:42", delta: "{" }));
        res.write(frame({ type: "TOOL_CALL_END", toolCallId: "prop:42" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        const { h, seen } = collectingHandlers();
        bt.subscribe(h);
        const result = await bt.run("edit it", {}).done;
        assert.equal(result.result.problem?.type, "https://problems.plurnk.dev/client/transport/proposal-invalid");
        assert.deepEqual(seen.problems, [result.result.problem]);
    } finally { await mock.close(); }
});

test("[§cli-yolo-plurnkyolo] BridgeTransport: proposal can resolve synchronously from onProposal", async () => {
    let call = 0;
    const mock = await bootMock((_req, res) => {
        call += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (call === 1) {
            res.write(frame({ type: "TOOL_CALL_START", toolCallId: "prop:575", toolCallName: "request_approval" }));
            res.write(frame({ type: "TOOL_CALL_ARGS", toolCallId: "prop:575", delta: JSON.stringify({ op: "EXEC", target: null, body: "gh issue view 573" }) }));
            res.write(frame({ type: "TOOL_CALL_END", toolCallId: "prop:575" }));
            res.write(frame({ type: "RUN_FINISHED", threadId: "th", runId: "r1", outcome: { type: "interrupt", interrupts: [{ id: "prop:575", reason: "tool_call", toolCallId: "prop:575" }] } }));
        } else {
            res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { hitMaxTurns: false, turnIds: [2], result: { status: 200 } } }));
            res.write(frame({ type: "RUN_FINISHED" }));
        }
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        const { h } = collectingHandlers();
        bt.subscribe({
            ...h,
            onProposal: (p) => { void bt.resolve({ logEntryId: p.logEntryId, decision: "accept", outcome: "client_yolo" }); },
        });
        const t = await bt.run("exec it", {}).done;
        assert.equal(t.finalStatus, 200, "immediate yolo resolution resumes and finishes the loop");
        assert.equal(call, 2, "the proposal segment is followed by one resume segment");
        const resume = mock.captured[1].body as { resume: Array<{ interruptId: string; status: string; payload: unknown }> };
        assert.deepEqual(resume.resume, [{ interruptId: "prop:575", status: "resolved", payload: { decision: "accept" } }]);
    } finally { await mock.close(); }
});

test("BridgeTransport: resolve without a delivered interrupt fails hard", async () => {
    const bt = new BridgeTransport({ bridgeUrl: "http://127.0.0.1:1" }, "th");
    await assert.rejects(() => bt.resolve({ logEntryId: 1, decision: "accept" }), /without a delivered AG-UI interrupt/);
});

test("BridgeTransport: a stream that dies without terminal truth is an ERROR, never a fabricated 200", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "RUN_STARTED" }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.row", value: { id: 1, op: "READ" } }));
        res.end();   // no plurnk.terminated, no RUN_ERROR — the stream just dies
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        bt.subscribe(collectingHandlers().h);
        const t = await bt.run("go", {}).done;
        assert.equal(t.finalStatus, 502, "silent stream death surfaces as 502, not success");
    } finally { await mock.close(); }
});

test("[§cli-workspaces-and-workers] EVERY request carries the workspace options — creation is atomic with the projectRoot whichever request wins (#140)", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: "workspace.prompts", ok: true, result: { prompts: [] } } }));
        res.write(frame({ type: "RUN_FINISHED" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th", { projectRoot: "/home/user/repo", constraints: [{ effect: "pick", glob: "src/**" }], settings: { questions: true } });
        await bt.rpc("workspace.prompts", { limit: 50 });   // the TUI's real first touch (seedPromptHistory)
        await bt.rpc("workspace.prompts", { limit: 50 });   // and the SECOND — no consumed-once race
        for (const c of mock.captured) {
            const fp = (c.body as { forwardedProps: { plurnk: Record<string, unknown> } }).forwardedProps.plurnk;
            assert.equal(fp.projectRoot, "/home/user/repo", "projectRoot rides EVERY request — whichever creates, creates rooted");
            assert.deepEqual(fp.constraints, [{ effect: "pick", glob: "src/**" }]);
            assert.deepEqual(fp.settings, { questions: true });
        }
    } finally { await mock.close(); }
});

test("[§cli-model-selection] THE MODEL RIDES EVERY LOOP — not just the first (svc#414 guard: /model must not go cosmetic on run 2+)", async () => {
    // Two sequential runs on one transport. Workspace options are first-touch only, but
    // the model (alias + client-resolved spec) is a PER-LOOP knob and MUST ride every run
    // — the daemon keeps no sticky workspace-model, so a missing alias on run 2 = the loop
    // silently reverting to the daemon default. This is the "all loops send their model
    // alias" contract, verified deterministically at the choke point.
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { hitMaxTurns: false, turnIds: [1], result: { status: 200 } } }));
        res.write(frame({ type: "RUN_FINISHED" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        bt.subscribe(collectingHandlers().h);
        await bt.run("first", { alias: "fireslow", model: "fireworks/deepseek" }).done;
        await bt.run("second", { alias: "fireslow", model: "fireworks/deepseek" }).done;
        const runs = mock.captured.filter((c) => (c.body as { messages?: unknown[] }).messages !== undefined && ((c.body as { messages: unknown[] }).messages.length > 0 || (c.body as { forwardedProps?: { plurnk?: { action?: unknown } } }).forwardedProps?.plurnk?.action === undefined));
        assert.equal(runs.length, 2, "two loops drove");
        for (const [i, c] of runs.entries()) {
            const fp = (c.body as { forwardedProps: { plurnk: Record<string, unknown> } }).forwardedProps.plurnk;
            assert.equal(fp.alias, "fireslow", `loop ${i + 1} carries the alias`);
            assert.equal(fp.model, "fireworks/deepseek", `loop ${i + 1} carries the resolved model — never dropped on a later loop`);
        }
    } finally { await mock.close(); }
});

test("[§cli-child-provider-selection] child selection preserves explicit alias and inherit on the run wire", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { hitMaxTurns: false, turnIds: [1], result: { status: 200 } } }));
        res.write(frame({ type: "RUN_FINISHED" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        bt.subscribe(collectingHandlers().h);
        await bt.run("delegated", { childAlias: "firefast", childModel: "fireworks/qwen" }).done;
        await bt.run("inherited", { childAlias: null }).done;
        const runs = mock.captured.map((capture) => (capture.body as { forwardedProps: { plurnk: Record<string, unknown> } }).forwardedProps.plurnk);
        assert.equal(runs[0].childAlias, "firefast");
        assert.equal(runs[0].childModel, "fireworks/qwen");
        assert.equal(runs[1].childAlias, null, "explicit inherit is not collapsed into omission");
        assert.equal(Object.hasOwn(runs[1], "childModel"), false);
    } finally {
        await mock.close();
    }
});
