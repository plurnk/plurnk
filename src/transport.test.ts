// Unit tests for the transport seam (plurnk-agui#1 Phase B). WsTransport against a
// fake Rpc (notification forwarding + RPC mapping); BridgeTransport against a mock
// SSE bridge (un-projection of plurnk.* customs → daemon shapes). No live daemon.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import WsTransport, { BridgeTransport, type RunHandlers } from "./transport.ts";

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

// ── WsTransport ──────────────────────────────────────────────────────

const fakeRpc = () => {
    const handlers: Record<string, (p: unknown) => void> = {};
    const calls: Array<{ method: string; params: unknown }> = [];
    const rpc = {
        onNotification: (m: string, cb: (p: unknown) => void) => { handlers[m] = cb; },
        onClose: () => {},
        call: async (method: string, params?: unknown) => { calls.push({ method, params }); return {}; },
    };
    return { rpc, handlers, calls };
};

test("WsTransport: run() calls loop.run and forwards notifications to the current handlers; terminated resolves done", async () => {
    const { rpc, handlers, calls } = fakeRpc();
    const wt = new WsTransport(rpc as never);
    const { h, seen } = collectingHandlers();
    const handle = wt.run("hello", { alias: "opus" }, h);
    assert.deepEqual(calls[0], { method: "loop.run", params: { prompt: "hello", alias: "opus" } });

    handlers["log/entry"]({ entry: { id: 1, op: "SEND" } });
    handlers["loop/proposal"]({ logEntryId: 9, op: "EDIT" });
    handlers["stream/event"]({ entryId: 1, state: "active" });
    handlers["telemetry/event"]({ loopId: 1, event: { source: "engine:rail", kind: "strike" } });
    assert.deepEqual(seen.entries, [{ id: 1, op: "SEND" }], "log/entry → onEntry(entry)");
    assert.equal((seen.proposals[0] as { logEntryId: number }).logEntryId, 9);
    assert.equal((seen.streams[0] as { state: string }).state, "active");
    assert.deepEqual(seen.telemetry, [{ source: "engine:rail", kind: "strike" }], "telemetry unwrapped to the event");

    handlers["loop/terminated"]({ loopId: 1, finalStatus: 200, hitMaxTurns: false });
    await handle.done;   // resolves on terminated
    assert.equal((seen.terminated[0] as { finalStatus: number }).finalStatus, 200);
});

test("WsTransport: inject/resolve/cancel map to loop.inject/loop.resolve/loop.cancel", async () => {
    const { rpc, calls } = fakeRpc();
    const wt = new WsTransport(rpc as never);
    await wt.inject("steer");
    await wt.resolve({ logEntryId: 3, decision: "accept", body: "x" });
    wt.run("go", {}, collectingHandlers().h).cancel();
    const methods = calls.map((c) => c.method);
    assert.deepEqual(methods, ["loop.inject", "loop.resolve", "loop.run", "loop.cancel"]);
    assert.deepEqual(calls[1].params, { logEntryId: 3, decision: "accept", body: "x" });
});

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

test("BridgeTransport: run() un-projects plurnk.* customs to daemon shapes; core AG-UI events ignored", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "RUN_STARTED", threadId: "t", runId: "r" }));
        res.write(frame({ type: "TEXT_MESSAGE_CONTENT", delta: "generic-ignored" }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.row", value: { id: 5, op: "PLAN" } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.proposal", value: { logEntryId: 9, op: "EDIT" } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.stream", value: { entryId: 2, state: "active" } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.telemetry", value: { source: "grammar", kind: "parse_error" } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { sessionId: 7, loopId: 3, finalStatus: 200, hitMaxTurns: false, turnIds: [1] } }));
        res.write(frame({ type: "RUN_FINISHED", threadId: "t", runId: "r" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th", "/proj");
        const { h, seen } = collectingHandlers();
        await bt.run("largest planet?", { alias: "opus" }, h).done;
        assert.deepEqual(seen.entries, [{ id: 5, op: "PLAN" }], "plurnk.row → onEntry(entry)");
        assert.equal((seen.proposals[0] as { logEntryId: number }).logEntryId, 9);
        assert.equal((seen.streams[0] as { state: string }).state, "active");
        assert.deepEqual(seen.telemetry, [{ source: "grammar", kind: "parse_error" }]);
        assert.equal((seen.terminated[0] as { sessionId: number }).sessionId, 7, "plurnk.terminated → onTerminated with sessionId");
        assert.equal(seen.entries.length, 1, "the generic TEXT_MESSAGE was ignored");
        // first run carries session options + per-run knobs via forwardedProps.plurnk
        assert.deepEqual((mock.captured[0].body as { forwardedProps: unknown }).forwardedProps, { plurnk: { projectRoot: "/proj", alias: "opus" } });
    } finally { await mock.close(); }
});

test("BridgeTransport: inject/resolve ride the management + resolve endpoints on the thread", async () => {
    const mock = await bootMock((req, res) => {
        if (req.url === "/plurnk/rpc") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result: {} })); return; }
        res.writeHead(200).end("{}");
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        await bt.inject("steer mid-run");
        await bt.resolve({ logEntryId: 4, decision: "reject" });
        const inj = mock.captured.find((c) => c.url === "/plurnk/rpc");
        assert.equal((inj?.body as { method: string }).method, "loop.inject", "inject rides /plurnk/rpc on the thread's connection");
        assert.deepEqual((inj?.body as { params: unknown }).params, { prompt: "steer mid-run" });
        const res = mock.captured.find((c) => c.url === "/resolve");
        assert.deepEqual(res?.body, { threadId: "th", logEntryId: 4, decision: "reject" });
    } finally { await mock.close(); }
});

test("BridgeTransport: cancel() aborts the SSE and done resolves cleanly (not a throw)", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "RUN_STARTED" }));
        // never ends — simulates an in-flight run the user /stops
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        const handle = bt.run("go", {}, collectingHandlers().h);
        await new Promise((r) => setTimeout(r, 50));
        handle.cancel();
        await handle.done;   // must resolve, not reject
        assert.ok(true, "done resolved after cancel");
    } finally { await mock.close(); }
});
