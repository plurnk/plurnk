// Unit tests for the AG-UI consumer. A mock HTTP endpoint scripts the SSE run and
// captures the request shapes — no daemon.

import { test } from "node:test";
import assert from "node:assert/strict";
import Lifetime from "./lifetime.ts";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { runViaAgui, actionViaAgui, operationResult, problemDetails } from "./agui.ts";
import { ProblemError } from "./diagnostics.ts";
import Credential from "./credential.ts";
import { callOf } from "../test/agui-parts.ts";

const bootMock = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
    const captured: Array<{ url: string | undefined; method: string | undefined; auth: string | undefined; body: unknown }> = [];
    const server = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
            const parsed = ((): unknown => { try { return body.length > 0 ? JSON.parse(body) : null; } catch { return body; } })();
            captured.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: parsed });
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
            && error.problem.type === "https://problems.plurnk.xyz/client/transport/problem-invalid",
    );
    assert.throws(
        () => operationResult({ status: 500 }),
        (error: unknown) => error instanceof ProblemError
            && error.problem.type === "https://problems.plurnk.xyz/client/transport/result-invalid",
    );
});

test("runViaAgui: yields AG-UI events in order, reassembling frames split across chunks", async () => {
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
        for await (const e of runViaAgui({ aguiUrl: mock.url }, { threadId: "t", prompt: "largest planet?" })) {
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

test("runViaAgui: forwardedProps.plurnk carries the selected workspace and its options", async () => {
    const mock = await bootMock((_req, res) => sse(res, [frame({ type: "RUN_FINISHED" })]));
    try {
        const seen: string[] = [];
        for await (const e of runViaAgui({ aguiUrl: mock.url }, { threadId: "t", workspace: "selected", prompt: "hi", forwardedProps: { projectRoot: "/x" } })) seen.push(e.type);
        assert.deepEqual(seen, ["RUN_FINISHED"]);
        assert.deepEqual((mock.captured[0].body as { forwardedProps: unknown }).forwardedProps, { plurnk: { workspace: "selected", projectRoot: "/x" } });
    } finally { await mock.close(); }
});

test("{§cli-workspaces-and-workers}: thread identity never fabricates a workspace selector", async () => {
    const mock = await bootMock((_req, res) => sse(res, [frame({ type: "RUN_FINISHED" })]));
    try {
        for (const threadId of ["opaque-uuid", "42#user"]) {
            for await (const _e of runViaAgui({ aguiUrl: mock.url }, { threadId, prompt: "hi" })) void _e;
            assert.deepEqual((mock.captured.at(-1)!.body as { forwardedProps: unknown }).forwardedProps, { plurnk: {} });
        }
    } finally { await mock.close(); }
});

test("runViaAgui: a PLURNK HTTP failure preserves exact Problem Details", async () => {
    const problem = {
        type: "https://problems.plurnk.xyz/agui/http/bearer-token-required",
        title: "Bearer token required",
        status: 401,
        detail: "A bearer token is required.",
        retryable: false,
    };
    const mock = await bootMock((_req, res) => res.writeHead(401, { "content-type": "application/problem+json" }).end(JSON.stringify(problem)));
    try {
        await assert.rejects(
            async () => { for await (const _e of runViaAgui({ aguiUrl: mock.url }, { threadId: "t", prompt: "hi" })) void _e; },
            (error: unknown) => error instanceof ProblemError
                && error.problem.type === problem.type
                && error.problem.retryable === problem.retryable,
        );
    } finally { await mock.close(); }
});

test("runViaAgui: a foreign non-Problem HTTP failure remains an AG-UI transport error", async () => {
    const mock = await bootMock((_req, res) => res.writeHead(502, { "content-type": "text/plain" }).end("relay failed"));
    try {
        await assert.rejects(
            async () => { for await (const _e of runViaAgui({ aguiUrl: mock.url }, { threadId: "t", prompt: "hi" })) void _e; },
            /HTTP 502:.*relay failed/,
        );
    } finally { await mock.close(); }
});

test("runViaAgui: the standard transport handles comments, CRLF, split chunks, and multiline data", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": keepalive\r\n\r");
        res.write("\ndata: {\"type\":\"RUN_STARTED\",\r\n");
        res.write("data: \"threadId\":\"t\",\"runId\":\"r\"}\r\n\r\n");
        res.end();
    });
    try {
        const seen: string[] = [];
        for await (const event of runViaAgui({ aguiUrl: mock.url }, { threadId: "t", prompt: "hi" })) seen.push(event.type);
        assert.deepEqual(seen, ["RUN_STARTED"]);
    } finally { await mock.close(); }
});

test("runViaAgui: malformed AG-UI events fail at the standard client boundary", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "RUN_FINISHED" })}\n\n`);
        res.end();
    });
    try {
        await assert.rejects(
            async () => {
                for await (const _event of runViaAgui({ aguiUrl: mock.url }, { threadId: "t", prompt: "hi" })) void _event;
            },
            /threadId|runId/,
        );
    } finally { await mock.close(); }
});

test("actionViaAgui: a verb rides its own run and returns its result verbatim", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: " + JSON.stringify({ type: "RUN_FINISHED", threadId: "t", runId: "r", result: { kind: "workspace.list", ok: true, result: { workspaces: [{ id: 1, name: "s" }] } } }) + "\n\n");
        res.end();
    });
    try {
        const out = await actionViaAgui<{ workspaces: Array<{ id: number }> }>({ aguiUrl: mock.url }, { threadId: "t", workspace: "workspace", kind: "workspace.list" });
        assert.equal(out.workspaces[0].id, 1);
        const sent = mock.captured[0].body as { threadId: string; forwardedProps: { plurnk: { workspace: string; action: { kind: string } } } };
        assert.equal(sent.threadId, "t", "the thread continues to name the worker");
        assert.equal(sent.forwardedProps.plurnk.workspace, "workspace", "a worker action retains its workspace selection");
        assert.equal(sent.forwardedProps.plurnk.action.kind, "workspace.list", "the action rides forwardedProps.plurnk.action");
    } finally { await mock.close(); }
});

test("[§cli-workspaces-and-workers] actionViaAgui carries workspace options beside the action", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: " + JSON.stringify({ type: "RUN_FINISHED", threadId: "t", runId: "r", result: { kind: "worker.model.get", ok: true, result: { model: null } } }) + "\n\n");
        res.end();
    });
    try {
        await actionViaAgui({ aguiUrl: mock.url }, {
            threadId: "worker",
            workspace: "workspace",
            workspaceOptions: { projectRoot: "/repo", settings: { filesItems: 16 } },
            kind: "worker.model.get",
        });
        const sent = mock.captured[0].body as {
            forwardedProps: { plurnk: Record<string, unknown> };
        };
        assert.equal(sent.forwardedProps.plurnk.projectRoot, "/repo");
        assert.deepEqual(sent.forwardedProps.plurnk.settings, { filesItems: 16 });
        assert.deepEqual(sent.forwardedProps.plurnk.action, { kind: "worker.model.get" });
    } finally { await mock.close(); }
});

test("actionViaAgui: an action failure throws the exact validated Problem", async () => {
    const problem = {
        type: "https://problems.plurnk.xyz/agui/action/unknown-action",
        title: "Unknown action",
        status: 404,
        detail: "Unknown action 'missing'.",
        recovery: "Use an advertised action.",
        retryable: false,
    };
    const mock = await bootMock((_req, res) => sse(res, [
        frame({ type: "RUN_FINISHED", result: { kind: "missing", ok: false, problem } }),
    ]));
    try {
        await assert.rejects(
            () => actionViaAgui({ aguiUrl: mock.url }, { threadId: "t", kind: "missing" }),
            (error: unknown) => error instanceof ProblemError
                && error.problem.type === problem.type
                && error.problem.recovery === problem.recovery,
        );
    } finally { await mock.close(); }
});

test("actionViaAgui: a missing action result throws an exact client Problem", async () => {
    const mock = await bootMock((_req, res) => sse(res, [frame({ type: "RUN_FINISHED" })]));
    try {
        await assert.rejects(
            () => actionViaAgui({ aguiUrl: mock.url }, { threadId: "t", kind: "workspace.list" }),
            (error: unknown) => error instanceof ProblemError
                && error.problem.type === "https://problems.plurnk.xyz/client/action/result-missing"
                && error.problem.action === "workspace.list",
        );
    } finally { await mock.close(); }
});

test("actionViaAgui: a malformed action result throws an exact client Problem", async () => {
    const mock = await bootMock((_req, res) => sse(res, [
        frame({ type: "RUN_FINISHED", result: { kind: "workspace.list" } }),
    ]));
    try {
        await assert.rejects(
            () => actionViaAgui({ aguiUrl: mock.url }, { threadId: "t", kind: "workspace.list" }),
            (error: unknown) => error instanceof ProblemError
                && error.problem.type === "https://problems.plurnk.xyz/client/action/result-invalid",
        );
    } finally { await mock.close(); }
});

test("[§cli-workspaces-and-workers] runViaAgui: an explicit workspace rides with a DIFFERENT threadId", async () => {
    const mock = await bootMock((_req, res) => sse(res, [frame({ type: "RUN_FINISHED" })]));
    try {
        for await (const _e of runViaAgui({ aguiUrl: mock.url }, { threadId: "chat-2", workspace: "workspace", prompt: "hi" })) void _e;
        const body = mock.captured[0].body as { threadId: string; forwardedProps: { plurnk: { workspace: string } } };
        assert.equal(body.threadId, "chat-2", "the thread names the worker");
        assert.equal(body.forwardedProps.plurnk.workspace, "workspace", "the workspace names the workspace — independently");
    } finally { await mock.close(); }
});

test("{§cli-worker-ownership} runCliViaAgui: a terminal declares a person, and --auto declares nobody", async () => {
    await using lifetime = new Lifetime();
    const { runCliViaAgui } = await import("./agui_cli.ts");
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "RUN_FINISHED", metadata: { plurnk: { terminal: { hitMaxTurns: false, turnIds: [1], result: { status: 200 } } } } }));
        res.end();
    });
    const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
        for (const auto of [false, true]) {
            await runCliViaAgui({ aguiUrl: mock.url }, "hi", { lifetime, threadId: "7#w", workspace: { id: 7, name: "w" }, worker: "w", yolo: true, auto, json: true, statusStream: false });
        }
        const declared = mock.captured.map(({ body }) => {
            const run = body as { tools: { name: string }[]; forwardedProps: { plurnk: { interactive?: boolean } } };
            return [run.forwardedProps.plurnk.interactive, run.tools.map(({ name }) => name)];
        });
        assert.deepEqual(declared, [
            [true, ["question", "mcp_input_required"]],
            [false, []],
        ], "--auto removes the person, and the client tools a person answers");
    } finally {
        if (tty === undefined) delete (process.stdin as { isTTY?: boolean }).isTTY;
        else Object.defineProperty(process.stdin, "isTTY", tty);
        await mock.close();
    }
});

test("[§cli-model-selection][§cli-what-one-shot-mode-does-not-do] runCliViaAgui: bound runs carry per-run controls and owner capabilities, not workspace selection", async () => {
    await using lifetime = new Lifetime();
    const { runCliViaAgui } = await import("./agui_cli.ts");
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "RUN_FINISHED", metadata: { plurnk: { terminal: { hitMaxTurns: false, turnIds: [1], result: { status: 200 } } } } }));
        res.end();
    });
    try {
        await runCliViaAgui({ aguiUrl: mock.url }, "hi", {
            lifetime,
            threadId: "7#w",
            workspace: { id: 7, name: "w" },
            worker: "w",
            maxTurns: 7,
            openPaths: ["README.md", "src/index.ts"],
            yolo: true,
            auto: false,
            json: true,
            statusStream: false,
        });
        const fp = (mock.captured[0].body as { forwardedProps: { plurnk: Record<string, unknown> } }).forwardedProps.plurnk;
        assert.equal(fp.projectRoot, undefined);
        assert.equal(fp.settings, undefined);
        assert.equal(fp.workspace, undefined, "the human-facing label is not sent as a selector");
        assert.equal((mock.captured[0].body as { threadId: string }).threadId, "7#w");
        assert.equal(fp.selector, undefined, "no model selector rides the run — the worker owns the model ({§worker-model-selection})");
        assert.equal(fp.childSelector, undefined);
        const input = mock.captured[0].body as { tools: { name: string }[] };
        assert.deepEqual(input.tools.map(({ name }) => name), [], "with no terminal, no client tool a person answers is declared");
        assert.equal(fp.interactive, false, "with no terminal, nobody attends");
        assert.equal(fp.maxTurns, 7, "the turn ceiling reaches the wire");
        assert.deepEqual(fp.openPaths, ["README.md", "src/index.ts"], "prompt file references reach the wire");
    } finally { await mock.close(); }
});

test("[§cli-workspaces-and-workers] a worker's JSON record retains its workspace identity", async () => {
    await using lifetime = new Lifetime();
    const { runCliViaAgui } = await import("./agui_cli.ts");
    const mock = await bootMock((_req, res) => sse(res, [
        frame({ type: "RUN_FINISHED", metadata: { plurnk: { terminal: {
                workspaceId: 7,
                workerId: 11,
                loopId: 3,
                hitMaxTurns: false,
                turnIds: [1],
                result: { status: 200 },
            } } } }),
    ]));
    const outs: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string, callback?: () => void) => boolean }).write = (s, callback) => {
        outs.push(s);
        if (callback !== undefined) queueMicrotask(callback);
        return true;
    };
    try {
        await runCliViaAgui({ aguiUrl: mock.url }, "hi", {
            lifetime,
            threadId: "user",
            workspace: { id: 7, name: "workspace" },
            worker: "user",
            yolo: true,
            auto: false,
            json: true,
            statusStream: false,
        });
        const doc = JSON.parse(outs.map(String).find((value) => value.startsWith('{"schemaVersion"')) ?? "{}") as {
            workspace?: { id?: number; name?: string };
        };
        assert.deepEqual(doc.workspace, { id: 7, name: "workspace" });
    } finally {
        (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
        await mock.close();
    }
});

test("[§cli-invocation] --timeout fires: the deadline cancels the loop, the record says timedOut, exit is 3", async () => {
    await using lifetime = new Lifetime();
    const { runCliViaAgui } = await import("./agui_cli.ts");
    let cancelSeen = false;
    let holdOpen: (() => void) | null = null;
    const mock = await bootMock((req, res) => {
        const body = (mock.captured[mock.captured.length - 1]?.body ?? {}) as { forwardedProps?: { plurnk?: { action?: { kind?: string } } } };
        if (body.forwardedProps?.plurnk?.action?.kind === "loop.cancel") {
            cancelSeen = true;
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(frame({ type: "RUN_FINISHED", result: { kind: "loop.cancel", ok: true, result: { cancelled: true } } }));
            res.end();
            // The daemon aborts the drain → the held message Run's stream terminates 499.
            if (holdOpen !== null) holdOpen();
            return;
        }
        // The message Run: one row, then HELD OPEN (a loop that never ends on its own).
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of callOf({ id: 1, op: "NOTE", tx: { body: "Work." }, rx: { status: 200 } })) res.write(frame(event));
        holdOpen = () => {
            res.write(frame({ type: "RUN_FINISHED", metadata: { plurnk: { terminal: { hitMaxTurns: false, turnIds: [1], result: { status: 499, problem: { type: "https://problems.plurnk.xyz/lifecycle/cancel/loop-cancelled", title: "Loop cancelled", status: 499, detail: "The loop was cancelled." } } } } } }));
            res.end();
        };
    });
    const outs: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string, callback?: () => void) => boolean }).write = (s, callback) => {
        outs.push(s);
        if (callback !== undefined) queueMicrotask(callback);
        return true;
    };
    try {
        const code = await runCliViaAgui({ aguiUrl: mock.url }, "spin forever", { lifetime, threadId: "7#w", workspace: { id: 7, name: "w" }, worker: "w", timeoutSec: 1, yolo: true, auto: false, json: true, statusStream: false });
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

test("[§cli-output-channels] a dead stream never fabricates finalStatus 200 in the json record", async () => {
    await using lifetime = new Lifetime();
    const { runCliViaAgui } = await import("./agui_cli.ts");
    // The stream dies without terminal truth: no terminated, no RUN_FINISHED.
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of callOf({ id: 1, op: "NOTE", tx: { body: "Work." }, rx: { status: 200 } })) res.write(frame(event));
        res.end();   // abrupt end — no terminal event
    });
    const outs: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string, callback?: () => void) => boolean }).write = (s, callback) => {
        outs.push(s);
        if (callback !== undefined) queueMicrotask(callback);
        return true;
    };
    try {
        const code = await runCliViaAgui({ aguiUrl: mock.url }, "hi", { lifetime, threadId: "7#w", workspace: { id: 7, name: "w" }, worker: "w", yolo: true, auto: false, json: true, statusStream: false });
        const doc = JSON.parse(outs.map(String).find((w) => w.startsWith('{"schemaVersion"')) ?? "{}") as { finalStatus: number };
        assert.notEqual(doc.finalStatus, 200, "no fabricated success on a dead stream");
        assert.notEqual(code, 0, "the exit code is not success either");
    } finally {
        (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
        await mock.close();
    }
});

test("[§cli-credential] runViaAgui acquires the access token through discovery and renews it once when the daemon says invalid_token", async () => {
    let agui = 0;
    const mock = await bootMock((req, res) => {
        const json = (status: number, body: unknown, type = "application/json"): void => { res.writeHead(status, { "content-type": type }); res.end(JSON.stringify(body)); };
        if (req.url === "/.well-known/oauth-protected-resource") return json(200, { resource: `${mock.url}/agui`, authorization_servers: [mock.url] });
        if (req.url === "/.well-known/oauth-authorization-server") return json(200, { issuer: mock.url, token_endpoint: `${mock.url}/oauth/token` });
        if (req.url === "/oauth/token") return json(200, { access_token: "fresh", token_type: "Bearer", expires_in: 60, scope: "agui" });
        agui += 1;
        if (agui === 1) return json(401, { type: "https://problems.plurnk.xyz/agui/http/bearer-token-invalid", title: "Bearer token invalid", status: 401, detail: "The access token is unknown, expired or revoked.", retryable: false }, "application/problem+json");
        return sse(res, [frame({ type: "RUN_STARTED" }), frame({ type: "RUN_FINISHED" })]);
    });
    try {
        const credential = new Credential("s3cret");
        const events: string[] = [];
        for await (const event of runViaAgui({ aguiUrl: `${mock.url}/agui`, credential }, { threadId: "t", prompt: "hi" })) events.push(event.type);
        assert.deepEqual(events, ["RUN_STARTED", "RUN_FINISHED"]);
        assert.deepEqual(mock.captured.map(({ url }) => url), [
            "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server", "/oauth/token", "/agui", "/oauth/token", "/agui",
        ], "discover, mint, refused once, mint again, admitted");
        assert.ok(mock.captured.filter(({ url }) => url === "/agui").every(({ auth }) => auth === "Bearer fresh"));
        await assert.rejects(
            async () => { for await (const _e of runViaAgui({ aguiUrl: `${mock.url}/agui`, credential }, { threadId: "t", prompt: "hi" })) void _e; },
            (error: unknown) => error instanceof ProblemError && /\/bearer-token-invalid$/u.test(error.problem.type),
            "a second refusal in one run is the caller's",
        ).catch(() => undefined);
    } finally { await mock.close(); }
});

// plurnk-service {§agui-words-by-reference}: a sender's words past the ceiling travel as one document part at the address
// that serves them; a receipt that holds a body keeps its text part beside the body's document (plurnk-service {§agui-body-reference}).
test("[§cli-row-sources] runViaAgui reads words that travel by reference at their address, with the Run's credential, and leaves a receipt's body where it is", async () => {
    const words: Record<string, string> = { "log:///1/1/1/SEND": "Pasted words, long past the ceiling.", "log:///1/2/1/SEND": "A reply's words, long past the ceiling." };
    const mock = await bootMock((req, res) => {
        const json = (status: number, body: unknown): void => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
        if (req.url === "/.well-known/oauth-protected-resource") return json(200, { resource: `${mock.url}/agui`, authorization_servers: [mock.url] });
        if (req.url === "/.well-known/oauth-authorization-server") return json(200, { issuer: mock.url, token_endpoint: `${mock.url}/oauth/token` });
        if (req.url === "/oauth/token") return json(200, { access_token: "fresh", token_type: "Bearer", expires_in: 60, scope: "agui" });
        if (req.method === "GET") {
            const target = new URL(req.url ?? "/", mock.url).searchParams.get("target") ?? "";
            res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
            return res.end(words[target]);
        }
        const at = (target: string, mimeType = "text/plain") => [{ type: "document", source: { type: "url", value: `${mock.url}/agui/3/7/entry?target=${encodeURIComponent(target)}`, mimeType } }];
        const receipt = [{ type: "text", text: JSON.stringify({ status: 200 }) }, ...at("log:///1/1/3/READ", "text/markdown")];
        sse(res, [
            frame({ type: "RUN_STARTED" }),
            frame({ type: "MESSAGES_SNAPSHOT", messages: [
                { id: "1/1/1", role: "user", content: at("log:///1/1/1/SEND") },
                { id: "1/1/3", role: "tool", toolCallId: "1/1/2", content: receipt },
            ] }),
            frame({ type: "TOOL_CALL_RESULT", toolCallId: "1/1/9", messageId: "1/2/1", content: at("log:///1/2/1/SEND") }),
            frame({ type: "RUN_FINISHED" }),
        ]);
    });
    try {
        const events: Array<Record<string, unknown>> = [];
        for await (const event of runViaAgui({ aguiUrl: `${mock.url}/agui`, credential: new Credential("s3cret") }, { threadId: "t", prompt: "hi" })) {
            events.push(event as unknown as Record<string, unknown>);
        }
        const snapshot = events.find(({ type }) => type === "MESSAGES_SNAPSHOT") as { messages: Array<{ content: unknown }> } | undefined;
        assert.equal(snapshot?.messages[0]?.content, words["log:///1/1/1/SEND"], "a snapshot's message carries its words");
        assert.ok(Array.isArray(snapshot?.messages[1]?.content) && snapshot.messages[1].content.length === 2, "a receipt's body stays by reference");
        assert.equal(events.find(({ type }) => type === "TOOL_CALL_RESULT")?.content, words["log:///1/2/1/SEND"], "a reply's result carries its words");
        const reads = mock.captured.filter(({ method, url }) => method === "GET" && url?.startsWith("/agui/") === true);
        assert.deepEqual(reads.map(({ url }) => new URL(url ?? "/", mock.url).searchParams.get("target")), ["log:///1/1/1/SEND", "log:///1/2/1/SEND"],
            "each sender's words read once, and no body");
        assert.ok(reads.every(({ auth }) => auth === "Bearer fresh"), "with the access token the Run was posted with");
    } finally { await mock.close(); }
});

test("[§cli-row-sources] runViaAgui: words whose address answers a Problem end the Run with that exact Problem", async () => {
    const mock = await bootMock((req, res) => {
        if (req.method === "GET") {
            res.writeHead(404, { "content-type": "application/problem+json" });
            return res.end(JSON.stringify({ type: "https://problems.plurnk.xyz/agui/http/entry-not-found", title: "Entry not found", status: 404, detail: "No row holds those words.", retryable: false }));
        }
        sse(res, [frame({ type: "RUN_STARTED" }), frame({ type: "TOOL_CALL_RESULT", toolCallId: "1/1/9", messageId: "1/2/1",
            content: [{ type: "document", source: { type: "url", value: `${mock.url}/agui/3/7/entry?target=log%3A%2F%2F%2F1%2F2%2F1%2FSEND`, mimeType: "text/plain" } }] }), frame({ type: "RUN_FINISHED" })]);
    });
    try {
        await assert.rejects(async () => { for await (const _e of runViaAgui({ aguiUrl: `${mock.url}/agui` }, { threadId: "t", prompt: "hi" })) void _e; },
            (error: unknown) => error instanceof ProblemError && error.problem.type === "https://problems.plurnk.xyz/agui/http/entry-not-found");
    } finally { await mock.close(); }
});
