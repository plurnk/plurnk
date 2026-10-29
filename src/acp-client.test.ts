import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { AcpClient } from "./acp-client.ts";
import Credential from "./credential.ts";

test("{§cli-conformance} {§cli-session-status}: AcpClient auto-reconnects and reattaches bound sessions when the connection SSE stream closes while idle", async () => {
    const sseResponses = new Set<http.ServerResponse>();
    const resumedSessions: string[] = [];
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
            resumedSessions.push(params.sessionId);
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
    const client = new AcpClient({
        url: `http://127.0.0.1:${String(addr.port)}/acp`,
        token: "test-token",
        onDisconnect: () => {
            disconnects += 1;
        },
        onSessionUpdate: (notification) => {
            if (
                SessionUpdate.isAgentMessageChunk(notification.update) &&
                ContentBlock.isText(notification.update.content)
            ) {
                receivedTexts.push(notification.update.content.text);
            }
        },
    });

    try {
        await client.connect();
        assert.equal(initializeCount, 1);

        const created = await client.newSession("/tmp/ws");
        assert.equal(created.sessionId, "1#user");

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
        // (suppressing duplicate replay notifications), and delivers the new turn.
        await client.prompt("1#user", "second turn after idle drop");
        assert.equal(initializeCount, 2, "client re-initialized a new ACP connection");
        assert.deepEqual(resumedSessions, ["1#user"], "bound session was automatically resumed");
        assert.deepEqual(promptsReceived, ["first turn", "second turn after idle drop"]);
        assert.deepEqual(
            receivedTexts,
            ["Reply: first turn", "Reply: second turn after idle drop"],
            "replay chunks during silent reattach are suppressed while live turn chunks arrive",
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
                    title: "EDIT a.ts",
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

