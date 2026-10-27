import assert from "node:assert/strict";
import http from "node:http";
import type { Socket } from "node:net";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createNodeHttpHandler } from "@agentclientprotocol/sdk/experimental/node";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import {
    agent as createAcpAgent,
    methods,
    PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { runCliPrompt, runTuiViewport, type CliCommonOptions } from "../../src/cli-runner.ts";
import Credential from "../../src/credential.ts";

const makeOptions = (url: string, overrides?: Partial<CliCommonOptions>): CliCommonOptions => ({
    url,
    explicitAcpUrl: true,
    host: "127.0.0.1",
    port: 1066,
    credential: new Credential({ accessToken: "tok-disconnect", env: "/" }),
    env: {},
    cwd: "/tmp",
    workspace: "ws",
    sessionId: "user",
    tuiSession: "user",
    autostart: false,
    daemonTimeoutMs: 2000,
    oauthTimeoutMs: 2000,
    cancelGraceMs: 500,
    yolo: true,
    auto: false,
    bell: false,
    json: true,
    statusStream: false,
    previewLines: 10,
    historyEntries: 0,
    mermaidTimeoutMs: 1000,
    color: "never",
    ...overrides,
});

const collectStream = (stream: PassThrough): (() => string) => {
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
        buf += chunk;
    });
    return () => buf;
};

type CutoffMode = "eof" | "socket" | "reported-problem" | "terminal";

const runOneShotDisconnectScenario = async (mode: CutoffMode) => {
    let promptCount = 0;
    const activeSockets = new Set<Socket>();

    const agentApp = createAcpAgent({ name: "disconnect-acp-agent" })
        .onRequest(methods.agent.initialize, async () => ({
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "@plurnk/plurnk-service", version: "1.0.0" },
            capabilities: { session: {} },
        }))
        .onRequest(methods.agent.session.new, async () => ({
            sessionId: "ws#user",
            configOptions: [],
            _meta: {
                plurnk: {
                    workspace: { name: "ws", projectRoot: "/tmp" },
                    sessionName: "user",
                },
            },
        }))
        .onRequest(methods.agent.session.prompt, async ({ client, params }) => {
            promptCount += 1;
            setImmediate(async () => {
                try {
                    await client.notify(methods.client.session.update, {
                        sessionId: params.sessionId,
                        update: {
                            sessionUpdate: "state_update",
                            state: "running",
                            _meta: { plurnk: { loopSeq: 1 } },
                        },
                    });
                    await client.notify(methods.client.session.update, {
                        sessionId: params.sessionId,
                        update: {
                            sessionUpdate: "usage_update",
                            used: 4100,
                            size: 100000,
                            _meta: {
                                plurnk: {
                                    turn: 1,
                                    turnUsage: { inputTokens: 100, outputTokens: 25 },
                                    curation: { weight: 320, budget: 2000 },
                                },
                            },
                        },
                    });
                    await client.notify(methods.client.session.update, {
                        sessionId: params.sessionId,
                        update: {
                            sessionUpdate: "tool_call_update",
                            toolCallId: "log:///loops/1/turns/1/ops/1",
                            name: "READ",
                            title: "READ file:///a.txt",
                            status: "completed",
                            locations: [{ path: "file:///a.txt" }],
                            content: [{ type: "content", content: { type: "text", text: "alpha" } }],
                            _meta: {
                                plurnk: {
                                    id: 101,
                                    turnId: 1,
                                    op: "READ",
                                    origin: "model",
                                    status: 200,
                                    scope: null,
                                    coordinate: "log:///loops/1/turns/1/ops/1",
                                },
                            },
                        },
                    });
                    await client.notify(methods.client.session.update, {
                        sessionId: params.sessionId,
                        update: {
                            sessionUpdate: "agent_message_chunk",
                            messageId: "m-1",
                            content: { type: "text", text: "partial answer" },
                            _meta: {
                                plurnk: {
                                    id: 102,
                                    turnId: 1,
                                    op: "SEND",
                                    origin: "model",
                                    status: 200,
                                    scope: null,
                                    coordinate: "log:///loops/1/turns/1/ops/2",
                                },
                            },
                        },
                    });

                    if (mode === "reported-problem") {
                        await client.notify(methods.client.session.update, {
                            sessionId: params.sessionId,
                            update: {
                                sessionUpdate: "notice",
                                severity: "error",
                                title: "Service stopping",
                                description: "The service is shutting down.",
                                _meta: {
                                    plurnk: {
                                        problem: {
                                            type: "https://problems.plurnk.xyz/service/stopping",
                                            title: "Service stopping",
                                            status: 503,
                                            detail: "The service is shutting down.",
                                        },
                                    },
                                },
                            },
                        });
                    }

                    if (mode === "terminal") {
                        await client.notify(methods.client.session.update, {
                            sessionId: params.sessionId,
                            update: {
                                sessionUpdate: "state_update",
                                state: "idle",
                                stopReason: "end_turn",
                                _meta: {
                                    plurnk: {
                                        loopSeq: 1,
                                        terminal: {
                                            status: 200,
                                            turnCount: 1,
                                            usage: {
                                                inputTokens: 100,
                                                outputTokens: 25,
                                            },
                                        },
                                    },
                                },
                            },
                        });
                        return;
                    }

                    await new Promise((r) => setTimeout(r, 20));
                    if (mode === "socket") {
                        for (const sock of activeSockets) {
                            sock.destroy();
                        }
                    } else {
                        await acpServer.close();
                        httpServer.closeAllConnections();
                    }
                } catch {
                    // Stream intentionally cut off
                }
            });
            return { stopReason: "end_turn", messageId: "msg-1" };
        });

    const acpServer = new AcpServer({ agent: agentApp });
    const handler = createNodeHttpHandler(acpServer);
    const httpServer = http.createServer((req, res) => {
        if (req.url === "/acp") {
            handler(req, res);
            return;
        }
        res.writeHead(404).end();
    });
    httpServer.on("connection", (sock) => {
        activeSockets.add(sock);
        sock.on("close", () => activeSockets.delete(sock));
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
    const addr = httpServer.address() as { port: number };
    const url = `http://127.0.0.1:${addr.port}/acp`;

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const events = new PassThrough();
    const reasoning = new PassThrough();
    const getStdout = collectStream(stdout);
    const getStderr = collectStream(stderr);

    try {
        const code = await runCliPrompt("do work", makeOptions(url), {
            stdout,
            stderr,
            events,
            reasoning,
        });
        return {
            code,
            promptCount,
            record: JSON.parse(getStdout()) as Record<string, unknown>,
            stderr: getStderr(),
        };
    } finally {
        await acpServer.close().catch(() => {});
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
};

test(
    "{§cli-output-channels} {§cli-problems-and-notices} {§cli-conformance}: one-shot --json mid-turn stream cutoffs preserve observed turns and response without replaying the prompt or promoting partial usage",
    async () => {
        const cases: ReadonlyArray<{
            readonly mode: CutoffMode;
            readonly settled: boolean;
            readonly expectedStatus: number;
            readonly expectedProblemType: string | null;
            readonly expectedDetail?: string;
        }> = [
            {
                mode: "eof",
                settled: false,
                expectedStatus: 502,
                expectedProblemType: "https://problems.plurnk.xyz/client/transport/terminal-missing",
            },
            {
                mode: "socket",
                settled: false,
                expectedStatus: 502,
                expectedProblemType: "https://problems.plurnk.xyz/client/transport/terminal-missing",
            },
            {
                mode: "reported-problem",
                settled: false,
                expectedStatus: 503,
                expectedProblemType: "https://problems.plurnk.xyz/service/stopping",
                expectedDetail: "The service is shutting down.",
            },
            {
                mode: "terminal",
                settled: true,
                expectedStatus: 200,
                expectedProblemType: null,
            },
        ];

        for (const c of cases) {
            const { code, promptCount, record } = await runOneShotDisconnectScenario(c.mode);
            assert.equal(promptCount, 1, `${c.mode}: never replays the prompt`);
            assert.equal(record.response, "partial answer", `${c.mode}: preserves observed response`);
            assert.deepEqual(
                record.turns,
                [
                    {
                        turnId: 1,
                        ops: [
                            {
                                id: 101,
                                op: "READ",
                                origin: "model",
                                status: 200,
                                scope: null,
                                coordinate: "log:///loops/1/turns/1/ops/1",
                            },
                            {
                                id: 102,
                                op: "SEND",
                                origin: "model",
                                status: 200,
                                scope: null,
                                coordinate: "log:///loops/1/turns/1/ops/2",
                            },
                        ],
                    },
                ],
                `${c.mode}: preserves observed turns`,
            );
            assert.equal(
                record.usage !== null,
                c.settled,
                `${c.mode}: partial turn usage is never promoted to loop usage without a terminal event`,
            );
            assert.equal(record.finalStatus, c.expectedStatus, `${c.mode}: finalStatus`);

            if (c.settled) {
                assert.equal(code, 0, `${c.mode}: exits 0`);
                assert.equal(record.problem, null, `${c.mode}: no problem on settled 200`);
            } else {
                assert.notEqual(code, 0, `${c.mode}: exits non-zero`);
                const problem = record.problem as Record<string, unknown> | null;
                assert.ok(problem !== null && typeof problem === "object", `${c.mode}: surfaces problem object`);
                assert.equal(problem.type, c.expectedProblemType, `${c.mode}: problem type`);
                if (c.expectedDetail !== undefined) {
                    assert.equal(problem.detail, c.expectedDetail, `${c.mode}: problem detail`);
                }
            }
        }
    },
);

test(
    "{§cli-session-status} {§cli-rendering}: TUI viewport surfaces 🔌 on disconnect, diagnoses a stopping daemon once, and preserves a completed loop summary without duplication",
    async () => {
        for (const phase of ["active", "idle"] as const) {
            const phaseReached = Promise.withResolvers<void>();
            const agentApp = createAcpAgent({ name: `tui-disconnect-${phase}` })
                .onRequest(methods.agent.initialize, async () => ({
                    protocolVersion: PROTOCOL_VERSION,
                    info: { name: "@plurnk/plurnk-service", version: "1.0.0" },
                    capabilities: { session: {} },
                }))
                .onRequest(methods.agent.session.new, async () => ({
                    sessionId: "ws#user",
                    configOptions: [],
                    _meta: {
                        plurnk: {
                            workspace: { name: "ws", projectRoot: "/tmp" },
                            sessionName: "user",
                        },
                    },
                }))
                .onRequest(
                    "_plurnk/action",
                    (raw) => raw as { kind?: string },
                    async ({ params }) => {
                        if (params.kind === "workspace.sessions") {
                            return { sessions: [{ id: 1, name: "user", lifecycle: "idle" }] };
                        }
                        if (params.kind === "workspace.list") {
                            return { workspaces: [{ id: 1, name: "ws" }] };
                        }
                        return {};
                    },
                )
                .onRequest(methods.agent.session.prompt, async ({ client, params }) => {
                    setImmediate(async () => {
                        try {
                            await client.notify(methods.client.session.update, {
                                sessionId: params.sessionId,
                                update: {
                                    sessionUpdate: "state_update",
                                    state: "running",
                                    _meta: { plurnk: { loopSeq: 1 } },
                                },
                            });
                            await client.notify(methods.client.session.update, {
                                sessionId: params.sessionId,
                                update: {
                                    sessionUpdate: "usage_update",
                                    used: 4100,
                                    size: 100000,
                                    _meta: {
                                        plurnk: {
                                            turn: 1,
                                            turnUsage: { inputTokens: 100, outputTokens: 25 },
                                            curation: { weight: 320, budget: 2000 },
                                        },
                                    },
                                },
                            });
                            await client.notify(methods.client.session.update, {
                                sessionId: params.sessionId,
                                update: {
                                    sessionUpdate: "agent_message_chunk",
                                    messageId: "m-1",
                                    content: { type: "text", text: "partial answer" },
                                    _meta: { plurnk: { id: 102, turnId: 1, op: "SEND", status: 200 } },
                                },
                            });
                            if (phase === "idle") {
                                await client.notify(methods.client.session.update, {
                                    sessionId: params.sessionId,
                                    update: {
                                        sessionUpdate: "state_update",
                                        state: "idle",
                                        stopReason: "end_turn",
                                        _meta: {
                                            plurnk: {
                                                loopSeq: 1,
                                                terminal: {
                                                    status: 200,
                                                    turnCount: 1,
                                                    elapsedMs: 1200,
                                                    usage: { inputTokens: 100, outputTokens: 25 },
                                                },
                                            },
                                        },
                                    },
                                });
                            }
                            await client.notify(methods.client.session.update, {
                                sessionId: params.sessionId,
                                update: {
                                    sessionUpdate: "notice",
                                    severity: "error",
                                    title: "Service stopping",
                                    description: "The service is shutting down.",
                                },
                            });
                            phaseReached.resolve();
                        } catch {
                            // Ignore disconnect error
                        }
                    });
                    return { stopReason: "end_turn", messageId: "msg-tui-1" };
                });

            const acpServer = new AcpServer({ agent: agentApp });
            const handler = createNodeHttpHandler(acpServer);
            const httpServer = http.createServer((req, res) => {
                if (req.url === "/acp") {
                    handler(req, res);
                    return;
                }
                res.writeHead(404).end();
            });
            await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
            const addr = httpServer.address() as { port: number };
            const url = `http://127.0.0.1:${addr.port}/acp`;

            const stdin = new PassThrough();
            const stdout = new PassThrough();
            const stderr = new PassThrough();
            const getStdout = collectStream(stdout);
            const getStderr = collectStream(stderr);

            try {
                const runPromise = runTuiViewport(makeOptions(url, { json: false }), {
                    stdin,
                    stdout,
                    stderr,
                });

                stdin.write("hello\n");
                await phaseReached.promise;
                await new Promise((r) => setTimeout(r, 30));

                await acpServer.close();
                httpServer.closeAllConnections();
                await new Promise((r) => setTimeout(r, 40));

                stdin.end("/quit\n");
                const code = await runPromise;
                assert.equal(code, 0);

                const out = getStdout();
                const err = getStderr();
                assert.match(out, /🔌/u, `${phase}: status line surfaces 🔌 when stream disconnects`);
                assert.equal(
                    out.match(/⛔ The service is shutting down\./gu)?.length ?? 0,
                    1,
                    `${phase}: stopping notice is rendered once on the waterfall`,
                );
                assert.equal(err, "", `${phase}: server notice is not duplicated onto stderr`);

                if (phase === "active") {
                    assert.doesNotMatch(
                        out,
                        /⏹️|🛑/u,
                        "active: mid-turn disconnect never fabricates a loop summary",
                    );
                } else {
                    assert.equal(
                        out.match(/⏹️/gu)?.length ?? 0,
                        1,
                        "idle: completed loop summary is preserved once after disconnect",
                    );
                }
            } finally {
                await acpServer.close().catch(() => {});
                httpServer.closeAllConnections();
                await new Promise<void>((resolve) => httpServer.close(() => resolve()));
            }
        }
    },
);
