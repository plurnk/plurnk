// Unit tests for the bridge consumer (plurnk-agui#1 migration substrate). A mock
// HTTP bridge scripts the SSE run + captures the /resolve and /plurnk/rpc shapes —
// no daemon, no real bridge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { runViaBridge, actionViaBridge, operationResult, problemDetails, resolveWorld } from "./agui.ts";
import { ProblemError } from "./diagnostics.ts";

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
const frame = (event: Record<string, unknown>): string => {
    const lifecycle = event.type === "RUN_STARTED" || event.type === "RUN_FINISHED"
        ? { threadId: "t", runId: "r", ...event }
        : event;
    return `data: ${JSON.stringify(lifecycle)}\n\n`;
};

test("AG-UI validators map invalid Problems and results to exact client Problems", () => {
    assert.throws(
        () => problemDetails({ status: 500 }),
        (error: unknown) => error instanceof ProblemError
            && error.problem.type === "https://problems.plurnk.dev/client/transport/problem-invalid",
    );
    assert.throws(
        () => operationResult({ status: 500 }),
        (error: unknown) => error instanceof ProblemError
            && error.problem.type === "https://problems.plurnk.dev/client/transport/result-invalid",
    );
});

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
        const body = mock.captured[0].body as { threadId: string; runId: string; state: unknown; messages: Array<{ id: string; role: string; content: string }>; tools: unknown[]; context: unknown[] };
        assert.equal(body.threadId, "t");
        assert.ok(body.runId.length > 0);
        assert.deepEqual(body.state, {});
        assert.deepEqual(body.tools, []);
        assert.deepEqual(body.context, []);
        assert.equal(body.messages[0].role, "user");
        assert.equal(body.messages[0].content, "largest planet?");
        assert.ok(body.messages[0].id.length > 0);
    } finally { await mock.close(); }
});

test("runViaBridge: forwardedProps.plurnk ALWAYS carries the workspace (world) + any options", async () => {
    const mock = await bootMock((_req, res) => sse(res, [frame({ type: "RUN_FINISHED" })]));
    try {
        const seen: string[] = [];
        for await (const e of runViaBridge({ bridgeUrl: mock.url }, { threadId: "t", prompt: "hi", forwardedProps: { projectRoot: "/x" } })) seen.push(e.type);
        assert.deepEqual(seen, ["RUN_FINISHED"]);
        // The workspace is REQUIRED and rides verbatim — the client sends its world, never
        // relying on the module to forge one from the threadId.
        assert.deepEqual((mock.captured[0].body as { forwardedProps: unknown }).forwardedProps, { plurnk: { workspace: "t", projectRoot: "/x" } });
    } finally { await mock.close(); }
});

test("runViaBridge: even with NO options, the workspace (world) still rides — it is not optional", async () => {
    const mock = await bootMock((_req, res) => sse(res, [frame({ type: "RUN_FINISHED" })]));
    try {
        for await (const _e of runViaBridge({ bridgeUrl: mock.url }, { threadId: "solo", prompt: "hi" })) void _e;
        assert.deepEqual((mock.captured[0].body as { forwardedProps: unknown }).forwardedProps, { plurnk: { workspace: "solo" } });
    } finally { await mock.close(); }
});

test("runViaBridge: a PLURNK HTTP failure preserves exact Problem Details", async () => {
    const problem = {
        type: "https://problems.plurnk.dev/agui/http/bearer-token-required",
        title: "Bearer token required",
        status: 401,
        detail: "A bearer token is required.",
        retryable: false,
    };
    const mock = await bootMock((_req, res) => res.writeHead(401, { "content-type": "application/problem+json" }).end(JSON.stringify(problem)));
    try {
        await assert.rejects(
            async () => { for await (const _e of runViaBridge({ bridgeUrl: mock.url }, { threadId: "t", prompt: "hi" })) void _e; },
            (error: unknown) => error instanceof ProblemError
                && error.problem.type === problem.type
                && error.problem.retryable === problem.retryable,
        );
    } finally { await mock.close(); }
});

test("runViaBridge: a foreign non-Problem HTTP failure remains an AG-UI transport error", async () => {
    const mock = await bootMock((_req, res) => res.writeHead(502, { "content-type": "text/plain" }).end("relay failed"));
    try {
        await assert.rejects(
            async () => { for await (const _e of runViaBridge({ bridgeUrl: mock.url }, { threadId: "t", prompt: "hi" })) void _e; },
            /HTTP 502:.*relay failed/,
        );
    } finally { await mock.close(); }
});

test("runViaBridge: the standard transport handles comments, CRLF, split chunks, and multiline data", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": keepalive\r\n\r");
        res.write("\ndata: {\"type\":\"RUN_STARTED\",\r\n");
        res.write("data: \"threadId\":\"t\",\"runId\":\"r\"}\r\n\r\n");
        res.end();
    });
    try {
        const seen: string[] = [];
        for await (const event of runViaBridge({ bridgeUrl: mock.url }, { threadId: "t", prompt: "hi" })) seen.push(event.type);
        assert.deepEqual(seen, ["RUN_STARTED"]);
    } finally { await mock.close(); }
});

test("runViaBridge: malformed AG-UI events fail at the standard client boundary", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "RUN_FINISHED" })}\n\n`);
        res.end();
    });
    try {
        await assert.rejects(
            async () => {
                for await (const _event of runViaBridge({ bridgeUrl: mock.url }, { threadId: "t", prompt: "hi" })) void _event;
            },
            /threadId|runId/,
        );
    } finally { await mock.close(); }
});

test("actionViaBridge: a verb rides its own run and returns its result verbatim", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: " + JSON.stringify({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: "workspace.list", ok: true, result: { workspaces: [{ id: 1, name: "s" }] } } }) + "\n\n");
        res.write("data: " + JSON.stringify({ type: "RUN_FINISHED" }) + "\n\n");
        res.end();
    });
    try {
        const out = await actionViaBridge<{ workspaces: Array<{ id: number }> }>({ bridgeUrl: mock.url }, { threadId: "t", kind: "workspace.list" });
        assert.equal(out.workspaces[0].id, 1);
        const sent = mock.captured[0].body as { forwardedProps: { plurnk: { action: { kind: string } } } };
        assert.equal(sent.forwardedProps.plurnk.action.kind, "workspace.list", "the action rides forwardedProps.plurnk.action");
    } finally { await mock.close(); }
});

test("actionViaBridge: an action failure throws the exact validated Problem", async () => {
    const problem = {
        type: "https://problems.plurnk.dev/agui/action/unknown-action",
        title: "Unknown action",
        status: 404,
        detail: "Unknown action 'missing'.",
        recovery: "Use an advertised action.",
        retryable: false,
    };
    const mock = await bootMock((_req, res) => sse(res, [
        frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: "missing", ok: false, problem } }),
        frame({ type: "RUN_FINISHED" }),
    ]));
    try {
        await assert.rejects(
            () => actionViaBridge({ bridgeUrl: mock.url }, { threadId: "t", kind: "missing" }),
            (error: unknown) => error instanceof ProblemError
                && error.problem.type === problem.type
                && error.problem.recovery === problem.recovery,
        );
    } finally { await mock.close(); }
});

test("actionViaBridge: a missing action result throws an exact client Problem", async () => {
    const mock = await bootMock((_req, res) => sse(res, [frame({ type: "RUN_FINISHED" })]));
    try {
        await assert.rejects(
            () => actionViaBridge({ bridgeUrl: mock.url }, { threadId: "t", kind: "workspace.list" }),
            (error: unknown) => error instanceof ProblemError
                && error.problem.type === "https://problems.plurnk.dev/client/action/result-missing"
                && error.problem.action === "workspace.list",
        );
    } finally { await mock.close(); }
});

test("actionViaBridge: a malformed action result throws an exact client Problem", async () => {
    const mock = await bootMock((_req, res) => sse(res, [
        frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: "workspace.list" } }),
        frame({ type: "RUN_FINISHED" }),
    ]));
    try {
        await assert.rejects(
            () => actionViaBridge({ bridgeUrl: mock.url }, { threadId: "t", kind: "workspace.list" }),
            (error: unknown) => error instanceof ProblemError
                && error.problem.type === "https://problems.plurnk.dev/client/action/result-invalid",
        );
    } finally { await mock.close(); }
});

test("[§cli-workspaces-and-workers] runViaBridge: an explicit workspace rides with a DIFFERENT threadId (thread-per-run, svc#366)", async () => {
    const mock = await bootMock((_req, res) => sse(res, [frame({ type: "RUN_FINISHED" })]));
    try {
        for await (const _e of runViaBridge({ bridgeUrl: mock.url }, { threadId: "chat-2", workspace: "workspace", prompt: "hi" })) void _e;
        const body = mock.captured[0].body as { threadId: string; forwardedProps: { plurnk: { workspace: string } } };
        assert.equal(body.threadId, "chat-2", "the thread names the conversation run");
        assert.equal(body.forwardedProps.plurnk.workspace, "workspace", "the workspace names the world — independently");
    } finally { await mock.close(); }
});

test("[§cli-workspaces-and-workers] resolveWorld: no --workspace → the daemon MINTS a fresh workspace (no 'tui'/'cli' label); the minted name is the world", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: "workspace.create", ok: true, result: { id: 9, name: "workspace-1783-abc", runId: 3 } } }));
        res.write(frame({ type: "RUN_FINISHED" }));
        res.end();
    });
    try {
        const name = await resolveWorld({ bridgeUrl: mock.url }, undefined, { projectRoot: "/repo" });
        assert.equal(name, "workspace-1783-abc", "the world is the daemon-minted name, never a literal client label");
        const action = (mock.captured[0].body as { forwardedProps: { plurnk: { action: { kind: string; name?: string; projectRoot?: string } } } }).forwardedProps.plurnk.action;
        assert.equal(action.kind, "workspace.create");
        assert.equal(action.name, undefined, "NO name is sent — the daemon mints a fresh unique one");
        assert.equal(action.projectRoot, "/repo", "created WITH options — atomic with the root (#140)");
    } finally { await mock.close(); }
});

test("[§cli-workspaces-and-workers] resolveWorld: an explicit --workspace short-circuits — no wire touch, name verbatim", async () => {
    let touched = false;
    const mock = await bootMock((_req, res) => { touched = true; res.writeHead(200).end(); });
    try {
        assert.equal(await resolveWorld({ bridgeUrl: mock.url }, "my-world", { projectRoot: "/x" }), "my-world");
        assert.equal(touched, false, "a named workspace never hits the wire to mint");
    } finally { await mock.close(); }
});

test("resolveWorld: a missing minted name throws an exact client Problem", async () => {
    const mock = await bootMock((_req, res) => sse(res, [
        frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: "workspace.create", ok: true, result: { id: 9 } } }),
        frame({ type: "RUN_FINISHED" }),
    ]));
    try {
        await assert.rejects(
            () => resolveWorld({ bridgeUrl: mock.url }, undefined, { projectRoot: "/repo" }),
            (error: unknown) => error instanceof ProblemError
                && error.problem.type === "https://problems.plurnk.dev/client/workspace/name-missing",
        );
    } finally { await mock.close(); }
});

test("[§cli-model-selection] runCliViaBridge: one-shot workspace options and model selection ride forwardedProps.plurnk", async () => {
    const { runCliViaBridge } = await import("./agui_cli.ts");
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { hitMaxTurns: false, turnIds: [1], result: { status: 200 } } }));
        res.write(frame({ type: "RUN_FINISHED" }));
        res.end();
    });
    try {
        await runCliViaBridge({ bridgeUrl: mock.url }, "hi", {
            threadId: "w",
            workspace: "w",
            flags: { auto: true },
            maxTurns: 7,
            yolo: true,
            json: true,
            projectRoot: "/repo",
            constraints: [{ effect: "pick", glob: "docs/**" }],
            settings: { filesItems: 0 },
        });
        const fp = (mock.captured[0].body as { forwardedProps: { plurnk: Record<string, unknown> } }).forwardedProps.plurnk;
        assert.equal(fp.projectRoot, "/repo", "the project root reaches the wire");
        assert.deepEqual(fp.constraints, [{ effect: "pick", glob: "docs/**" }], "membership constraints reach the wire");
        assert.deepEqual(fp.settings, { filesItems: 0 }, "workspace settings reach the wire");
        assert.equal(fp.alias, undefined, "no model selector rides the run — the worker owns the model ({§worker-model-selection})");
        assert.equal(fp.model, undefined);
        assert.equal(fp.childAlias, undefined);
        assert.equal(fp.childModel, undefined);
        assert.deepEqual(fp.flags, { auto: true }, "loop flags reach the wire");
        assert.equal(fp.maxTurns, 7, "the turn ceiling reaches the wire");
    } finally { await mock.close(); }
});

test("[§cli-invocation] --timeout FIRES (svc#478): the deadline cancels the loop, the record says timedOut, exit is 3 — the flag was parsed-and-dead since the agui migration", async () => {
    const { runCliViaBridge } = await import("./agui_cli.ts");
    let cancelSeen = false;
    let holdOpen: (() => void) | null = null;
    const mock = await bootMock((req, res) => {
        const body = (mock.captured[mock.captured.length - 1]?.body ?? {}) as { forwardedProps?: { plurnk?: { action?: { kind?: string } } } };
        if (body.forwardedProps?.plurnk?.action?.kind === "loop.cancel") {
            cancelSeen = true;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: "loop.cancel", ok: true, result: { cancelled: true } } }));
            res.write(frame({ type: "RUN_FINISHED" }));
            res.end();
            // The daemon aborts the drain → the held conversation stream terminates 499.
            if (holdOpen !== null) holdOpen();
            return;
        }
        // The conversation run: one row, then HELD OPEN (a loop that never ends on its own).
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "CUSTOM", name: "plurnk.row", value: { id: 1, op: "PLAN" } }));
        holdOpen = () => {
            res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { hitMaxTurns: false, turnIds: [1], result: { status: 499, problem: { type: "https://problems.plurnk.dev/lifecycle/cancel/loop-cancelled", title: "Loop cancelled", status: 499, detail: "The loop was cancelled." } } } }));
            res.write(frame({ type: "RUN_FINISHED" }));
            res.end();
        };
    });
    const outs: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { outs.push(s); return true; };
    try {
        const code = await runCliViaBridge({ bridgeUrl: mock.url }, "spin forever", { threadId: "w", workspace: "w", timeoutSec: 1, yolo: true, json: true, projectRoot: null });
        assert.equal(cancelSeen, true, "the deadline fired loop.cancel at the daemon");
        assert.equal(code, 3, "timeout exits 3 (cancellation)");
        const doc = JSON.parse(outs.map(String).find((w) => w.startsWith('{"schemaVersion"')) ?? "{}") as { timedOut: boolean; finalStatus: number };
        assert.equal(doc.timedOut, true, "the record says timedOut");
        assert.equal(doc.finalStatus, 499, "the loop's real cancel status, not a fabricated 200");
    } finally {
        (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
        await mock.close();
    }
});

test("[§cli-output-channels] a dead stream never fabricates finalStatus 200 in the json record (svc#478 companion)", async () => {
    const { runCliViaBridge } = await import("./agui_cli.ts");
    // The stream dies without terminal truth: no terminated, no RUN_FINISHED.
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "CUSTOM", name: "plurnk.row", value: { id: 1, op: "PLAN" } }));
        res.end();   // abrupt end — no terminal event
    });
    const outs: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => { outs.push(s); return true; };
    try {
        const code = await runCliViaBridge({ bridgeUrl: mock.url }, "hi", { threadId: "w", workspace: "w", yolo: true, json: true, projectRoot: null });
        const doc = JSON.parse(outs.map(String).find((w) => w.startsWith('{"schemaVersion"')) ?? "{}") as { finalStatus: number };
        assert.notEqual(doc.finalStatus, 200, "no fabricated success on a dead stream");
        assert.notEqual(code, 0, "the exit code is not success either");
    } finally {
        (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
        await mock.close();
    }
});
