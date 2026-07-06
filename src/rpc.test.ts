// Unit tests for src/rpc.ts — exercised against an in-process WebSocketServer
// so no daemon is required. The server is a minimal JSON-RPC echo that handles
// the methods the tests call.

import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer, type WebSocket } from "ws";
import { once } from "node:events";

import Rpc, { RpcError } from "./rpc.ts";

interface JsonRpcRequest {
    jsonrpc: "2.0";
    id?: number;
    method: string;
    params?: unknown;
}

// Spin up a minimal server. Returns { url, server, close }.
const startServer = async (handler: (sock: WebSocket, req: JsonRpcRequest) => void) => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const addr = server.address();
    if (addr === null || typeof addr === "string") throw new Error("no addr");
    const url = `ws://127.0.0.1:${addr.port}`;
    server.on("connection", (sock) => {
        sock.on("message", (data) => {
            const req = JSON.parse(data.toString()) as JsonRpcRequest;
            handler(sock, req);
        });
    });
    return {
        url,
        close: async () => { await new Promise<void>((r) => server.close(() => r())); },
    };
};

test("Rpc: constructor + close on never-connected → no-op", async () => {
    const rpc = new Rpc({ url: "ws://127.0.0.1:1" });
    await rpc.close();  // should not throw
});

test("Rpc: call before connect → throws", async () => {
    const rpc = new Rpc({ url: "ws://127.0.0.1:1" });
    await assert.rejects(rpc.call("ping"), /not connected/);
});

test("Rpc: connect twice → throws on second", async () => {
    const { url, close } = await startServer((sock, req) => {
        sock.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }));
    });
    try {
        const rpc = new Rpc({ url });
        await rpc.connect();
        await assert.rejects(rpc.connect(), /already connected/);
        await rpc.close();
    } finally {
        await close();
    }
});

test("Rpc: onClose fires when the socket drops, and a call awaiting a response rejects", async () => {
    // Server accepts the call but NEVER responds, then drops the connection —
    // the disconnect-mid-request case that wedged the TUI (#escape-a-dead-loop).
    const { url, close } = await startServer((sock) => { sock.close(); });
    try {
        const rpc = new Rpc({ url });
        await rpc.connect();
        let closed = false;
        rpc.onClose(() => { closed = true; });
        await assert.rejects(rpc.call("hang", {}), /connection closed before response/);
        assert.equal(closed, true, "onClose handler fired on the drop");
        await assert.rejects(rpc.call("after", {}), /not connected/);   // #ws nulled after close
    } finally {
        await close();
    }
});

test("Rpc: call resolves with server result", async () => {
    const { url, close } = await startServer((sock, req) => {
        sock.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { echo: req.params } }));
    });
    try {
        const rpc = new Rpc({ url });
        await rpc.connect();
        const result = await rpc.call("hello", { name: "world" });
        assert.deepEqual(result, { echo: { name: "world" } });
        await rpc.close();
    } finally {
        await close();
    }
});

test("Rpc: server error → call rejects with typed RpcError carrying method + code", async () => {
    const { url, close } = await startServer((sock, req) => {
        sock.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "method not found" } }));
    });
    try {
        const rpc = new Rpc({ url });
        await rpc.connect();
        await assert.rejects(rpc.call("nope"), (err: unknown) => {
            assert.ok(err instanceof RpcError, "rejects with RpcError");
            assert.equal(err.method, "nope", "carries the failed method");
            assert.equal(err.code, -32601, "carries the daemon code");
            assert.match(err.message, /rpc error -32601: method not found/);
            return true;
        });
        await rpc.close();
    } finally {
        await close();
    }
});

test("Rpc: onNotification dispatches incoming server-push messages", async () => {
    const { url, close } = await startServer((sock, req) => {
        // Reply to the call, then push a notification.
        sock.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }));
        sock.send(JSON.stringify({ jsonrpc: "2.0", method: "log/entry", params: { hello: true } }));
    });
    try {
        const rpc = new Rpc({ url });
        await rpc.connect();
        let received: unknown = null;
        rpc.onNotification("log/entry", (p) => { received = p; });
        await rpc.call("ping");
        // notification dispatch is sync on message receipt; tiny tick to let it land
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(received, { hello: true });
        await rpc.close();
    } finally {
        await close();
    }
});

test("Rpc: multiple notification handlers all fire", async () => {
    // Server pushes the notification in response to any client call.
    const { url, close } = await startServer((sock, req) => {
        sock.send(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: {} }));
        sock.send(JSON.stringify({ jsonrpc: "2.0", method: "evt", params: { n: 1 } }));
    });
    const rpc = new Rpc({ url });
    try {
        await rpc.connect();
        const got: number[] = [];
        rpc.onNotification("evt", () => got.push(1));
        rpc.onNotification("evt", () => got.push(2));
        await rpc.call("ping");
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(got, [1, 2]);
    } finally {
        await rpc.close();  // must close client BEFORE server, else server.close hangs
        await close();
    }
});

test("Rpc: pending call → connection closed before response → reject", async () => {
    const { url, close } = await startServer(() => {
        // Never reply. Test will close the connection.
    });
    try {
        const rpc = new Rpc({ url });
        await rpc.connect();
        const pending = rpc.call("hang");
        // Close immediately; the pending promise should reject.
        setImmediate(() => { void rpc.close(); });
        await assert.rejects(pending, /connection closed/);
    } finally {
        await close();
    }
});
