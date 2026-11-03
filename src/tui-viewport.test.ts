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
import { stripVTControlCharacters } from "node:util";
import { AcpSession } from "./acp-session.ts";
import type { CliCommonOptions } from "./cli-runner.ts";
import Credential from "./credential.ts";
import { extractPromptHistory } from "./repl-commands.ts";
import { SessionPresenter } from "./session-presenter.ts";
import { longestCommonPrefix, makeAutocompleteProvider } from "./tui-completion.ts";
import TuiSurface, { renderActiveLiveLine, renderReasoning } from "./tui-surface.ts";
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
                    status: {
                        model: null,
                        spawnModel: null,
                    },
                    providers: [
                        {
                            alias: "mocktest/fast",
                            provider: "mocktest",
                            model: "fast",
                            active: true,
                        },
                    ],
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
                    status: {
                        model: null,
                        spawnModel: null,
                    },
                    providers: [
                        {
                            alias: "mocktest/fast",
                            provider: "mocktest",
                            model: "fast",
                            active: true,
                        },
                    ],
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
                if (params.kind === "models.list") {
                    return {
                        items: [
                            {
                                selector: "mocktest/fast",
                                modelName: "Fast",
                                limits: { contextTokens: 128000 },
                                capabilities: { reasoning: false, efforts: [] },
                                readiness: { ready: true, causes: [] },
                            },
                        ],
                        offset: 0,
                        total: 1,
                    };
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
        const rendered = stripVTControlCharacters(termWrites.join(""));
        assert.match(rendered, /model: mocktest\/fast/u);
        assert.doesNotMatch(rendered, /No model selected/u);
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
                if (params.kind === "models.list") {
                    return {
                        items: [
                            {
                                selector: "mocktest/fast",
                                modelName: "Fast",
                                limits: { contextTokens: 128000 },
                                capabilities: { reasoning: false, efforts: [] },
                                readiness: { ready: true, causes: [] },
                            },
                        ],
                        offset: 0,
                        total: 1,
                    };
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
        .onRequest(methods.agent.session.new, async ({ client }) => {
            await client.notify(methods.client.session.update, {
                sessionId: "1#user",
                update: {
                    sessionUpdate: "notice",
                    severity: "warning",
                    title: "engine:configuration:configuration_error",
                    description: "Configuration skipped mcp: '/tmp/mcp.json' requires object 'mcpServers'",
                    _meta: {
                        plurnk: {
                            notice: {
                                source: "engine:configuration",
                                kind: "configuration_error",
                                level: "warn",
                                scope: "mcp",
                                message: "'/tmp/mcp.json' requires object 'mcpServers'",
                            },
                        },
                    },
                },
            });
            return {
                sessionId: "1#user",
                configOptions: [],
                _meta: {
                    plurnk: {
                        workspace: { id: 1, name: "alpha", projectRoot: "/tmp/alpha" },
                        sessionName: "user",
                        status: {
                            model: null,
                        },
                    },
                },
            };
        })
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
                if (params.kind === "models.list") {
                    return {
                        items: [
                            {
                                selector: "mocktest/fast",
                                modelName: "Fast",
                                limits: { contextTokens: 128000 },
                                capabilities: { reasoning: false, efforts: [] },
                                readiness: { ready: true, causes: [] },
                            },
                        ],
                        offset: 0,
                        total: 1,
                    };
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

        // 1. Modelless startup warning, startup configuration notice, and `none` in status bar
        await waitUntil(
            () =>
                termWrites.join("").includes("/model <selector> chooses one.") &&
                termWrites.join("").includes("Configuration skipped mcp: '/tmp/mcp.json' requires object 'mcpServers'"),
        );
        assert.match(termWrites.join(""), /No model selected\. \/models lists ready models and \/model <selector> chooses one\./u);
        assert.match(termWrites.join(""), /· none ·/u);

        // 1b. /model with no args prints current model (none) and /models prints aligned table
        assert.ok(inputCallback !== null);
        inputCallback!("/model");
        inputCallback!("\r");
        await waitUntil(() => termWrites.join("").includes("model (Model): none"));
        inputCallback!("/models");
        inputCallback!("\r");
        await waitUntil(() => termWrites.join("").includes("selector") && termWrites.join("").includes("mocktest/fast"));

        // 2. Sending a prompt when modelless rejects and resets status bar to ❌ instead of hanging in ⌛︎
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
                    title: "sh — turn1_sh_aside",
                    status: "pending",
                    rawInput: { body: "echo turn1_sh", aside: "turn1_sh_aside" },
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
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "plan_update",
                    plan: {
                        type: "items",
                        planId: "plan",
                        entries: [
                            { content: "Survey the environment.", priority: "medium", status: "completed" },
                            { content: "Resolve all Open Work.", priority: "medium", status: "pending" },
                        ],
                    },
                    _meta: {
                        plurnk: {
                            id: 24573,
                            loopSeq: 17,
                            turnSeq: 1,
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
                    title: "sh — turn1_sh_aside",
                    status: "completed",
                    rawInput: { body: "echo turn1_sh", aside: "turn1_sh_aside" },
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
            // Turn 2 also emits a plan_update at 17/2/2 and a KILL with a distillation body (17/2/6) and its synthesized NOTE (17/2/7) (#244)
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "plan_update",
                    plan: {
                        type: "items",
                        planId: "plan",
                        entries: [
                            { content: "Survey the environment.", priority: "medium", status: "completed" },
                            { content: "Resolve all Open Work.", priority: "medium", status: "completed" },
                            { content: "Implement xcp2.", priority: "medium", status: "pending" },
                        ],
                    },
                    _meta: {
                        plurnk: {
                            id: 24580,
                            loopSeq: 17,
                            turnSeq: 2,
                        },
                    },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: "17/2/6",
                    name: "KILL",
                    title: "KILL (log:///17/1/*/{READ,sh}) — retire turn 1 transcripts",
                    status: "completed",
                    locations: [{ path: "log:///17/1/*/{READ,sh}" }],
                    rawInput: {
                        target: { raw: "log:///17/1/*/{READ,sh}" },
                        aside: "retire turn 1 transcripts",
                        body: "DISTILLED_KILL_NOTE_BODY",
                    },
                    _meta: {
                        plurnk: {
                            id: 24581,
                            coordinate: "17/2/6",
                            op: "KILL",
                            origin: "model",
                            status: 200,
                        },
                    },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: "17/2/7",
                    name: "NOTE",
                    title: "NOTE",
                    status: "completed",
                    rawInput: {
                        aside: null,
                        target: null,
                        body: "DISTILLED_KILL_NOTE_BODY",
                    },
                    _meta: {
                        plurnk: {
                            id: 24582,
                            coordinate: "17/2/7",
                            op: "NOTE",
                            origin: "model",
                            status: 200,
                            attrs: {
                                distilled: "log:///17/1/*/{READ,sh}",
                            },
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
        const shPos = promptWrites.lastIndexOf("turn1_sh_aside");
        const turn1PlanClosedPos = promptWrites.lastIndexOf("🗹 Survey the environment.");
        const turn1PlanOpenPos = promptWrites.lastIndexOf("☐ Resolve all Open Work.");
        const notePos = promptWrites.lastIndexOf("TURN_2_NOTE_BODY");
        const killPos = promptWrites.lastIndexOf("retire turn 1 transcripts");
        const distilledBodyPos = promptWrites.lastIndexOf("    DISTILLED_KILL_NOTE_BODY");
        const turn2PlanClosedPos = promptWrites.lastIndexOf("🗹 Resolve all Open Work.");
        const turn2PlanOpenPos = promptWrites.lastIndexOf("☐ Implement xcp2.");
        const hamsterPos = promptWrites.lastIndexOf("FINAL_HAMSTER_REPLY");
        assert.ok(shPos >= 0, "17/1/5 sh single-line receipt must be rendered");
        assert.equal(promptWrites.includes("echo turn1_sh"), false, "sh script body must not be previewed");
        assert.ok(turn1PlanClosedPos > shPos, "Turn 1 plan diff must appear at the end of Turn 1 after 17/1/5 sh");
        assert.ok(turn1PlanOpenPos > turn1PlanClosedPos, "Turn 1 plan diff renders ☐ after 🗹");
        assert.ok(notePos > turn1PlanOpenPos, "Turn 1 plan diff must appear before Turn 2 NOTE (17/2/1)");
        assert.ok(killPos > notePos, "17/2/6 KILL row must appear after 17/2/1 NOTE");
        assert.ok(
            distilledBodyPos > killPos,
            "KILL distillation body must render indented 4 columns beneath the 🗑️ row",
        );
        assert.equal(
            promptWrites.includes("\n🗒️\nDISTILLED_KILL_NOTE_BODY") ||
                promptWrites.includes("\n🗒️  \nDISTILLED_KILL_NOTE_BODY"),
            false,
            "synthesized NOTE with attrs.distilled must not render a standalone 🗒️ block",
        );
        assert.ok(
            turn2PlanClosedPos > distilledBodyPos,
            "Turn 2 plan diff (emitted at 17/2/2) must sit at the end of Turn 2 after 17/2/6 KILL",
        );
        assert.ok(turn2PlanOpenPos > turn2PlanClosedPos, "Turn 2 plan diff renders ☐ Implement xcp2.");
        assert.ok(hamsterPos > turn2PlanOpenPos, "Turn 7 🐹 reply must appear below Turn 2 plan diff");
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

test("{§cli-rendering} {§cli-session-status}: Up-arrow prompt history retains all session prompts across tool-heavy turns and mid-session reconnects without duplicating transcript rows", async () => {
    const sseResponses = new Set<http.ServerResponse>();
    let resumeCount = 0;

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
                    status: { lifecycle: "idle", loopId: 1, loopSeq: 1, packetCount: 1 },
                },
            },
        }))
        .onRequest(methods.agent.session.resume, async ({ client, params }) => {
            resumeCount += 1;
            // Turn 1: user prompt followed by 5 tool calls and 1 agent reply (7 items total).
            // With historyEntries: 3, the user prompt is outside the 3-item transcript slice,
            // yet must still populate Up-arrow prompt history.
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "user_message_chunk",
                    messageId: "1/1/1",
                    content: { type: "text", text: "OLDER_PROMPT_BEFORE_MANY_TOOLS" },
                    _meta: {
                        plurnk: {
                            id: 1,
                            loopSeq: 1,
                            turnSeq: 1,
                            seq: 1,
                            coordinate: "1/1/1",
                            op: "SEND",
                            origin: "user",
                            status: 200,
                        },
                    },
                },
            });
            for (let i = 1; i <= 5; i += 1) {
                const seq = i + 1;
                await client.notify(methods.client.session.update, {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: `1/1/${String(seq)}`,
                        name: "READ",
                        title: `READ file-${String(i)}.ts`,
                        status: "completed",
                        locations: [{ path: `file-${String(i)}.ts` }],
                        rawInput: { target: `file-${String(i)}.ts` },
                        rawOutput: { lines: 10 },
                        _meta: {
                            plurnk: {
                                id: seq,
                                loopSeq: 1,
                                turnSeq: 1,
                                seq,
                                coordinate: `1/1/${String(seq)}`,
                                op: "READ",
                                origin: "model",
                                status: 200,
                            },
                        },
                    },
                });
            }
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: "1/1/7",
                    content: { type: "text", text: "FIRST_TURN_REPLY" },
                    _meta: {
                        plurnk: {
                            id: 7,
                            loopSeq: 1,
                            turnSeq: 1,
                            seq: 7,
                            coordinate: "1/1/7",
                            op: "SEND",
                            origin: "model",
                            status: 200,
                        },
                    },
                },
            });
            if (resumeCount >= 2) {
                // On the reconnect resume, also replay a turn that occurred while disconnected.
                await client.notify(methods.client.session.update, {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: "user_message_chunk",
                        messageId: "2/1/1",
                        content: { type: "text", text: "MISSED_PROMPT_DURING_DISCONNECT" },
                        _meta: {
                            plurnk: {
                                id: 8,
                                loopSeq: 2,
                                turnSeq: 1,
                                seq: 1,
                                coordinate: "2/1/1",
                                op: "SEND",
                                origin: "user",
                                status: 200,
                            },
                        },
                    },
                });
                await client.notify(methods.client.session.update, {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        messageId: "2/1/2",
                        content: { type: "text", text: "MISSED_REPLY_DURING_DISCONNECT" },
                        _meta: {
                            plurnk: {
                                id: 9,
                                loopSeq: 2,
                                turnSeq: 1,
                                seq: 2,
                                coordinate: "2/1/2",
                                op: "SEND",
                                origin: "model",
                                status: 200,
                            },
                        },
                    },
                });
            }
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "state_update",
                    state: "idle",
                    stopReason: "end_turn",
                },
            });
            return { configOptions: [] };
        })
        .onRequest(
            "_plurnk/action",
            (raw) => raw as { kind: string },
            async ({ params }) => {
                if (params.kind === "workspace.sessions") {
                    return { sessions: [{ id: 1, name: "user", lifecycle: "idle" }] };
                }
                if (params.kind === "workspace.list") {
                    return { workspaces: [{ id: 1, name: "alpha", project_root: "/tmp/alpha" }] };
                }
                if (params.kind === "models.list") {
                    return {
                        items: [
                            {
                                selector: "mocktest/fast",
                                modelName: "Fast",
                                limits: { contextTokens: 128000 },
                                capabilities: { reasoning: false, efforts: [] },
                                readiness: { ready: true, causes: [] },
                            },
                        ],
                        offset: 0,
                        total: 1,
                    };
                }
                return {};
            },
        )
        .onRequest(methods.agent.session.prompt, async ({ client, params }) => {
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: "3/1/2",
                    content: { type: "text", text: "POST_RECONNECT_REPLY" },
                    _meta: {
                        plurnk: {
                            id: 11,
                            loopSeq: 3,
                            turnSeq: 1,
                            seq: 2,
                            coordinate: "3/1/2",
                            op: "SEND",
                            origin: "model",
                            status: 200,
                        },
                    },
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
                            loopSeq: 3,
                            terminal: { status: 200, turnCount: 1 },
                        },
                    },
                },
            });
            return { stopReason: "end_turn", messageId: "3/1/2" };
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
        workspace: "alpha",
        sessionId: "user",
        tuiSession: "user",
        yolo: true,
        auto: false,
        json: false,
        repl: false,
        statusStream: false,
        previewLines: 5,
        historyEntries: 3,
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

        await waitUntil(() => termWrites.join("").includes("FIRST_TURN_REPLY"));
        assert.ok(inputCallback !== null);

        // Even though historyEntries=3 sliced off OLDER_PROMPT_BEFORE_MANY_TOOLS from the rendered
        // transcript, pressing Up-arrow recalls it into the composer.
        const beforeUp = termWrites.length;
        inputCallback!("\x1b[A");
        await waitUntil(() => termWrites.slice(beforeUp).join("").includes("OLDER_PROMPT_BEFORE_MANY_TOOLS"));
        // Clear editor input with Escape
        inputCallback!("\x1b");

        // Drop the SSE stream to trigger a mid-session disconnect, then send a new prompt to force reconnect + resume.
        const beforeDisconnect = termWrites.length;
        for (const res of [...sseResponses]) {
            res.end();
        }
        await waitUntil(() => termWrites.slice(beforeDisconnect).join("").includes("🔌"));

        const beforeReconnectPrompt = termWrites.length;
        inputCallback!("trigger reconnect");
        inputCallback!("\r");
        await waitUntil(() => termWrites.slice(beforeReconnectPrompt).join("").includes("POST_RECONNECT_REPLY"));

        const reconnectWrites = termWrites.slice(beforeReconnectPrompt).join("");
        assert.ok(
            reconnectWrites.includes("MISSED_PROMPT_DURING_DISCONNECT"),
            "missed user prompt during disconnect is materialized on reconnect",
        );
        assert.ok(
            reconnectWrites.includes("MISSED_REPLY_DURING_DISCONNECT"),
            "missed agent reply during disconnect is materialized on reconnect",
        );
        assert.ok(
            !reconnectWrites.includes("FIRST_TURN_REPLY"),
            "already-settled FIRST_TURN_REPLY is not re-emitted on reconnect",
        );

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

test("{§cli-rendering} {§cli-markdown-projection} {§cli-session-status} {§cli-sessions-topology}: TuiSurface enforces the 5-container pinned chrome budget, 3-line rolling reasoning + 1-line active streams/workers reservation, 0-line idle collapse, and bounded extractPromptHistory (#236, #238)", () => {
    let currentRows = 6;
    const fakeTerminal: Terminal = {
        start: () => {},
        stop: () => {},
        write: () => {},
        get columns() {
            return 80;
        },
        get rows() {
            return currentRows;
        },
        get kittyProtocolActive() {
            return false;
        },
        moveBy: () => {},
        hideCursor: () => {},
        showCursor: () => {},
        clearLine: () => {},
        clearFromCursor: () => {},
        clearScreen: () => {},
        setTitle: () => {},
        onResize: () => () => {},
        onData: () => () => {},
        onColorScheme: () => () => {},
    } as unknown as Terminal;

    const surface = new TuiSurface(fakeTerminal);
    assert.equal(surface.chromeChildCount, 5, "TuiMainScreen holds exactly 5 top-level containers");
    assert.deepEqual(surface.renderLiveLines(80), [], "live reasoning region occupies 0 lines when idle");

    // While a loop is active, #live reserves 3 reasoning lines + 1 activity line (4 lines total) to prevent jumping
    surface.setLoopActive(true);
    assert.deepEqual(surface.renderLiveLines(80), ["", "", "", ""]);
    surface.setLive("thought-line-1");
    assert.deepEqual(surface.renderLiveLines(80), ["thought-line-1", "", "", ""]);

    const twentyLines = Array.from({ length: 20 }, (_, idx) => `thought-line-${idx + 1}`).join("\n");
    surface.setLive(twentyLines);

    // Fixed 3-line rolling reasoning cap + 1 activity line across all terminal heights (#238)
    for (const rows of [6, 12, 24]) {
        currentRows = rows;
        assert.deepEqual(surface.renderLiveLines(80), [
            "thought-line-18",
            "thought-line-19",
            "thought-line-20",
            "",
        ]);
    }

    surface.setLiveActivity("⚙️  sh (sh:///1/1/2/sh) 4.2s · 🐜 WORK (session:///helper) 12.0s");
    assert.deepEqual(surface.renderLiveLines(80), [
        "thought-line-18",
        "thought-line-19",
        "thought-line-20",
        "⚙️  sh (sh:///1/1/2/sh) 4.2s · 🐜 WORK (session:///helper) 12.0s",
    ]);

    // renderReasoning formats at most the newest 3 lines with 💭 on line 1 and 3-space indent on lines 2-3
    const renderedTail = stripVTControlCharacters(renderReasoning("l1\nl2\nl3\nl4"));
    assert.deepEqual(renderedTail.split("\n"), ["💭 l2", "   l3", "   l4"]);

    // Collapses back to 0 lines when retired and loop is idle
    surface.setLive(null);
    surface.setLiveActivity(null);
    surface.setLoopActive(false);
    assert.deepEqual(surface.renderLiveLines(80), []);
    assert.equal(surface.chromeChildCount, 5);

    // Status line and TailText truncate to terminal width instead of wrapping onto multiple lines (#238)
    surface.setStatus(
        "[plurnk-service/~service(12/8)] ⌛︎  · deepseek/deepseek-reasoner(high) · 42s · ↓128k ↑16k · $1.2345 · READ src/very/long/path.ts",
    );
    const truncatedStatus = surface.renderStatusLines(50);
    assert.equal(truncatedStatus.length, 1, "status line must never wrap onto a second line");
    assert.ok(stripVTControlCharacters(truncatedStatus[0]!).includes("…"));
    assert.equal(stripVTControlCharacters(truncatedStatus[0]!).length, 50);

    // Active streams & workers strip: synchronous verbs (READ, FIND, EDIT, etc.) never appear,
    // streams appear only after surviving past their opening turn, and workers appear while active (#238)
    const presenter = new SessionPresenter({ workspaceName: "ws", sessionName: "user" });
    presenter.markTurnStart(1_000);
    presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "1/1/1",
        name: "READ",
        title: "READ (workspace:///README.md)",
        status: "in_progress",
        _meta: { plurnk: { op: "READ", turnSeq: 1 } },
    });
    assert.equal(presenter.activeLiveEntries.length, 0, "READ must never enter activeLiveEntries");

    presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "1/1/2",
        name: "sh",
        title: "sh",
        status: "in_progress",
        _meta: { plurnk: { id: 42, op: "sh", turnSeq: 1, attrs: { stream: "sh:///1/1/2/sh" } } },
    });
    assert.equal(
        presenter.activeLiveEntries.length,
        0,
        "stream in its opening turn does not enter activeLiveEntries before turn boundary",
    );

    // Advancing to turn 2 promotes the surviving open stream; spawning WORK adds the active worker
    presenter.apply({
        sessionUpdate: "notice",
        severity: "info",
        title: "engine:turn:turn_awaiting_model",
        _meta: { plurnk: { notice: { source: "engine:turn", kind: "turn_awaiting_model" } } },
    });
    presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "1/2/1",
        name: "WORK",
        title: "WORK (session:///helper)",
        status: "completed",
        _meta: { plurnk: { op: "WORK", status: 200, turnSeq: 2, attrs: { session: "session:///helper" } } },
    });
    assert.equal(presenter.activeLiveEntries.length, 2);
    const stripText = stripVTControlCharacters(
        renderActiveLiveLine(presenter.activeLiveEntries, 80, Date.now() + 5_000),
    );
    assert.match(stripText, /^⚙️ {2}sh \(sh:\/\/\/1\/1\/2\/sh\) \S+ · 🐜 WORK \(session:\/\/\/helper\) \S+$/u);

    // Concluding the stream and worker removes them from activeLiveEntries
    presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "1/1/2",
        name: "sh",
        status: "completed",
        _meta: { plurnk: { id: 42, op: "sh", status: 200, attrs: { stream: "sh:///1/1/2/sh" } } },
    });
    presenter.apply({
        sessionUpdate: "subagent_update",
        sessionId: "1#helper",
        title: "helper",
        state: { state: "idle", stopReason: "end_turn" },
    });
    assert.equal(presenter.activeLiveEntries.length, 0);

    // extractPromptHistory bounds user prompts to maxEntries without letting tool calls evict them
    const session = new AcpSession("1#user");
    for (let i = 1; i <= 5; i += 1) {
        session.applyUpdate({
            sessionUpdate: "user_message_chunk",
            messageId: `prompt-${i}`,
            content: { type: "text", text: `Prompt ${i}` },
            _meta: { plurnk: { id: i * 10, coordinate: `${i}/0/0`, published: true } },
        });
        for (let t = 1; t <= 5; t += 1) {
            session.applyUpdate({
                sessionUpdate: "tool_call_update",
                toolCallId: `${i}/1/${t}`,
                title: `READ (workspace:///file-${t}.ts)`,
                status: "completed",
                _meta: { plurnk: { id: i * 10 + t, coordinate: `${i}/1/${t}` } },
            });
        }
    }
    assert.deepEqual(extractPromptHistory(session, 3), ["Prompt 3", "Prompt 4", "Prompt 5"]);
});

test("{§cli-model-selection} {§cli-interactive-command-discovery}: makeAutocompleteProvider completes /models, /model, /child by longest common prefix and /model <selector> <effort> slot 3 (#237)", async () => {
    assert.equal(longestCommonPrefix([]), "");
    assert.equal(longestCommonPrefix(["anthropic/claude-sonnet-4"]), "anthropic/claude-sonnet-4");
    assert.equal(
        longestCommonPrefix(["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"]),
        "deepseek/deepseek-",
    );
    assert.equal(
        longestCommonPrefix(["anthropic/claude-sonnet-4", "deepseek/deepseek-chat"]),
        "",
    );

    const signal = new AbortController().signal;
    const multiCatalog = [
        "anthropic/claude-sonnet-4",
        "deepseek/deepseek-chat",
        "deepseek/deepseek-reasoner",
    ];
    let currentCatalog = multiCatalog;

    const provider = makeAutocompleteProvider({
        cwd: "/tmp",
        getProjectRoot: () => "/tmp",
        getModels: () => currentCatalog,
        getProviderModels: async (prov) =>
            prov === "openai" ? ["openai/gpt-4o-mini", "openai/gpt-4o-realtime"] : [],
        getEfforts: () => ["low", "medium", "high"],
        getPersonas: () => ["none", "architect", "archivist"],
        getSessionNames: () => ["user", "worker-1", "worker-2"],
        getWorkspaceNames: () => ["alpha", "beta"],
    });

    // 1. ["/models "] with multi-provider catalog -> LCP is "", lists all 3 models
    const allOpen = await provider.getSuggestions(["/models "], 0, 8, { signal, force: false });
    assert.deepEqual(
        allOpen?.items.map((i) => i.value),
        multiCatalog,
    );
    assert.equal(allOpen?.prefix, "");

    const allForced = await provider.getSuggestions(["/models "], 0, 8, { signal, force: true });
    assert.deepEqual(
        allForced?.items.map((i) => i.value),
        multiCatalog,
    );
    assert.equal(allForced?.prefix, "");

    // 2. ["/models "] with single-provider catalog + force: true -> single LCP item "deepseek/deepseek-"
    currentCatalog = ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"];
    const singleProvForced = await provider.getSuggestions(["/models "], 0, 8, { signal, force: true });
    assert.deepEqual(
        singleProvForced?.items.map((i) => i.value),
        ["deepseek/deepseek-"],
    );
    assert.equal(singleProvForced?.prefix, "");
    currentCatalog = multiCatalog;

    // 3. ["/models dee"] -> force: true returns single LCP item "deepseek/deepseek-";
    //    force: false returns both candidates with lcp attached to items[0]
    const deeForced = await provider.getSuggestions(["/models dee"], 0, 11, { signal, force: true });
    assert.deepEqual(
        deeForced?.items.map((i) => i.value),
        ["deepseek/deepseek-"],
    );
    assert.equal(deeForced?.prefix, "dee");

    const deeRegular = await provider.getSuggestions(["/models dee"], 0, 11, { signal, force: false });
    assert.deepEqual(
        deeRegular?.items.map((i) => i.value),
        ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"],
    );
    assert.equal(deeRegular?.prefix, "dee");
    // Applying items[0] while at "dee" extends to the LCP ("deepseek/deepseek-")
    assert.deepEqual(
        provider.applyCompletion(["/models dee"], 0, 11, deeRegular!.items[0]!, deeRegular!.prefix),
        { lines: ["/models deepseek/deepseek-"], cursorLine: 0, cursorCol: 26 },
    );
    // Applying items[1] (user arrowed down) completes the full candidate directly
    assert.deepEqual(
        provider.applyCompletion(["/models dee"], 0, 11, deeRegular!.items[1]!, deeRegular!.prefix),
        { lines: ["/models deepseek/deepseek-reasoner"], cursorLine: 0, cursorCol: 34 },
    );

    // 4. ["/models deepseek/deepseek-"] -> already at LCP, returns both candidates without lcp override
    const atLcpForced = await provider.getSuggestions(["/models deepseek/deepseek-"], 0, 26, {
        signal,
        force: true,
    });
    assert.deepEqual(
        atLcpForced?.items.map((i) => i.value),
        ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"],
    );
    assert.equal(atLcpForced?.prefix, "deepseek/deepseek-");
    assert.deepEqual(
        provider.applyCompletion(
            ["/models deepseek/deepseek-"],
            0,
            26,
            atLcpForced!.items[0]!,
            atLcpForced!.prefix,
        ),
        { lines: ["/models deepseek/deepseek-chat"], cursorLine: 0, cursorCol: 30 },
    );

    // 5. ["/models deepseek/deepseek-r"] -> single match "deepseek/deepseek-reasoner"
    const singleHit = await provider.getSuggestions(["/models deepseek/deepseek-r"], 0, 27, {
        signal,
        force: true,
    });
    assert.deepEqual(
        singleHit?.items.map((i) => i.value),
        ["deepseek/deepseek-reasoner"],
    );
    assert.equal(singleHit?.prefix, "deepseek/deepseek-r");

    // 6. ["/models ant"] -> single match "anthropic/claude-sonnet-4"
    const antHit = await provider.getSuggestions(["/models ant"], 0, 11, { signal, force: true });
    assert.deepEqual(
        antHit?.items.map((i) => i.value),
        ["anthropic/claude-sonnet-4"],
    );
    assert.equal(antHit?.prefix, "ant");

    // 7. ["/models zzz"] -> null
    const noHit = await provider.getSuggestions(["/models zzz"], 0, 11, { signal, force: true });
    assert.equal(noHit, null);

    // 8. ["/model dee"] & ["/child "] & lazy provider catalog ["/models openai/gp"]
    const modelDee = await provider.getSuggestions(["/model dee"], 0, 10, { signal, force: true });
    assert.deepEqual(
        modelDee?.items.map((i) => i.value),
        ["deepseek/deepseek-"],
    );
    assert.equal(modelDee?.prefix, "dee");

    const childOpen = await provider.getSuggestions(["/child "], 0, 7, { signal, force: false });
    assert.deepEqual(
        childOpen?.items.map((i) => i.value),
        ["inherit", ...multiCatalog],
    );

    const lazyProviderLcp = await provider.getSuggestions(["/models openai/gp"], 0, 17, {
        signal,
        force: true,
    });
    assert.deepEqual(
        lazyProviderLcp?.items.map((i) => i.value),
        ["openai/gpt-4o-"],
    );
    assert.equal(lazyProviderLcp?.prefix, "openai/gp");

    // 9. ["/model deepseek/deepseek-reasoner "] and ["/model deepseek/deepseek-reasoner h"] (slot 3 effort)
    const modelEffortOpen = await provider.getSuggestions(
        ["/model deepseek/deepseek-reasoner "],
        0,
        34,
        { signal, force: false },
    );
    assert.deepEqual(
        modelEffortOpen?.items.map((i) => i.value),
        ["low", "medium", "high"],
    );
    assert.equal(modelEffortOpen?.prefix, "");

    const modelEffortForced = await provider.getSuggestions(
        ["/model deepseek/deepseek-reasoner h"],
        0,
        35,
        { signal, force: true },
    );
    assert.deepEqual(
        modelEffortForced?.items.map((i) => i.value),
        ["high"],
    );
    assert.equal(modelEffortForced?.prefix, "h");

    // 10. End-to-end keystroke walk-through on TuiSurface.editor:
    //     Type "/models dee" -> Tab extends to "/models deepseek/deepseek-" -> type "r" -> Tab completes "/models deepseek/deepseek-reasoner"
    let onTermInput = null as ((data: string) => void) | null;
    const fakeTerm: Terminal = {
        columns: 100,
        rows: 24,
        kittyProtocolActive: false,
        start(cb: (data: string) => void) {
            onTermInput = cb;
        },
        stop() {},
        async drainInput() {},
        write() {},
        moveBy() {},
        hideCursor() {},
        showCursor() {},
        clearLine() {},
        clearFromCursor() {},
        clearScreen() {},
        setTitle() {},
        setProgress() {},
        setProgramStatus() {},
    };
    const surface = new TuiSurface(fakeTerm);
    surface.setAutocompleteProvider(provider);
    surface.start();
    try {
        assert.ok(onTermInput !== null);
        for (const ch of "/models dee") {
            onTermInput!(ch);
            await new Promise((r) => setTimeout(r, 5));
        }
        assert.equal(surface.editor.getText(), "/models dee");
        onTermInput!("\t");
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(surface.editor.getText(), "/models deepseek/deepseek-");
        assert.equal(
            surface.editor.isShowingAutocomplete(),
            true,
            "narrowed candidate popup remains open in the same Tab keystroke after LCP extension",
        );

        onTermInput!("r");
        await new Promise((r) => setTimeout(r, 10));
        onTermInput!("\t");
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(surface.editor.getText(), "/models deepseek/deepseek-reasoner");

        // Single-provider catalog: "/models " + Tab extends to "deepseek/deepseek-" and keeps list open in the same keystroke
        currentCatalog = ["deepseek/deepseek-chat", "deepseek/deepseek-reasoner"];
        surface.setInput("/models ");
        onTermInput!("\t");
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(surface.editor.getText(), "/models deepseek/deepseek-");
        assert.equal(
            surface.editor.isShowingAutocomplete(),
            true,
            "single-provider Tab extends to provider prefix and keeps candidate popup open in the same keystroke",
        );
        currentCatalog = multiCatalog;

        // Now test /model dee -> Tab (LCP + popup stays open) -> Tab (selects first item) -> " h" -> Tab (effort)
        surface.setInput("");
        for (const ch of "/model dee") {
            onTermInput!(ch);
            await new Promise((r) => setTimeout(r, 5));
        }
        onTermInput!("\t");
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(surface.editor.getText(), "/model deepseek/deepseek-");
        assert.equal(surface.editor.isShowingAutocomplete(), true);
        onTermInput!("\t");
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(surface.editor.getText(), "/model deepseek/deepseek-chat");
        for (const ch of " h") {
            onTermInput!(ch);
            await new Promise((r) => setTimeout(r, 5));
        }
        onTermInput!("\t");
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(surface.editor.getText(), "/model deepseek/deepseek-chat high");
    } finally {
        surface.stop();
    }
});


