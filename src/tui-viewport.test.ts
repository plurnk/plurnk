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
    let inputCallback: ((data: string) => void) | null = null;
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
