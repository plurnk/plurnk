import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
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
