// Unit tests for the transport seam. WsTransport against a fake Rpc (persistent
// forwarding + loopId-keyed done); BridgeTransport against a mock SSE bridge
// (un-projection + done from plurnk.terminated). No live daemon.

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
        call: async (method: string, params?: unknown) => {
            calls.push({ method, params });
            if (method === "loop.run") return { finalStatus: 100, loopId: 1 };
            return {};
        },
    };
    return { rpc, handlers, calls };
};

test("WsTransport: persistent subscription forwards notifications even before/after a run (multi-client)", () => {
    const { rpc, handlers } = fakeRpc();
    const wt = new WsTransport(rpc as never);
    const { h, seen } = collectingHandlers();
    wt.subscribe(h);
    // A shared session's activity arrives with NO run in flight — must still render.
    handlers["log/entry"]({ entry: { id: 1, op: "SEND" } });
    handlers["telemetry/event"]({ loopId: 9, event: { source: "engine:rail", kind: "strike" } });
    assert.deepEqual(seen.entries, [{ id: 1, op: "SEND" }], "log/entry rendered while idle");
    assert.deepEqual(seen.telemetry, [{ source: "engine:rail", kind: "strike" }], "telemetry unwrapped to the event");
});

test("WsTransport: run() calls loop.run; done resolves with the loopId's terminated outcome", async () => {
    const { rpc, handlers, calls } = fakeRpc();
    const wt = new WsTransport(rpc as never);
    wt.subscribe(collectingHandlers().h);
    const handle = wt.run("hello", { alias: "opus" });
    assert.deepEqual(calls[0], { method: "loop.run", params: { prompt: "hello", alias: "opus" } });
    handlers["loop/terminated"]({ loopId: 1, finalStatus: 200, hitMaxTurns: false, turnIds: [1, 2] });
    const t = await handle.done;
    assert.equal(t.finalStatus, 200);
    assert.deepEqual(t.turnIds, [1, 2]);
});

test("WsTransport: a terminated arriving before the awaiter (fast loop) is buffered, not lost", async () => {
    const { rpc, handlers } = fakeRpc();
    const wt = new WsTransport(rpc as never);
    wt.subscribe(collectingHandlers().h);
    const handle = wt.run("go", {});
    // terminated races in before `done`'s awaitTerminated registers (loopId 1 from the ack)
    await Promise.resolve();
    handlers["loop/terminated"]({ loopId: 1, finalStatus: 200, hitMaxTurns: false });
    assert.equal((await handle.done).finalStatus, 200);
});

test("WsTransport: inject/resolve/cancel map to loop.inject/resolve/cancel", async () => {
    const { rpc, calls } = fakeRpc();
    const wt = new WsTransport(rpc as never);
    wt.subscribe(collectingHandlers().h);
    await wt.inject("steer");
    await wt.resolve({ logEntryId: 3, decision: "accept", body: "x" });
    wt.run("go", {}).cancel();
    const methods = calls.map((c) => c.method);
    assert.ok(methods.includes("loop.inject") && methods.includes("loop.resolve") && methods.includes("loop.cancel"));
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

test("BridgeTransport: run() un-projects plurnk.* to daemon shapes; done resolves from plurnk.terminated", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "TEXT_MESSAGE_CONTENT", delta: "generic-ignored" }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.row", value: { id: 5, op: "PLAN" } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.proposal", value: { logEntryId: 9 } }));
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
        assert.equal((seen.proposals[0] as { logEntryId: number }).logEntryId, 9);
        assert.equal((seen.telemetry[0] as { source: string }).source, "grammar");
        assert.equal(seen.entries.length, 1, "the generic TEXT_MESSAGE was ignored");
        assert.equal(t.sessionId, 7, "done resolves with the terminated outcome incl. sessionId");
        assert.deepEqual((mock.captured[0].body as { forwardedProps: unknown }).forwardedProps, { plurnk: { projectRoot: "/proj", constraints: [{ effect: "pick", glob: "src/**" }], settings: { questions: true }, alias: "opus" } }, "session options + per-run knobs ride the first run's forwardedProps");
    } finally { await mock.close(); }
});

test("BridgeTransport: inject rides /plurnk/rpc on the thread; resolve hits /resolve", async () => {
    const mock = await bootMock((req, res) => {
        if (req.url === "/plurnk/rpc") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ result: {} })); return; }
        res.writeHead(200).end("{}");
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        await bt.inject("steer mid-run");
        await bt.resolve({ logEntryId: 4, decision: "reject" });
        const inj = mock.captured.find((c) => c.url === "/plurnk/rpc");
        assert.equal((inj?.body as { method: string }).method, "loop.inject");
        assert.deepEqual((inj?.body as { params: unknown }).params, { prompt: "steer mid-run" });
        assert.deepEqual(mock.captured.find((c) => c.url === "/resolve")?.body, { threadId: "th", logEntryId: 4, decision: "reject" });
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
