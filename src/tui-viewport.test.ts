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
            capabilities: { session: { prompt: {}, resume: {} } },
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

test("{§cli-markdown-projection} {§cli-session-status}: TUI viewport retires live reasoning across silent adaptive turns and preserves aggregate spend on parked loops after 499", async () => {
    const turn1ReasoningShown = Promise.withResolvers<void>();
    const continueAfterTurn1 = Promise.withResolvers<void>();
    const parkedShown = Promise.withResolvers<void>();
    const finishParkedLoop = Promise.withResolvers<void>();

    const agentApp = createAcpAgent({ name: "viewport-mock-agent" })
        .onRequest(methods.agent.initialize, async () => ({
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "@plurnk/plurnk-service", version: "1.0.0" },
            capabilities: { session: { prompt: {}, resume: {} } },
        }))
        .onRequest(methods.agent.session.new, async () => ({
            sessionId: "1#service",
            configOptions: [
                {
                    type: "select",
                    configId: "model",
                    name: "Model",
                    currentValue: "argon",
                    options: [{ value: "argon", name: "argon" }],
                },
                {
                    type: "select",
                    configId: "thought_level",
                    name: "Reasoning Effort",
                    currentValue: "adaptive",
                    options: [{ value: "adaptive", name: "adaptive" }],
                },
            ],
            _meta: {
                plurnk: {
                    workspace: { id: 1, name: "plurnk-service", projectRoot: "/tmp/plurnk-service", projectLabel: "~/ptl/plurnk-service" },
                    sessionName: "service",
                    status: {
                        lifecycle: "idle",
                        loopSeq: 5,
                        model: { alias: "argon", effort: "adaptive", effortSource: "default" },
                        spend: {
                            requests: 4,
                            usage: { inputTokens: 50_000, outputTokens: 8_000 },
                            costUsd: "1.5",
                            knownCostUsd: "1.5",
                        },
                    },
                },
            },
        }))
        .onRequest(methods.agent.session.resume, async () => ({
            configOptions: [
                {
                    type: "select",
                    configId: "model",
                    name: "Model",
                    currentValue: "argon",
                    options: [{ value: "argon", name: "argon" }],
                },
                {
                    type: "select",
                    configId: "thought_level",
                    name: "Reasoning Effort",
                    currentValue: "adaptive",
                    options: [{ value: "adaptive", name: "adaptive" }],
                },
            ],
            _meta: {
                plurnk: {
                    workspace: { id: 1, name: "plurnk-service", projectRoot: "/tmp/plurnk-service", projectLabel: "~/ptl/plurnk-service" },
                    sessionName: "service",
                    status: {
                        lifecycle: "idle",
                        loopSeq: 5,
                        model: { alias: "argon", effort: "adaptive", effortSource: "default" },
                        spend: {
                            requests: 4,
                            usage: { inputTokens: 50_000, outputTokens: 8_000 },
                            costUsd: "1.5",
                            knownCostUsd: "1.5",
                        },
                    },
                },
            },
        }))
        .onRequest(methods.agent.session.list, async () => ({
            sessions: [{ sessionId: "1#service", cwd: "/tmp/plurnk-service", title: "service" }],
        }))
        .onRequest(
            "_plurnk/action",
            (raw) => raw as { kind: string },
            async ({ params }) => {
                if (params.kind === "workspace.create" || params.kind === "workspace.attach") {
                    return { id: 1, name: "plurnk-service", project_root: "/tmp/plurnk-service" };
                }
                if (params.kind === "workspace.sessions") {
                    return { sessions: [{ id: 1, name: "service", lifecycle: "idle" }] };
                }
                if (params.kind === "workspace.list") {
                    return { workspaces: [{ id: 1, name: "plurnk-service", project_root: "/tmp/plurnk-service" }] };
                }
                return {};
            },
        )
        .onRequest(methods.agent.session.prompt, async ({ client, params }) => {
            const text = params.prompt.map((b) => ("text" in b ? b.text : "")).join("");
            if (text.includes("cancel-first")) {
                await client.notify(methods.client.session.update, {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: "state_update",
                        state: "idle",
                        stopReason: "cancelled",
                        _meta: {
                            plurnk: {
                                loopSeq: 5,
                                terminal: {
                                    status: 499,
                                    turnCount: 1,
                                    usage: {
                                        accounting: {
                                            requests: 1,
                                            usage: { inputTokens: 10_000, outputTokens: 2_000 },
                                            costUsd: "0.25",
                                        },
                                    },
                                },
                            },
                        },
                    },
                });
                return { stopReason: "cancelled", messageId: "m-5" };
            }

            // Loop 6 starts after Loop 5 ended with 499
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "notice",
                    severity: "info",
                    title: "engine:turn:turn_awaiting_model",
                    _meta: {
                        plurnk: {
                            notice: { source: "engine:turn", kind: "turn_awaiting_model" },
                        },
                    },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_thought_chunk",
                    messageId: "thought-6-1",
                    content: { type: "text", text: "TURN_1_REASONING_ALPHA" },
                },
            });
            turn1ReasoningShown.resolve();
            await continueAfterTurn1.promise;

            // Turn 1 finishes generating and parks on WAIT (status 202)
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "notice",
                    severity: "info",
                    title: "engine:turn:turn_generated",
                    _meta: {
                        plurnk: {
                            notice: {
                                source: "engine:turn",
                                kind: "turn_generated",
                                accounting: {
                                    requests: 1,
                                    inputTokens: 5_000,
                                    outputTokens: 1_000,
                                    costUsd: "0.15",
                                },
                            },
                        },
                    },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: "6/1/1",
                    name: "WAIT",
                    title: "WAIT",
                    status: "completed",
                    _meta: {
                        plurnk: {
                            id: 601,
                            op: "WAIT",
                            origin: "model",
                            status: 202,
                            loopSeq: 6,
                            turnSeq: 1,
                            sequence: 1,
                            attrs: { waiting: 11 },
                        },
                    },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "notice",
                    severity: "info",
                    title: "engine:lifecycle:loop_status",
                    _meta: {
                        plurnk: {
                            notice: {
                                source: "engine:lifecycle",
                                kind: "loop_status",
                                status: 202,
                                loopSeq: 6,
                                packetCount: 1,
                                waitUntil: Date.now() + 11_000,
                            },
                        },
                    },
                },
            });
            parkedShown.resolve();
            await finishParkedLoop.promise;

            // Turn 2 wakes up and emits a reply WITHOUT any reasoning tokens
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "notice",
                    severity: "info",
                    title: "engine:turn:turn_awaiting_model",
                    _meta: {
                        plurnk: {
                            notice: { source: "engine:turn", kind: "turn_awaiting_model" },
                        },
                    },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "notice",
                    severity: "info",
                    title: "engine:turn:turn_generated",
                    _meta: {
                        plurnk: {
                            notice: {
                                source: "engine:turn",
                                kind: "turn_generated",
                                accounting: {
                                    requests: 1,
                                    inputTokens: 2_000,
                                    outputTokens: 500,
                                    costUsd: "0.1",
                                },
                            },
                        },
                    },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: "6/2/1",
                    content: { type: "text", text: "TURN_2_FINAL_ANSWER" },
                    _meta: { plurnk: { op: "SEND", status: 200, loopSeq: 6, turnSeq: 2 } },
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
                            loopSeq: 6,
                            terminal: {
                                status: 200,
                                turnCount: 2,
                                usage: {
                                    accounting: {
                                        requests: 2,
                                        usage: { inputTokens: 7_000, outputTokens: 1_500 },
                                        costUsd: "0.25",
                                    },
                                },
                            },
                        },
                    },
                },
            });
            return { stopReason: "end_turn", messageId: "m-6" };
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
        workspace: "plurnk-service",
        sessionId: "service",
        tuiSession: "service",
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

        await waitUntil(() => termWrites.join("").includes("$1.5000"));
        assert.ok(inputCallback !== null);

        // 1. Trigger a 499 cancelled loop
        inputCallback!("cancel-first");
        inputCallback!("\r");
        await waitUntil(() => termWrites.join("").includes("🛑 cancelled (final 499)"));
        assert.match(termWrites.join(""), /🛑 {2}· argon\(adaptive\) · [^·]+ · ↓60k ↑10k · \$1\.7500/u);

        // 2. Start Loop 6: Turn 1 streams live reasoning
        inputCallback!("run-multi-turn");
        inputCallback!("\r");
        await turn1ReasoningShown.promise;
        await waitUntil(() => termWrites.join("").includes("💭 TURN_1_REASONING_ALPHA"));

        // 3. Turn 1 finishes generating and parks on WAIT:
        //    - Live reasoning is retired immediately
        //    - Status bar shows 💤 (never 🛑) and preserves ↓65k ↑11k · $1.9000 · updates in 11s
        const writesBeforePark = termWrites.length;
        continueAfterTurn1.resolve();
        await parkedShown.promise;
        await waitUntil(() =>
            termWrites.slice(writesBeforePark).join("").includes("updates in") &&
            termWrites.slice(writesBeforePark).join("").includes("$1.9000"),
        );
        const parkedRender = termWrites.slice(writesBeforePark).join("");
        assert.match(
            parkedRender,
            /\[plurnk-service\/~service\(6\/1\)\] 💤 {2}· argon\(adaptive\) · [^·]+ · ↓65k ↑11k · \$1\.9000 · updates in (?:10|11)s/u,
        );
        assert.doesNotMatch(
            parkedRender,
            /\[plurnk-service\/~service\(6\/1\)\] 🛑/u,
            "parked loop must never display stale 🛑 from a prior cancelled loop",
        );
        assert.doesNotMatch(
            parkedRender,
            /TURN_1_REASONING_ALPHA/u,
            "live reasoning must be retired as soon as Turn 1 finishes generating and parks",
        );

        // 4. Turn 2 runs WITHOUT reasoning tokens: Turn 1's reasoning must never reappear in subsequent renders
        const writesBeforeTurn2 = termWrites.length;
        finishParkedLoop.resolve();
        await waitUntil(() => termWrites.slice(writesBeforeTurn2).join("").includes("TURN_2_FINAL_ANSWER"));
        const turn2Render = termWrites.slice(writesBeforeTurn2).join("");
        assert.doesNotMatch(
            turn2Render,
            /TURN_1_REASONING_ALPHA/u,
            "Turn 1 live reasoning must be retired and never remain stuck on Turn 2",
        );
        assert.match(turn2Render, /\$2\.0000/u);

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

test("{§cli-markdown-projection} {§cli-session-status}: TUI viewport anchors tool calls at their launch coordinates and preserves 🐹 loop summary aside when background streams finish out of order", async () => {
    const agentApp = createAcpAgent({ name: "viewport-coordinate-agent" })
        .onRequest(methods.agent.initialize, async () => ({
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "@plurnk/plurnk-service", version: "1.0.0" },
            capabilities: { session: { prompt: {}, resume: {} } },
        }))
        .onRequest(methods.agent.session.new, async () => ({
            sessionId: "1#service",
            configOptions: [],
            _meta: {
                plurnk: {
                    workspace: { id: 1, name: "plurnk-service", projectRoot: "/tmp/plurnk-service" },
                    sessionName: "service",
                    status: { lifecycle: "idle", loopSeq: 17 },
                },
            },
        }))
        .onRequest(methods.agent.session.resume, async () => ({
            configOptions: [],
            _meta: {
                plurnk: {
                    workspace: { id: 1, name: "plurnk-service", projectRoot: "/tmp/plurnk-service" },
                    sessionName: "service",
                    status: { lifecycle: "idle", loopSeq: 17 },
                },
            },
        }))
        .onRequest(
            "_plurnk/action",
            (raw) => raw as { kind: string },
            async ({ params }) => {
                if (params.kind === "workspace.create" || params.kind === "workspace.attach") {
                    return { id: 1, name: "plurnk-service", project_root: "/tmp/plurnk-service" };
                }
                if (params.kind === "workspace.sessions") {
                    return { sessions: [{ id: 1, name: "service", lifecycle: "idle" }] };
                }
                if (params.kind === "workspace.list") {
                    return { workspaces: [{ id: 1, name: "plurnk-service", project_root: "/tmp/plurnk-service" }] };
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
                    _meta: { plurnk: { loopSeq: 17 } },
                },
            });
            // Turn 1: sh proposal pending at 17/1/5, then approved and running
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: "17/1/5",
                    name: "sh",
                    title: "sh",
                    status: "pending",
                    rawInput: { body: "echo turn1_sh" },
                    _meta: {
                        plurnk: {
                            id: 24572,
                            coordinate: "17/1/5",
                            op: "sh",
                            origin: "model",
                            status: 202,
                        },
                    },
                },
            });
            // Turn 2: NOTE at 17/2/1 finishes while 17/1/5 is still running
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: "17/2/1",
                    name: "NOTE",
                    title: "NOTE",
                    status: "completed",
                    rawInput: { body: "TURN_2_NOTE_BODY" },
                    _meta: {
                        plurnk: {
                            id: 24580,
                            coordinate: "17/2/1",
                            op: "NOTE",
                            origin: "model",
                            status: 200,
                        },
                    },
                },
            });
            // Now 17/1/5 completes AFTER Turn 2's NOTE has already rendered
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: "17/1/5",
                    name: "sh",
                    title: "sh",
                    status: "completed",
                    rawInput: { body: "echo turn1_sh" },
                    _meta: {
                        plurnk: {
                            id: 24572,
                            coordinate: "17/1/5",
                            op: "sh",
                            origin: "model",
                            status: 200,
                        },
                    },
                },
            });
            // Turn 7 emits 🐹 reply at 17/7/1 and concludes with status 200
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: "17/7/1",
                    content: { type: "text", text: "FINAL_HAMSTER_REPLY" },
                    _meta: { plurnk: { op: "SEND", status: 200, coordinate: "17/7/1", loopSeq: 17, turnSeq: 7 } },
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
                            loopSeq: 17,
                            terminal: {
                                status: 200,
                                turnCount: 7,
                                elapsedMs: 69_000,
                                usage: {
                                    accounting: {
                                        requests: 7,
                                        usage: { inputTokens: 33_000_000, outputTokens: 241_000 },
                                        costUsd: "14.8579",
                                    },
                                },
                            },
                        },
                    },
                },
            });
            return { stopReason: "end_turn", messageId: "17/7/1" };
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
        rows: 40,
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
        workspace: "plurnk-service",
        sessionId: "service",
        tuiSession: "service",
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

        await waitUntil(() => termWrites.join("").includes("[plurnk-service/~service]"));
        assert.ok(inputCallback !== null);
        const writesBeforePrompt = termWrites.length;
        inputCallback!("go");
        inputCallback!("\r");
        await waitUntil(() => termWrites.slice(writesBeforePrompt).join("").includes("FINAL_HAMSTER_REPLY"));
        await waitUntil(() => termWrites.slice(writesBeforePrompt).join("").includes("7 turns"));

        const promptWrites = termWrites.slice(writesBeforePrompt).join("");
        const shPos = promptWrites.lastIndexOf("echo turn1_sh");
        const notePos = promptWrites.lastIndexOf("TURN_2_NOTE_BODY");
        const hamsterPos = promptWrites.lastIndexOf("FINAL_HAMSTER_REPLY");
        assert.ok(shPos >= 0, "17/1/5 sh receipt must be rendered");
        assert.ok(notePos > shPos, "17/1/5 sh receipt must appear above Turn 2 NOTE (17/2/1)");
        assert.ok(hamsterPos > notePos, "Turn 7 🐹 reply must appear below Turn 1 sh and Turn 2 NOTE");
        assert.match(promptWrites, /🐹 7 turns · [^·]+ · ↓33M ↑241k · loop \$14\.86/u);

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
