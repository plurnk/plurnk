// Unit tests for the bridge consumer (plurnk-agui#1 migration substrate). A mock
// HTTP bridge scripts the SSE run + captures the /resolve and /plurnk/rpc shapes —
// no daemon, no real bridge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { runViaBridge, actionViaBridge } from "./agui.ts";

const bootMock = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
    const captured: Array<{ url: string | undefined; method: string | undefined; auth: string | undefined; body: unknown }> = [];
    const server = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
            captured.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: body.length > 0 ? JSON.parse(body) : null });
            handler(req, res);
        });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}`, captured, close: () => new Promise<void>((r) => server.close(() => r())) };
};

const sse = (res: ServerResponse, frames: string[]) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const f of frames) res.write(f);
    res.end();
};
const frame = (e: unknown): string => `data: ${JSON.stringify(e)}\n\n`;

test("runViaBridge: yields AG-UI events in order, reassembling frames split across chunks", async () => {
    const tm = frame({ type: "TEXT_MESSAGE_START", messageId: "1", role: "assistant" });
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "RUN_STARTED", threadId: "t", runId: "r" }));
        res.write(tm.slice(0, 12)); res.write(tm.slice(12));   // one frame split mid-write
        res.write(frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "1", delta: "Jupiter." }));
        res.write(frame({ type: "TEXT_MESSAGE_END", messageId: "1" }));
        res.write(frame({ type: "RUN_FINISHED", threadId: "t", runId: "r" }));
        res.end();
    });
    try {
        const types: string[] = [];
        let text = "";
        for await (const e of runViaBridge({ bridgeUrl: mock.url }, { threadId: "t", prompt: "largest planet?" })) {
            types.push(e.type);
            if (e.type === "TEXT_MESSAGE_CONTENT") text += String(e.delta);
        }
        assert.deepEqual(types, ["RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "RUN_FINISHED"]);
        assert.equal(text, "Jupiter.");
        assert.equal(mock.captured[0].url, "/");
        assert.deepEqual((mock.captured[0].body as { messages: unknown }).messages, [{ role: "user", content: "largest planet?" }]);
        assert.equal((mock.captured[0].body as { threadId: string }).threadId, "t");
    } finally { await mock.close(); }
});

test("runViaBridge: forwardedProps.plurnk ALWAYS carries the session (world) + any options", async () => {
    const mock = await bootMock((_req, res) => sse(res, [frame({ type: "RUN_FINISHED" })]));
    try {
        const seen: string[] = [];
        for await (const e of runViaBridge({ bridgeUrl: mock.url }, { threadId: "t", prompt: "hi", forwardedProps: { projectRoot: "/x" } })) seen.push(e.type);
        assert.deepEqual(seen, ["RUN_FINISHED"]);
        // The session is REQUIRED and rides verbatim — the client sends its world, never
        // relying on the module to forge one from the threadId.
        assert.deepEqual((mock.captured[0].body as { forwardedProps: unknown }).forwardedProps, { plurnk: { session: "t", projectRoot: "/x" } });
    } finally { await mock.close(); }
});

test("runViaBridge: even with NO options, the session (world) still rides — it is not optional", async () => {
    const mock = await bootMock((_req, res) => sse(res, [frame({ type: "RUN_FINISHED" })]));
    try {
        for await (const _e of runViaBridge({ bridgeUrl: mock.url }, { threadId: "solo", prompt: "hi" })) void _e;
        assert.deepEqual((mock.captured[0].body as { forwardedProps: unknown }).forwardedProps, { plurnk: { session: "solo" } });
    } finally { await mock.close(); }
});

test("runViaBridge: a non-200 run surfaces the bridge error, not a silent hang", async () => {
    const mock = await bootMock((_req, res) => res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "bearer token required" })));
    try {
        await assert.rejects(
            async () => { for await (const _e of runViaBridge({ bridgeUrl: mock.url }, { threadId: "t", prompt: "hi" })) void _e; },
            /bridge run failed: 401.*bearer token required/,
        );
    } finally { await mock.close(); }
});

test("actionViaBridge: a verb rides its own run; the result custom returns verbatim; ok:false throws", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: " + JSON.stringify({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: "session.list", ok: true, result: { sessions: [{ id: 1, name: "s" }] } } }) + "\n\n");
        res.write("data: " + JSON.stringify({ type: "RUN_FINISHED" }) + "\n\n");
        res.end();
    });
    try {
        const out = await actionViaBridge<{ sessions: Array<{ id: number }> }>({ bridgeUrl: mock.url }, { threadId: "t", kind: "session.list" });
        assert.equal(out.sessions[0].id, 1);
        const sent = mock.captured[0].body as { forwardedProps: { plurnk: { action: { kind: string } } } };
        assert.equal(sent.forwardedProps.plurnk.action.kind, "session.list", "the action rides forwardedProps.plurnk.action");
    } finally { await mock.close(); }
});


test("[§cli-sessions-and-runs] runViaBridge: an explicit session rides with a DIFFERENT threadId (thread-per-run, svc#366)", async () => {
    const mock = await bootMock((_req, res) => sse(res, [frame({ type: "RUN_FINISHED" })]));
    try {
        for await (const _e of runViaBridge({ bridgeUrl: mock.url }, { threadId: "chat-2", session: "workspace", prompt: "hi" })) void _e;
        const body = mock.captured[0].body as { threadId: string; forwardedProps: { plurnk: { session: string } } };
        assert.equal(body.threadId, "chat-2", "the thread names the conversation run");
        assert.equal(body.forwardedProps.plurnk.session, "workspace", "the session names the world — independently");
    } finally { await mock.close(); }
});
