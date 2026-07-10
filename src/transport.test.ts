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

test("BridgeTransport: run() un-projects plurnk.* to daemon shapes; done resolves from plurnk.terminated", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "TEXT_MESSAGE_CONTENT", delta: "generic-ignored" }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.row", value: { id: 5, op: "PLAN" } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.stream", value: { entryId: 2, state: "active" } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.telemetry", value: { source: "grammar", kind: "parse_error" } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { sessionId: 7, loopId: 3, finalStatus: 200, hitMaxTurns: false, turnIds: [1] } }));
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
        assert.equal(t.sessionId, 7, "done resolves with the terminated outcome incl. sessionId");
        assert.deepEqual((mock.captured[0].body as { forwardedProps: unknown }).forwardedProps, { plurnk: { projectRoot: "/proj", constraints: [{ effect: "pick", glob: "src/**" }], settings: { questions: true }, alias: "opus" } }, "session options + per-run knobs ride the first run's forwardedProps");
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

test("BridgeTransport: cancel() aborts the SSE and done resolves (499), not a throw", async () => {
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

test("BridgeTransport.useSession: re-maps the threadId — the next run addresses the new session", async () => {
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

test("BridgeTransport: resolve without a paused run fails hard (terminate-resume contract)", async () => {
    const bt = new BridgeTransport({ bridgeUrl: "http://127.0.0.1:1" }, "th");
    await assert.rejects(() => bt.resolve({ logEntryId: 1, decision: "accept" }), /without a paused proposal run/);
});
