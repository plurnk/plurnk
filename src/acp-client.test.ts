import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { createNodeHttpHandler } from "@agentclientprotocol/sdk/experimental/node";
import {
    agent as createAcpAgent,
    ContentBlock,
    methods,
    PROTOCOL_VERSION,
    SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    ACP_ACTION_KINDS,
    AcpClient,
    classifyPreFlightDisconnect,
} from "./acp-client.ts";
import { AcpSession, type AcpMessageItem, type AcpPlanState } from "./acp-session.ts";
import { runCliConfig } from "./cli-subcommands.ts";
import Credential from "./credential.ts";

test("{§cli-conformance} {§cli-session-status}: AcpClient auto-reconnects with replayFrom start and AcpSession idempotently materializes missed turns without duplicating prior ones", async () => {
    const sseResponses = new Set<http.ServerResponse>();
    const resumedCalls: Array<{ sessionId: string; replayFrom: unknown }> = [];
    const promptsReceived: string[] = [];
    let initializeCount = 0;

    const agentApp = createAcpAgent({ name: "mock-acp-service" })
        .onRequest(methods.agent.initialize, async () => {
            initializeCount += 1;
            return {
                protocolVersion: PROTOCOL_VERSION,
                info: { name: "@plurnk/plurnk-service", version: "1.0.0" },
                capabilities: {
                    session: {
                        fork: {},
                        delete: {},
                        prompt: { image: {}, embeddedContext: {} },
                    },
                },
            };
        })
        .onRequest(methods.agent.session.new, async () => ({
            sessionId: "1#user",
            configOptions: [],
        }))
        .onRequest(methods.agent.session.resume, async ({ params, client }) => {
            resumedCalls.push({ sessionId: params.sessionId, replayFrom: params.replayFrom });
            // Replay both the already-seen first turn and a turn missed while disconnected.
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: "msg-1",
                    content: { type: "text", text: "Reply: first turn" },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: "replay-1",
                    content: { type: "text", text: "Replayed history message" },
                },
            });
            return { configOptions: [] };
        })
        .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
            const first = params.prompt[0];
            const text = first && "text" in first && typeof first.text === "string" ? first.text : "";
            promptsReceived.push(text);
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: `msg-${String(promptsReceived.length)}`,
                    content: { type: "text", text: `Reply: ${text}` },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "state_update",
                    state: "idle",
                    stopReason: "end_turn",
                },
            });
            return { messageId: `msg-${String(promptsReceived.length)}` };
        });

    const acpServer = new AcpServer({ agent: agentApp });
    const handler = createNodeHttpHandler(acpServer);
    const httpServer = http.createServer((req, res) => {
        if (req.method === "GET") {
            sseResponses.add(res);
            res.once("close", () => sseResponses.delete(res));
        }
        handler(req, res);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const addr = httpServer.address();
    assert.ok(addr && typeof addr === "object");

    const receivedTexts: string[] = [];
    let disconnects = 0;
    let session: AcpSession | null = null;
    const client = new AcpClient({
        url: `http://127.0.0.1:${String(addr.port)}/acp`,
        token: "test-token",
        onDisconnect: () => {
            disconnects += 1;
            session?.endActiveStream();
        },
        onSessionUpdate: (notification) => {
            session?.applyUpdate(notification.update);
        },
    });

    try {
        await client.connect();
        assert.equal(initializeCount, 1);

        const created = await client.newSession("/tmp/ws");
        assert.equal(created.sessionId, "1#user");
        session = new AcpSession(created.sessionId);
        session.onUpdate((update) => {
            if (SessionUpdate.isAgentMessageChunk(update) && ContentBlock.isText(update.content)) {
                receivedTexts.push(update.content.text);
            }
        });

        await client.prompt("1#user", "first turn");
        assert.deepEqual(promptsReceived, ["first turn"]);
        assert.deepEqual(receivedTexts, ["Reply: first turn"]);

        // Simulate idle SSE connection stream closing on the server
        for (const res of [...sseResponses]) {
            res.end();
        }
        await client.closed;
        assert.equal(disconnects, 1);

        // Next prompt automatically reconnects, reattaches "1#user" via session/resume
        // with replayFrom: { type: "start" }, idempotently deduplicating "msg-1" while
        // materializing missed "replay-1" and delivering the new turn.
        await client.prompt("1#user", "second turn after idle drop");
        assert.equal(initializeCount, 2, "client re-initialized a new ACP connection");
        assert.deepEqual(
            resumedCalls,
            [{ sessionId: "1#user", replayFrom: { type: "start" } }],
            "bound session was automatically resumed with replayFrom: start",
        );
        assert.deepEqual(promptsReceived, ["first turn", "second turn after idle drop"]);
        assert.deepEqual(
            receivedTexts,
            ["Reply: first turn", "Replayed history message", "Reply: second turn after idle drop"],
            "already-settled msg-1 is deduplicated while missed replay-1 and new msg-2 are materialized",
        );
        assert.deepEqual(
            session.items.map((item) => (item.kind === "agent_message" ? item.text : "")),
            ["Reply: first turn", "Replayed history message", "Reply: second turn after idle drop"],
        );
    } finally {
        client.close();
        await acpServer.close();
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
});

test("{§cli-problems-and-notices}: AcpClient refreshes an expired or rotated bearer token on 401 bearer-token-invalid and retries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plurnk-cred-test-"));
    const secretFile = join(dir, "secret");
    writeFileSync(secretFile, "secret-1\n", "utf8");

    let expectedSecret = "secret-1";
    let issuedTokenCounter = 0;
    let validToken = "";
    const promptsReceived: string[] = [];

    const agentApp = createAcpAgent({ name: "mock-acp-service" })
        .onRequest(methods.agent.initialize, async () => ({
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "@plurnk/plurnk-service", version: "1.0.0" },
            capabilities: {
                session: {
                    fork: {},
                    delete: {},
                    prompt: { image: {}, embeddedContext: {} },
                },
            },
        }))
        .onRequest(methods.agent.session.new, async () => ({
            sessionId: "1#user",
            configOptions: [],
        }))
        .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
            const first = params.prompt[0];
            const text = first && "text" in first && typeof first.text === "string" ? first.text : "";
            promptsReceived.push(text);
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "state_update",
                    state: "idle",
                    stopReason: "end_turn",
                },
            });
            return { messageId: `msg-${String(promptsReceived.length)}` };
        });

    const acpServer = new AcpServer({ agent: agentApp });
    const handler = createNodeHttpHandler(acpServer);
    const httpServer = http.createServer((req, res) => {
        if (req.url === "/oauth/token" && req.method === "POST") {
            let body = "";
            req.on("data", (chunk) => {
                body += String(chunk);
            });
            req.on("end", () => {
                const params = new URLSearchParams(body);
                if (params.get("client_secret") !== expectedSecret) {
                    res.writeHead(401, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "invalid_client" }));
                    return;
                }
                issuedTokenCounter += 1;
                validToken = `tok-${String(issuedTokenCounter)}`;
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ access_token: validToken, expires_in: 3600 }));
            });
            return;
        }
        if (req.headers.authorization !== `Bearer ${validToken}`) {
            res.writeHead(401, { "content-type": "application/problem+json" });
            res.end(
                JSON.stringify({
                    code: "acp/http/bearer-token-invalid",
                    stage: "authorization",
                    recovery: "Obtain a new access token from this daemon's token endpoint.",
                    retryable: false,
                    type: "https://problems.plurnk.xyz/acp/http/bearer-token-invalid",
                    title: "Bearer token invalid",
                    status: 401,
                    detail: "The access token is unknown, expired or revoked.",
                }),
            );
            return;
        }
        handler(req, res);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const addr = httpServer.address();
    assert.ok(addr && typeof addr === "object");

    const client = new AcpClient({
        url: `http://127.0.0.1:${String(addr.port)}/acp`,
        credential: new Credential({ PLURNK_SERVICE_DB_PATH: join(dir, "plurnk.db") }),
    });

    try {
        await client.connect();
        assert.equal(issuedTokenCounter, 1);

        const created = await client.newSession("/tmp/ws");
        assert.equal(created.sessionId, "1#user");

        await client.prompt("1#user", "turn before token expiry");
        assert.deepEqual(promptsReceived, ["turn before token expiry"]);

        // Simulate token expiry and secret rotation on disk: the server rejects tok-1 with 401 bearer-token-invalid
        expectedSecret = "secret-2";
        writeFileSync(secretFile, "secret-2\n", "utf8");
        validToken = "expired";

        await client.prompt("1#user", "turn after token expiry");
        assert.equal(issuedTokenCounter, 2, "client exchanged rotated secret for a fresh access token on 401");
        assert.deepEqual(promptsReceived, ["turn before token expiry", "turn after token expiry"]);
    } finally {
        client.close();
        await acpServer.close();
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
        rmSync(dir, { recursive: true, force: true });
    }
});

test("{§cli-inline-review}: passive AcpClient without permission or elicitation handlers rejects incoming gate requests instead of cancelling them", async () => {
    let permissionOutcome: string | undefined;
    let elicitationOutcome: string | undefined;

    const agentApp = createAcpAgent({ name: "mock-acp-service" })
        .onRequest(methods.agent.initialize, async () => ({
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "@plurnk/plurnk-service", version: "1.0.0" },
            capabilities: {
                session: {
                    fork: {},
                    delete: {},
                    prompt: { image: {}, embeddedContext: {} },
                },
            },
        }))
        .onRequest(methods.agent.session.resume, async ({ params, client }) => {
            try {
                const permRes = await client.request(methods.client.session.requestPermission, {
                    sessionId: params.sessionId,
                    title: "edit a.ts",
                    description: "Review the requested action.",
                    subject: {
                        type: "command",
                        command: "ls",
                        cwd: "/tmp",
                    },
                    options: [
                        { optionId: "allow_once", name: "Allow Once", kind: "allow_once" },
                        { optionId: "reject_once", name: "Reject Once", kind: "reject_once" },
                    ],
                });
                permissionOutcome = permRes.outcome.outcome;
            } catch (err) {
                permissionOutcome = `rejected:${err instanceof Error ? err.message : String(err)}`;
            }

            try {
                const elicitRes = await client.request(methods.client.elicitation.create, {
                    scope: "session",
                    sessionId: params.sessionId,
                    mode: "form",
                    message: "Answer question",
                    requestedSchema: { type: "object", properties: {} },
                });
                elicitationOutcome = elicitRes.action;
            } catch (err) {
                elicitationOutcome = `rejected:${err instanceof Error ? err.message : String(err)}`;
            }

            return { configOptions: [] };
        });

    const acpServer = new AcpServer({ agent: agentApp });
    const handler = createNodeHttpHandler(acpServer);
    const httpServer = http.createServer(handler);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const addr = httpServer.address();
    assert.ok(addr && typeof addr === "object");

    const client = new AcpClient({
        url: `http://127.0.0.1:${String(addr.port)}/acp`,
        token: "test-token",
    });

    try {
        await client.connect();
        await client.resumeSession("1#user", "/tmp/ws");
        assert.ok(permissionOutcome?.startsWith("rejected:"), `expected permission request to reject, got ${String(permissionOutcome)}`);
        assert.ok(elicitationOutcome?.startsWith("rejected:"), `expected elicitation request to reject, got ${String(elicitationOutcome)}`);
    } finally {
        client.close();
        await acpServer.close();
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
});

test("{§cli-problems-and-notices} {§cli-conformance}: classifyPreFlightDisconnect classifies structured HTTP/JSON-RPC status and conn.signal.aborted without substring matching on server prose", () => {
    const activeController = new AbortController();
    const abortedController = new AbortController();
    abortedController.abort();

    // 404 HttpResponseError -> stale connection (expired Acp-Connection-Id)
    assert.deepEqual(
        classifyPreFlightDisconnect(
            Object.assign(new Error("HTTP 404"), { status: 404, body: '{"status":404}' }),
            activeController.signal,
        ),
        { staleConnection: true, credentialInvalid: false },
    );

    // 401 HttpResponseError or structured ProblemDetails code -> stale connection + credentialInvalid
    assert.deepEqual(
        classifyPreFlightDisconnect(
            Object.assign(new Error("HTTP 401"), {
                status: 401,
                body: JSON.stringify({ code: "acp/http/bearer-token-invalid" }),
            }),
            activeController.signal,
        ),
        { staleConnection: true, credentialInvalid: true },
    );
    assert.deepEqual(
        classifyPreFlightDisconnect(
            Object.assign(new Error("RPC error"), {
                code: -32000,
                data: { code: "acp/http/credential-revoked" },
            }),
            activeController.signal,
        ),
        { staleConnection: true, credentialInvalid: true },
    );

    // 409 Conflict -> domain refusal, never a stale connection even if signal is aborted
    assert.deepEqual(
        classifyPreFlightDisconnect(
            Object.assign(new Error("Conflict"), {
                code: -32603,
                data: { status: 409, body: "session conflict" },
            }),
            abortedController.signal,
        ),
        { staleConnection: false, credentialInvalid: false },
    );

    // Domain 404 ProblemDetails (e.g. alias-not-found or persona-not-found) -> domain error, never a stale connection
    assert.deepEqual(
        classifyPreFlightDisconnect(
            Object.assign(new Error("Provider alias 'granite' is not declared."), {
                code: -32602,
                data: {
                    type: "https://problems.plurnk.xyz/daemon/provider/alias-not-found",
                    title: "Provider alias not found",
                    status: 404,
                },
            }),
            activeController.signal,
        ),
        { staleConnection: false, credentialInvalid: false },
    );

    // Domain JSON-RPC error whose prose happens to mention "Unknown Acp-Connection-Id" or "bearer-token-invalid"
    // on an active connection must NOT trigger a false-positive reconnect
    assert.deepEqual(
        classifyPreFlightDisconnect(
            Object.assign(
                new Error("Invalid params: Unknown Acp-Connection-Id or bearer-token-invalid in prompt text"),
                { code: -32602 },
            ),
            activeController.signal,
        ),
        { staleConnection: false, credentialInvalid: false },
    );

    // Aborted connection signal or SDK uncoded "ACP HTTP stream is closed" Error -> stale connection
    assert.deepEqual(
        classifyPreFlightDisconnect(new Error("socket hang up"), abortedController.signal),
        { staleConnection: true, credentialInvalid: false },
    );
    assert.deepEqual(
        classifyPreFlightDisconnect(new Error("ACP HTTP stream is closed"), activeController.signal),
        { staleConnection: true, credentialInvalid: false },
    );
});

test("{§cli-conformance}: PlurnkActionMap and ACP_ACTION_KINDS match conformance/acp-client.json actions 1-to-1", () => {
    const ledger = JSON.parse(
        readFileSync(new URL("../conformance/acp-client.json", import.meta.url), "utf8"),
    ) as { actions: Record<string, unknown> };
    const ledgerKinds = Object.keys(ledger.actions).sort();
    const typedKinds = [...ACP_ACTION_KINDS].sort();
    assert.deepEqual(typedKinds, ledgerKinds);
});

test("{§cli-conformance}: AcpSession.applyUpdate upserts matching messageId items in place across interleaved chunks and full message updates (#236)", () => {
    const session = new AcpSession("1#user");

    session.applyUpdate({
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought-1",
        content: { type: "text", text: "First part. " },
    });
    // Interleaved tool_call_update clears #activeStreamMessage
    session.applyUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "1/1/1",
        title: "read (workspace:///README.md)",
        status: "completed",
    });
    // Subsequent thought delta with the same messageId appends in place rather than pushing a duplicate item
    session.applyUpdate({
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought-1",
        content: { type: "text", text: "Second part." },
    });
    const thoughts = session.items.filter((i): i is AcpMessageItem => i.kind === "agent_thought");
    assert.equal(thoughts.length, 1);
    assert.equal(thoughts[0]?.id, "thought-1");
    assert.equal(thoughts[0]?.text, "First part. Second part.");

    // Full message upsert with modified content for an existing messageId patches in place
    session.applyUpdate({
        sessionUpdate: "agent_message",
        messageId: "1/1/2",
        content: [{ type: "text", text: "Initial reply" }],
    });
    session.applyUpdate({
        sessionUpdate: "agent_message",
        messageId: "1/1/2",
        content: [{ type: "text", text: "Edited reply" }],
    });
    const replies = session.items.filter((i): i is AcpMessageItem => i.kind === "agent_message");
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.id, "1/1/2");
    assert.equal(replies[0]?.text, "Edited reply");

    // Plan updates and removals key by planId, supporting items, markdown, and file variants
    session.applyUpdate({
        sessionUpdate: "plan_update",
        plan: { type: "markdown", planId: "mem:///plan", content: "# Memory Plan" },
    });
    session.applyUpdate({
        sessionUpdate: "plan_update",
        plan: { type: "file", planId: "file:///workspace/plan.md", uri: "file:///workspace/plan.md" },
    });
    const plansBeforeRemove = session.items.filter((i): i is AcpPlanState => i.kind === "plan");
    assert.equal(plansBeforeRemove.length, 2);
    session.applyUpdate({
        sessionUpdate: "plan_removed",
        planId: "mem:///plan",
    });
    const plansAfterRemove = session.items.filter((i): i is AcpPlanState => i.kind === "plan");
    assert.equal(plansAfterRemove.length, 1);
    assert.deepEqual(plansAfterRemove[0]?.plan, {
        type: "file",
        planId: "file:///workspace/plan.md",
        uri: "file:///workspace/plan.md",
    });

    // SubagentUpdate patches capabilities, cwd, and additionalDirectories
    session.applyUpdate({
        sessionUpdate: "subagent_update",
        sessionId: "1#worker",
        title: "worker",
        capabilities: { cancel: {} },
        state: { state: "running" },
        cwd: "/workspace/child",
        additionalDirectories: ["/workspace/shared"],
    });
    const sub = session.subagents.get("1#worker");
    assert.deepEqual(sub?.capabilities, { cancel: {} });
    assert.equal(sub?.cwd, "/workspace/child");
    assert.deepEqual(sub?.additionalDirectories, ["/workspace/shared"]);
});

test("{§cli-subcommands}: runCliConfig rejects unknown session config option ids with exitCode 64 and points daemon config queries to plurnk-service config", async () => {
    const configOptions = [
        {
            type: "select" as const,
            configId: "model",
            name: "Model",
            currentValue: "fast",
            options: [{ value: "fast", name: "fast" }],
        },
        {
            type: "boolean" as const,
            configId: "yolo",
            name: "YOLO",
            currentValue: false,
        },
    ];
    const agentApp = createAcpAgent({ name: "mock-acp-service" })
        .onRequest(methods.agent.initialize, async () => ({
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "@plurnk/plurnk-service", version: "1.0.0" },
            capabilities: {
                session: {
                    fork: {},
                    delete: {},
                    prompt: { image: {}, embeddedContext: {} },
                },
            },
        }))
        .onRequest(methods.agent.session.new, async () => ({
            sessionId: "1#user",
            configOptions,
        }));

    const acpServer = new AcpServer({ agent: agentApp });
    const handler = createNodeHttpHandler(acpServer);
    const httpServer = http.createServer(handler);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const addr = httpServer.address();
    assert.ok(addr && typeof addr === "object");

    const baseOpts = {
        url: `http://127.0.0.1:${String(addr.port)}/acp`,
        explicitAcpUrl: true,
        host: "127.0.0.1",
        port: addr.port,
        credential: new Credential({}),
        env: { PLURNK_CLIENT_TOKEN: "test-token" },
        cwd: "/tmp/ws",
        workspace: "ws",
        sessionId: "user",
        tuiSession: "user",
        autostart: false,
        daemonTimeoutMs: 500,
        oauthTimeoutMs: 500,
        cancelGraceMs: 500,
        yolo: false,
        auto: false,
        bell: false,
        json: false,
        statusStream: false,
        previewLines: 5,
        historyEntries: 20,
        mermaidTimeoutMs: 500,
        color: "auto" as const,
    };

    try {
        await assert.rejects(
            () => runCliConfig("defaults", undefined, baseOpts),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.equal((err as { exitCode?: number }).exitCode, 64);
                assert.match(err.message, /Unknown session config option "defaults" \(available: model, yolo\)/);
                assert.match(err.message, /plurnk-service config defaults/);
                return true;
            },
        );
        await assert.rejects(
            () => runCliConfig("unknown_key", undefined, baseOpts),
            (err: unknown) => {
                assert.ok(err instanceof Error);
                assert.equal((err as { exitCode?: number }).exitCode, 64);
                assert.match(err.message, /Unknown session config option "unknown_key" \(available: model, yolo\)/);
                assert.match(err.message, /plurnk-service config/);
                return true;
            },
        );
    } finally {
        await acpServer.close();
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
});




