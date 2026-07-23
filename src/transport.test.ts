// Unit tests for the transport seam. WsTransport against a fake Rpc (persistent
// forwarding + loopId-keyed done); BridgeTransport against a mock SSE bridge
// (un-projection + done from plurnk.terminated). No live daemon.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BridgeTransport, type RunHandlers } from "./transport.ts";

const collectingHandlers = () => {
    const seen: { entries: unknown[]; proposals: unknown[]; streams: unknown[]; telemetry: unknown[]; terminated: unknown[] } = { entries: [], proposals: [], streams: [], telemetry: [], terminated: [] };
    const h: RunHandlers = {
        onEntry: (e) => seen.entries.push(e),
        onProposal: (p) => seen.proposals.push(p),
        onStream: (s) => seen.streams.push(s),
        onTelemetry: (t) => seen.telemetry.push(t),
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
const frame = (e: unknown): string => `data: ${JSON.stringify(e)}\n\n`;

test("[§cli-conformance] BridgeTransport: run() un-projects plurnk.* to daemon shapes; done resolves from plurnk.terminated", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "TEXT_MESSAGE_CONTENT", delta: "generic-ignored" }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.row", value: { id: 5, op: "PLAN" } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.stream", value: { entryId: 2, state: "active" } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.telemetry", value: { source: "grammar", kind: "parse_error" } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { workspaceId: 7, loopId: 3, finalStatus: 200, hitMaxTurns: false, turnIds: [1] } }));
        res.write(frame({ type: "RUN_FINISHED" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th", { projectRoot: "/proj", constraints: [{ effect: "pick", glob: "src/**" }], settings: { questions: true } });
        const { h, seen } = collectingHandlers();
        bt.subscribe(h);
        const t = await bt.run("largest planet?", { alias: "opus" }).done;
        assert.deepEqual(seen.entries, [{ id: 5, op: "PLAN" }]);
        assert.equal((seen.telemetry[0] as { source: string }).source, "grammar");
        assert.equal(seen.entries.length, 1, "the generic TEXT_MESSAGE was ignored");
        assert.equal(t.workspaceId, 7, "done resolves with the terminated outcome incl. workspaceId");
        assert.deepEqual((mock.captured[0].body as { forwardedProps: unknown }).forwardedProps, { plurnk: { workspace: "th", projectRoot: "/proj", constraints: [{ effect: "pick", glob: "src/**" }], settings: { questions: true }, alias: "opus" } }, "the workspace (world) + options + per-run knobs ride the first run's forwardedProps");
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
    const mock = await bootMock((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { finalStatus: 200, hitMaxTurns: false } })); res.write(frame({ type: "RUN_FINISHED" })); res.end(); });
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
            res.write(frame({ type: "RUN_FINISHED" }));
        } else {
            res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { finalStatus: 200, hitMaxTurns: false, turnIds: [1] } }));
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
        const resume = mock.captured[1].body as { messages: Array<{ role: string; toolCallId: string; content: string }> };
        assert.equal(resume.messages[0].role, "tool");
        assert.equal(resume.messages[0].toolCallId, "prop:42");
        assert.deepEqual(JSON.parse(resume.messages[0].content), { decision: "accept", body: "edited" }, "the tool-result carries the decision + edited body");
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
            res.write(frame({ type: "RUN_FINISHED" }));
        } else {
            res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { finalStatus: 200, hitMaxTurns: false, turnIds: [2] } }));
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
        const resume = mock.captured[1].body as { messages: Array<{ role: string; toolCallId: string; content: string }> };
        assert.equal(resume.messages[0].toolCallId, "prop:575");
        assert.deepEqual(JSON.parse(resume.messages[0].content), { decision: "accept" });
    } finally { await mock.close(); }
});

test("BridgeTransport: resolve without a delivered proposal fails hard (terminate-resume contract)", async () => {
    const bt = new BridgeTransport({ bridgeUrl: "http://127.0.0.1:1" }, "th");
    await assert.rejects(() => bt.resolve({ logEntryId: 1, decision: "accept" }), /without a delivered proposal/);
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

test("[§cli-workspaces-and-workers] EVERY request carries the workspace options — creation is atomic with the projectRoot whichever request wins (#140, operator ruling)", async () => {
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
        res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { finalStatus: 200, hitMaxTurns: false, turnIds: [1] } }));
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
