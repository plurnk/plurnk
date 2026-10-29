import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { PassThrough } from "node:stream";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { createNodeHttpHandler } from "@agentclientprotocol/sdk/experimental/node";
import {
    agent as createAcpAgent,
    methods,
    PROTOCOL_VERSION,
    RequestError,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { Terminal } from "@earendil-works/pi-tui";
import type { CliCommonOptions } from "./cli-runner.ts";
import Credential from "./credential.ts";
import { altShortcut, backTabShortcut, runTuiViewport } from "./tui-viewport.ts";

test("{§cli-repl-mode} {§cli-session-status}: runTuiViewport processes typed fd 3 events, renders status bar, and exits cleanly on /quit", async () => {
    assert.equal(altShortcut("\x1bm"), "/models");
    assert.equal(altShortcut("\x1bs"), "/workspaces");
    assert.equal(altShortcut("\x1bR"), "/sessions");
    assert.equal(altShortcut("\x1bL"), "/loops");
    assert.equal(altShortcut("\x1bY"), "/yolo");
    assert.equal(altShortcut("\x1bx"), "/stop");
    assert.equal(altShortcut("plain"), null);
    assert.equal(backTabShortcut("\x1b[Z"), "/yolo");
    assert.equal(backTabShortcut("other"), null);

    const agentApp = createAcpAgent({ name: "viewport-mock-agent" })
        .onRequest(methods.agent.initialize, async () => ({
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "@plurnk/plurnk-service", version: "1.0.0" },
            capabilities: { session: { prompt: {} } },
        }))
        .onRequest(methods.agent.session.new, async () => ({
            sessionId: "1#user",
            configOptions: [
                {
                    configId: "model",
                    name: "Model",
                    type: "select",
                    currentValue: "mocktest/fast",
                    options: [{ value: "mocktest/fast", name: "Fast" }],
                },
            ],
            _meta: {
                plurnk: {
                    workspace: { id: 1, name: "alpha", projectRoot: "/tmp/alpha" },
                    sessionName: "user",
                },
            },
        }))
        .onRequest(methods.agent.session.resume, async () => ({
            configOptions: [
                {
                    configId: "model",
                    name: "Model",
                    type: "select",
                    currentValue: "mocktest/fast",
                    options: [{ value: "mocktest/fast", name: "Fast" }],
                },
            ],
            _meta: {
                plurnk: {
                    workspace: { id: 1, name: "alpha", projectRoot: "/tmp/alpha" },
                    sessionName: "user",
                },
            },
        }))
        .onRequest(
            "_plurnk/action",
            (raw) => raw as { kind: string },
            async ({ params }) => {
                if (params.kind === "workspace.create" || params.kind === "workspace.attach") {
                    return { id: 1, name: "alpha", project_root: "/tmp/alpha" };
                }
                if (params.kind === "workspace.sessions") {
                    return { sessions: [{ id: 1, name: "user", lifecycle: "idle" }] };
                }
                if (params.kind === "workspace.list") {
                    return { workspaces: [{ id: 1, name: "alpha", project_root: "/tmp/alpha" }] };
                }
                return {};
            },
        );

    const acpServer = new AcpServer({ agent: agentApp });
    const handler = createNodeHttpHandler(acpServer);
    const httpServer = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const addr = httpServer.address();
    assert.ok(addr && typeof addr === "object");

    const termWrites: string[] = [];
    let inputCallback = null as ((data: string) => void) | null;
    const fakeTerminal: Terminal = {
        columns: 100,
        rows: 30,
        kittyProtocolActive: false,
        start(onInput: (data: string) => void) {
            inputCallback = onInput;
        },
        stop() {},
        async drainInput() {},
        write(data: string) {
            termWrites.push(data);
        },
        moveBy() {},
        hideCursor() {},
        showCursor() {},
        clearLine() {},
        clearFromCursor() {},
        clearScreen() {},
        setTitle(t: string) {
            termWrites.push(`TITLE:${t}`);
        },
        setProgress() {},
        setProgramStatus() {},
    };

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const options: CliCommonOptions = {
        url: `http://127.0.0.1:${String(addr.port)}/acp`,
        explicitAcpUrl: true,
        host: "127.0.0.1",
        port: addr.port,
        credential: new Credential({ PLURNK_SECRET: "test-secret" }),
        autostart: false,
        daemonTimeoutMs: 2000,
        oauthTimeoutMs: 2000,
        cancelGraceMs: 500,
        workspace: "alpha",
        sessionId: "user",
        tuiSession: "user",
        yolo: true,
        auto: false,
        json: false,
        repl: false,
        statusStream: false,
        previewLines: 5,
        historyEntries: 10,
        mermaidTimeoutMs: 2000,
        color: "never",
        bell: false,
        cwd: "/tmp",
        env: { PLURNK_SECRET: "test-secret" },
    };

    try {
        const viewportPromise = runTuiViewport(options, {
            stdin,
            stdout,
            stderr,
            terminal: fakeTerminal,
        });

        const deadline = Date.now() + 5000;
        while (!termWrites.some((w) => w.includes("TITLE:plurnk · alpha · user")) && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 20));
        }
        assert.ok(termWrites.some((w) => w.includes("TITLE:plurnk · alpha · user")));
        assert.ok(inputCallback !== null);

        // Send Ctrl-D on empty editor to trigger /quit through the TUI input listener
        inputCallback!("\x04");
        const exitCode = await viewportPromise;
        assert.equal(exitCode, 0);
    } finally {
        stdin.end();
        await acpServer.close();
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
});

test("{§cli-repl-mode} {§cli-session-status} {§cli-rendering}: TUI viewport counts only running inbox items, clears 📨 on publish, and renders Ctrl-C cancellation once with preserved curation metrics", async () => {
    const runningNotified = Promise.withResolvers<void>();
    const cancelReceived = Promise.withResolvers<void>();
    let capturedClient = null as { notify: (method: string, params: unknown) => Promise<void> } | null;

    const agentApp = createAcpAgent({ name: "viewport-cancel-inbox-agent" })
        .onRequest(methods.agent.initialize, async () => ({
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "@plurnk/plurnk-service", version: "1.0.0" },
            capabilities: { session: { prompt: {}, resume: {} } },
        }))
        .onRequest(methods.agent.session.new, async ({ client }) => {
            capturedClient = client as { notify: (method: string, params: unknown) => Promise<void> };
            return {
                sessionId: "1#user",
                configOptions: [
                    {
                        configId: "model",
                        name: "Model",
                        type: "select",
                        currentValue: "mocktest/fast",
                        options: [{ value: "mocktest/fast", name: "Fast" }],
                    },
                ],
                _meta: {
                    plurnk: {
                        workspace: { id: 1, name: "alpha", projectRoot: "/tmp/alpha" },
                        sessionName: "user",
                        status: {
                            lifecycle: "running",
                            inbox: [
                                { id: "msg-cancelled", lifecycle: "cancelled" },
                                { id: "msg-running", lifecycle: "running" },
                            ],
                        },
                    },
                },
            };
        })
        .onRequest(methods.agent.session.resume, async ({ client }) => {
            capturedClient = client as { notify: (method: string, params: unknown) => Promise<void> };
            return {
                configOptions: [
                    {
                        configId: "model",
                        name: "Model",
                        type: "select",
                        currentValue: "mocktest/fast",
                        options: [{ value: "mocktest/fast", name: "Fast" }],
                    },
                ],
                _meta: {
                    plurnk: {
                        workspace: { id: 1, name: "alpha", projectRoot: "/tmp/alpha" },
                        sessionName: "user",
                        status: {
                            lifecycle: "running",
                            inbox: [
                                { id: "msg-cancelled", lifecycle: "cancelled" },
                                { id: "msg-running", lifecycle: "running" },
                            ],
                        },
                    },
                },
            };
        })
        .onRequest(
            "_plurnk/action",
            (raw) => raw as { kind: string },
            async ({ params }) => {
                if (params.kind === "workspace.create" || params.kind === "workspace.attach") {
                    return { id: 1, name: "alpha", project_root: "/tmp/alpha" };
                }
                if (params.kind === "workspace.sessions") {
                    return { sessions: [{ id: 1, name: "user", lifecycle: "idle" }] };
                }
                if (params.kind === "workspace.list") {
                    return { workspaces: [{ id: 1, name: "alpha", project_root: "/tmp/alpha" }] };
                }
                return {};
            },
        )
        .onRequest(methods.agent.session.prompt, async ({ client, params }) => {
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "state_update",
                    state: "running",
                    _meta: { plurnk: { loopSeq: 2 } },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "usage_update",
                    used: 264_000,
                    size: 1_100_000,
                    cost: { amount: 6.76, currency: "USD" },
                    _meta: {
                        plurnk: {
                            turn: 1,
                            turnUsage: { inputTokens: 200_000, outputTokens: 1_200 },
                            curation: { weight: 264_000, budget: 1_100_000 },
                        },
                    },
                },
            });
            runningNotified.resolve();
            await cancelReceived.promise;
            return { stopReason: "cancelled", messageId: "msg-2" };
        })
        .onNotification(methods.agent.session.cancel, async ({ client, params }) => {
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "state_update",
                    state: "idle",
                    stopReason: "cancelled",
                    _meta: {
                        plurnk: {
                            loopSeq: 2,
                            terminal: {
                                status: 499,
                                turnCount: 1,
                                elapsedMs: 3600,
                                usage: {
                                    accounting: {
                                        usage: { inputTokens: 200_000, outputTokens: 1_200 },
                                        costUsd: "6.76",
                                    },
                                },
                                problem: {
                                    type: "https://problems.plurnk.xyz/session/loop-cancelled",
                                    title: "Loop cancelled",
                                    status: 499,
                                    detail: "The session scope was cancelled: Cancelled by ACP client.",
                                },
                            },
                        },
                    },
                },
            });
            cancelReceived.resolve();
        });

    const acpServer = new AcpServer({ agent: agentApp });
    const handler = createNodeHttpHandler(acpServer);
    const httpServer = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const addr = httpServer.address();
    assert.ok(addr && typeof addr === "object");

    const termWrites: string[] = [];
    let inputCallback = null as ((data: string) => void) | null;
    const fakeTerminal: Terminal = {
        columns: 120,
        rows: 30,
        kittyProtocolActive: false,
        start(onInput: (data: string) => void) {
            inputCallback = onInput;
        },
        stop() {},
        async drainInput() {},
        write(data: string) {
            termWrites.push(data);
        },
        moveBy() {},
        hideCursor() {},
        showCursor() {},
        clearLine() {},
        clearFromCursor() {},
        clearScreen() {},
        setTitle(t: string) {
            termWrites.push(`TITLE:${t}`);
        },
        setProgress() {},
        setProgramStatus() {},
    };

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const options: CliCommonOptions = {
        url: `http://127.0.0.1:${String(addr.port)}/acp`,
        explicitAcpUrl: true,
        host: "127.0.0.1",
        port: addr.port,
        credential: new Credential({ PLURNK_SECRET: "test-secret" }),
        autostart: false,
        daemonTimeoutMs: 2000,
        oauthTimeoutMs: 2000,
        cancelGraceMs: 500,
        workspace: "alpha",
        sessionId: "user",
        tuiSession: "user",
        yolo: true,
        auto: false,
        json: false,
        repl: false,
        statusStream: false,
        previewLines: 5,
        historyEntries: 10,
        mermaidTimeoutMs: 2000,
        color: "never",
        bell: false,
        cwd: "/tmp",
        env: { PLURNK_SECRET: "test-secret" },
    };

    try {
        const viewportPromise = runTuiViewport(options, {
            stdin,
            stdout,
            stderr,
            terminal: fakeTerminal,
        });

        const waitUntil = async (predicate: () => boolean) => {
            const deadline = Date.now() + 5000;
            while (!predicate() && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 20));
            }
            assert.ok(predicate());
        };

        await waitUntil(() => termWrites.join("").includes("📨 1"));
        assert.doesNotMatch(termWrites.join(""), /📨 2/u, "cancelled inbox items are not counted as pending");

        assert.ok(capturedClient !== null);
        await capturedClient.notify(methods.client.session.update, {
            sessionId: "1#user",
            update: {
                sessionUpdate: "user_message_chunk",
                messageId: "msg-running",
                content: { type: "text", text: "queued live" },
                _meta: { plurnk: { published: true } },
            },
        });
        await waitUntil(() => !termWrites.at(-1)!.includes("📨"));

        // Submit prompt through the TUI editor
        assert.ok(inputCallback !== null);
        inputCallback!("do work");
        inputCallback!("\r");
        await runningNotified.promise;
        await new Promise((r) => setTimeout(r, 30));

        // Press Ctrl-C while running to cancel
        inputCallback!("\x03");
        await waitUntil(() => termWrites.join("").includes("🛑 cancelled (final 499)"));

        const transcript = termWrites.join("");
        assert.match(transcript, /cancelling… \(ctrl-c again to quit\)/u);
        assert.match(transcript, /⛔ The session scope was cancelled: Cancelled by ACP client\./u);
        assert.doesNotMatch(
            transcript,
            /\nThe session scope was cancelled: Cancelled by ACP client\.\r?\n/u,
            "terminal problem detail is never rendered a second time without ⛔",
        );
        assert.match(
            transcript,
            /🛑 cancelled \(final 499\) · 1 turn · [^·]+ · ↓200k ↑1\.2k · cur 24%\/1\.1M · loop \$6\.76/u,
            "cancelled loop summary preserves cur 24%/1.1M and loop $6.76",
        );
        assert.doesNotMatch(transcript, /cur 0%\/128k/u, "never overwrites curation gauge with default 0%/128k");

        inputCallback!("\x04");
        const exitCode = await viewportPromise;
        assert.equal(exitCode, 0);
    } finally {
        stdin.end();
        await acpServer.close();
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
});

test("{§cli-model-selection} {§cli-session-status} {§cli-problems-and-notices}: TUI viewport warns on modelless startup, resets status to ❌ on rejected prompt, and recovers after /model selection", async () => {
    let currentModel: string | null = null;
    const agentApp = createAcpAgent({ name: "viewport-modelless-agent" })
        .onRequest(methods.agent.initialize, async () => ({
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "@plurnk/plurnk-service", version: "1.0.0" },
            capabilities: { session: { prompt: {}, resume: {} } },
        }))
        .onRequest(methods.agent.session.new, async () => ({
            sessionId: "1#user",
            configOptions: [
                {
                    configId: "model",
                    name: "Model",
                    type: "select",
                    currentValue: "",
                    options: [{ value: "mocktest/fast", name: "Fast" }],
                },
            ],
            _meta: {
                plurnk: {
                    workspace: { id: 1, name: "alpha", projectRoot: "/tmp/alpha" },
                    sessionName: "user",
                    status: {
                        model: null,
                    },
                },
            },
        }))
        .onRequest(methods.agent.session.resume, async () => ({
            configOptions: [
                {
                    configId: "model",
                    name: "Model",
                    type: "select",
                    currentValue: currentModel ?? "",
                    options: [{ value: "mocktest/fast", name: "Fast" }],
                },
            ],
            _meta: {
                plurnk: {
                    workspace: { id: 1, name: "alpha", projectRoot: "/tmp/alpha" },
                    sessionName: "user",
                    status: {
                        model: currentModel ? { provider: "mocktest", model: "fast" } : null,
                    },
                },
            },
        }))
        .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
            if (params.configId === "model") {
                if (params.value !== "mocktest/fast") {
                    throw new RequestError(
                        -32000,
                        `Provider alias '${String(params.value)}' is not declared.`,
                        {
                            type: "https://problems.plurnk.xyz/daemon/provider/alias-not-found",
                            title: "Provider alias not found",
                            status: 404,
                            detail: `Provider alias '${String(params.value)}' is not declared.`,
                        },
                    );
                }
                currentModel = "mocktest/fast";
            }
            return {
                configOptions: [
                    {
                        configId: "model",
                        name: "Model",
                        type: "select",
                        currentValue: currentModel ?? "",
                        options: [{ value: "mocktest/fast", name: "Fast" }],
                    },
                ],
                _meta: {
                    plurnk: {
                        status: {
                            model: currentModel ? { provider: "mocktest", model: "fast" } : null,
                        },
                    },
                },
            };
        })
        .onRequest(methods.agent.session.prompt, async ({ client, params }) => {
            if (currentModel === null) {
                throw new RequestError(
                    -32000,
                    "No model is selected for this session.",
                    {
                        type: "https://problems.plurnk.xyz/daemon/provider/model-not-configured",
                        title: "Model not configured",
                        status: 409,
                        detail: "No model is selected for this session.",
                    },
                );
            }
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: "m-ok",
                    content: { type: "text", text: "Recovered answer" },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "state_update",
                    state: "idle",
                    stopReason: "end_turn",
                    _meta: {
                        plurnk: {
                            loopSeq: 1,
                            terminal: { status: 200, turnCount: 1, elapsedMs: 50 },
                        },
                    },
                },
            });
            return { stopReason: "end_turn", messageId: "m-ok" };
        })
        .onRequest(
            "_plurnk/action",
            (raw) => raw as { kind: string },
            async ({ params }) => {
                if (params.kind === "workspace.create" || params.kind === "workspace.attach") {
                    return { id: 1, name: "alpha", project_root: "/tmp/alpha" };
                }
                if (params.kind === "workspace.sessions") {
                    return { sessions: [{ id: 1, name: "user", lifecycle: "idle" }] };
                }
                if (params.kind === "workspace.list") {
                    return { workspaces: [{ id: 1, name: "alpha", project_root: "/tmp/alpha" }] };
                }
                return {};
            },
        );

    const acpServer = new AcpServer({ agent: agentApp });
    const handler = createNodeHttpHandler(acpServer);
    const httpServer = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const addr = httpServer.address();
    assert.ok(addr && typeof addr === "object");

    const termWrites: string[] = [];
    let inputCallback = null as ((data: string) => void) | null;
    const fakeTerminal: Terminal = {
        columns: 120,
        rows: 30,
        kittyProtocolActive: false,
        start(onInput: (data: string) => void) {
            inputCallback = onInput;
        },
        stop() {},
        async drainInput() {},
        write(data: string) {
            termWrites.push(data);
        },
        moveBy() {},
        hideCursor() {},
        showCursor() {},
        clearLine() {},
        clearFromCursor() {},
        clearScreen() {},
        setTitle(t: string) {
            termWrites.push(`TITLE:${t}`);
        },
        setProgress() {},
        setProgramStatus() {},
    };

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const options: CliCommonOptions = {
        url: `http://127.0.0.1:${String(addr.port)}/acp`,
        explicitAcpUrl: true,
        host: "127.0.0.1",
        port: addr.port,
        credential: new Credential({ PLURNK_SECRET: "test-secret" }),
        autostart: false,
        daemonTimeoutMs: 2000,
        oauthTimeoutMs: 2000,
        cancelGraceMs: 500,
        workspace: "alpha",
        sessionId: "user",
        tuiSession: "user",
        yolo: true,
        auto: false,
        json: false,
        repl: false,
        statusStream: false,
        previewLines: 5,
        historyEntries: 10,
        mermaidTimeoutMs: 2000,
        color: "never",
        bell: false,
        cwd: "/tmp",
        env: { PLURNK_SECRET: "test-secret" },
    };

    try {
        const viewportPromise = runTuiViewport(options, {
            stdin,
            stdout,
            stderr,
            terminal: fakeTerminal,
        });

        const waitUntil = async (predicate: () => boolean) => {
            const deadline = Date.now() + 5000;
            while (!predicate() && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 20));
            }
            assert.ok(predicate(), `Transcript so far:\n${termWrites.join("")}`);
        };

        // 1. Modelless startup warning and `none` in status bar
        await waitUntil(() => termWrites.join("").includes("/model <selector> chooses one."));
        assert.match(termWrites.join(""), /· none ·/u);

        // 2. Sending a prompt when modelless rejects and resets status bar to ❌ instead of hanging in ⌛︎
        assert.ok(inputCallback !== null);
        inputCallback!("hello without model");
        inputCallback!("\r");
        await waitUntil(() => termWrites.join("").includes("No model is selected for this session."));
        await waitUntil(() => termWrites.join("").includes("[alpha/~user] ❌  · none"));

        // 3. Invalid /model granite reports failure in TUI without crashing or freezing
        inputCallback!("/model granite");
        inputCallback!("\r");
        await waitUntil(() => termWrites.join("").includes("Provider alias 'granite' is not declared."));

        // 4. Valid /model mocktest/fast updates the session and next prompt succeeds
        inputCallback!("/model mocktest/fast");
        inputCallback!("\r");
        await waitUntil(() => termWrites.join("").includes("mocktest/fast"));
        inputCallback!("hello with model");
        inputCallback!("\r");
        await waitUntil(() => termWrites.join("").includes("Recovered answer"));

        inputCallback!("\x04");
        const exitCode = await viewportPromise;
        assert.equal(exitCode, 0);
    } finally {
        stdin.end();
        await acpServer.close();
        httpServer.closeAllConnections();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
});
