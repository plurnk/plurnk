// Unit coverage for Term viewport input caches, gate auto-routing, external editor handoff,
// history replay, and non-surface/surface event projection ({§cli-repl-mode}, {§cli-model-selection},
// {§cli-inline-review}, {§cli-rendering}, {§cli-sessions-topology}).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createNodeHttpHandler } from "@agentclientprotocol/sdk/experimental/node";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import {
    agent as createAcpAgent,
    methods,
    PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { Terminal } from "@earendil-works/pi-tui";
import type { CliCommonOptions } from "./cli-connection.ts";
import Credential from "./credential.ts";
import { SessionPresenter } from "./session-presenter.ts";
import TermSurface from "./term-surface.ts";
import {
    attachViewportOutputListeners,
    extractUpdateText,
    renderHistoryItemsToSurface,
} from "./term-viewport-events.ts";
import {
    applyAvailableCommandsToCache,
    applyConfigOptionsToCache,
    attachViewportSurfaceInput,
    cancelViewportRun,
    editInExternalEditor,
    flattenSelectOptionValues,
    routeAndSendLine,
    type TermViewportState,
} from "./term-viewport-input.ts";
import { runTermViewport } from "./term-viewport.ts";

class StubTerminal implements Terminal {
    columns = 80;
    rows = 24;
    kittyProtocolActive = false;
    onInput?: (data: string) => void;
    readonly writes: string[] = [];

    start(onInput: (data: string) => void): void {
        this.onInput = onInput;
    }
    stop(): void {}
    async drainInput(): Promise<void> {}
    write(data: string): void {
        this.writes.push(data);
    }
    moveBy(): void {}
    hideCursor(): void {}
    showCursor(): void {}
    clearLine(): void {}
    clearFromCursor(): void {}
    clearScreen(): void {}
    setTitle(): void {}
    setProgress(): void {}
    setProgramStatus(): void {}
}

test("{§cli-repl-mode} {§cli-model-selection} {§cli-inline-review}: term-viewport-input caches, gate routing, editor handoff, and surface keybindings", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plurnk-vp-unit-"));
    try {
        const importPath = join(tmpDir, "snippet.md");
        writeFileSync(importPath, "imported snippet", "utf8");
        const fakeEditor = join(tmpDir, "ed.mjs");
        writeFileSync(
            fakeEditor,
            `import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "from editor\\n");\n`,
            "utf8",
        );

        assert.equal(
            editInExternalEditor("seed", { VISUAL: `${process.execPath} ${fakeEditor}` }),
            "from editor\n",
        );
        assert.equal(editInExternalEditor("seed", { VISUAL: `${process.execPath} -e "process.exit(2)"` }), null);

        assert.deepEqual(
            flattenSelectOptionValues([
                { value: "a" },
                { options: [{ value: "b" }, { value: "c" }] },
            ]),
            ["a", "b", "c"],
        );

        const term = new StubTerminal();
        const surface = new TermSurface(term);
        surface.start();
        const replStdin = new PassThrough();
        const stdinSent: string[] = [];
        replStdin.on("data", (c) => stdinSent.push(String(c)));

        const presenter = new SessionPresenter({ workspaceName: "ws1", sessionName: "s1", model: "fast" });
        const state: TermViewportState = {
            options: {
                cwd: tmpDir,
                env: { VISUAL: `${process.execPath} ${fakeEditor}` },
                previewLines: 3,
                mermaidTimeoutMs: 1000,
            } as unknown as CliCommonOptions,
            replStdin,
            termOut: new PassThrough(),
            termErr: new PassThrough(),
            surface,
            review: null,
            attend: () => {},
            presenter,
            initialPromptPrinted: true,
            initialWorkspaceConsumed: true,
            boundProjectRoot: tmpDir,
            cachedModels: [],
            cachedEfforts: [],
            cachedPersonas: [],
            cachedSessions: [],
            cachedWorkspaces: [],
            cachedSkills: [],
            cachedAvailableCommands: [],
            currentPersona: null,
            currentMode: null,
            providerModelsFetcher: null,
            modelSearchFetcher: null,
            modelEffortsFetcher: null,
            cachedFamilyAliases: new Map(),
            currentTurns: 0,
            cancelArmed: false,
            focusedGateIds: ["11223344"],
            suppressedStdoutQueue: [],
            localSubmittedPrompts: [],
            updateSurfaceStatus: () => {},
            ensureSurfaceStarted: () => {},
            retireLiveReasoning: () => {},
            renderToolCallToSurface: () => {},
        };

        applyAvailableCommandsToCache(state, [
            { type: "skill", name: "audit", description: "" },
            { type: "skill", name: "audit", description: "dup" },
            { type: "command", name: "ops:deploy", description: "" },
            { type: "command", name: "ops:deploy", description: "dup" },
        ]);
        assert.equal(state.cachedSkills.length, 1);
        assert.equal(state.cachedSkills[0]?.description, "skill");
        assert.equal(state.cachedAvailableCommands.length, 1);
        assert.equal(state.cachedAvailableCommands[0]?.description, "command");

        applyConfigOptionsToCache(state, [
            { configId: "model", currentValue: "pro", options: [{ value: "pro" }, { value: "none" }] },
            { configId: "thought_level", currentValue: "high", options: [{ value: "low" }, { value: "high" }] },
            { configId: "persona", currentValue: "coder", options: [{ value: "none" }, { value: "coder" }] },
            { configId: "child", currentValue: "fast" },
            { configId: "mode", currentValue: "accept" },
            { configId: "mcp:gitea", currentValue: "true" },
        ]);
        assert.equal(presenter.model, "pro");
        assert.equal(presenter.effort, "high");
        assert.equal(state.currentPersona, "coder");
        assert.equal(presenter.childModel, "fast");
        assert.equal(state.currentMode, "accept");
        assert.deepEqual(state.cachedFamilyAliases.get("mcp"), ["gitea"]);

        // Focused gate auto-routing (single-line and multiline)
        routeAndSendLine(state, "/approve");
        routeAndSendLine(state, "/edit patched\nline2");
        routeAndSendLine(state, "/ops:deploy");
        assert.equal(stdinSent[0], "/approve @11223344\n");
        assert.equal(stdinSent[1], "\x1b[200~/edit @11223344 patched\nline2\x1b[201~\n");
        assert.equal(stdinSent[2], "/ops:deploy\n");
        stdinSent.length = 0;

        cancelViewportRun(state);
        assert.equal(state.cancelArmed, true);
        assert.equal(stdinSent[0], "/stop\n");
        stdinSent.length = 0;

        const detach = attachViewportSurfaceInput(state);
        // Ctrl+C while cancelArmed -> /quit
        term.onInput?.("\x03");
        assert.equal(stdinSent.at(-1), "/quit\n");
        stdinSent.length = 0;

        // Escape clears non-empty draft when idle and no gates
        state.focusedGateIds.length = 0;
        presenter.lifecycle = "idle";
        surface.setInput("draft text");
        term.onInput?.("\x1b");
        assert.equal(surface.editor.getText(), "");

        // Alt+m sends /models, Ctrl+D on empty composer sends /quit
        term.onInput?.("\x1bm");
        assert.equal(stdinSent.at(-1), "/models\n");
        term.onInput?.("\x04");
        assert.equal(stdinSent.at(-1), "/quit\n");
        stdinSent.length = 0;

        // Editor onSubmit: /import (missing, valid, missing file error) & /editor
        surface.editor.onSubmit?.("/import");
        assert.equal(stdinSent.at(-1), "/import\n");
        surface.editor.onSubmit?.("/import snippet.md");
        assert.equal(surface.editor.getText(), "imported snippet");
        surface.editor.onSubmit?.("/import does-not-exist.md");

        detach?.();
        surface.stop();
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("{§cli-rendering} {§cli-sessions-topology} {§cli-repl-mode}: term-viewport-events projects history items, loop_replay, connection_lost, messages, notices, and non-surface viewport mode", async () => {
    assert.equal(
        extractUpdateText([{ type: "text", text: "run " }, { type: "skill", name: "lint" }]),
        "run $lint",
    );

    const term = new StubTerminal();
    const surface = new TermSurface(term);
    surface.start();
    const presenter = new SessionPresenter({ workspaceName: "ws1", sessionName: "s1", model: "none" });
    const replStdout = new PassThrough();
    const replStderr = new PassThrough();
    const replEvents = new PassThrough();
    const replReasoning = new PassThrough();
    const renderedTools: string[] = [];

    const state: TermViewportState = {
        options: {
            cwd: "/tmp",
            env: {},
            previewLines: 3,
            mermaidTimeoutMs: 1000,
        } as unknown as CliCommonOptions,
        replStdin: new PassThrough(),
        termOut: new PassThrough(),
        termErr: new PassThrough(),
        surface,
        review: null,
        attend: () => {},
        presenter,
        initialPromptPrinted: false,
        initialWorkspaceConsumed: false,
        boundProjectRoot: "/tmp",
        cachedModels: [],
        cachedEfforts: [],
        cachedPersonas: [],
        cachedSessions: [],
        cachedWorkspaces: [],
        cachedSkills: [],
        cachedAvailableCommands: [],
        currentPersona: null,
        currentMode: null,
        providerModelsFetcher: null,
        modelSearchFetcher: null,
        modelEffortsFetcher: null,
        cachedFamilyAliases: new Map(),
        currentTurns: 0,
        cancelArmed: false,
        focusedGateIds: [],
        suppressedStdoutQueue: [],
        localSubmittedPrompts: [],
        updateSurfaceStatus: () => {},
        ensureSurfaceStarted: () => {
            state.initialPromptPrinted = true;
        },
        retireLiveReasoning: () => {},
        renderToolCallToSurface: (f) => {
            renderedTools.push(f.toolCallId);
        },
    };

    renderHistoryItemsToSurface(
        state,
        [
            {
                kind: "user_message",
                text: "worker report",
                meta: { plurnk: { source: "session://helper" } },
            },
            {
                kind: "user_message",
                text: "operator prompt",
                meta: {},
            },
            {
                kind: "tool_call",
                toolCallId: "1/1/1",
                name: "read",
                title: "read (README.md)",
                status: "completed",
            },
            {
                kind: "agent_message",
                text: "Historical answer",
                meta: { plurnk: { op: "done", status: 200, loopSeq: 2, turnSeq: 3 } },
            },
        ],
        true,
    );
    assert.deepEqual(renderedTools, ["1/1/1"]);
    assert.equal(presenter.loopSeq, 2);
    assert.equal(presenter.turns, 3);

    attachViewportOutputListeners(
        state,
        { replStdout, replStderr, replEvents, replReasoning },
        { handleChunk: () => {} },
    );

    replStdout.write("workspace: ws1\n");
    replStdout.write("yolo: on\n");
    assert.equal(presenter.yolo, true);

    replStderr.write(
        `${JSON.stringify({
            type: "https://problems.plurnk.xyz/client/prompt-failed",
            title: "Prompt failed",
            detail: "Rate limited",
        })}\nplain stderr line\n`,
    );
    assert.equal(presenter.lifecycle, "failed");

    const emitEvent = (payload: Record<string, unknown>) => {
        replEvents.write(`${JSON.stringify(payload)}\n`);
    };
    emitEvent({ sessionUpdate: "composer_updated", text: "staged from event" });
    assert.equal(surface.editor.getText(), "staged from event");

    emitEvent({
        sessionUpdate: "loop_replay",
        loopSeq: 4,
        history: [{ kind: "agent_message", text: "Loop 4 answer" }],
    });
    assert.equal(presenter.loopSeq, 4);

    emitEvent({ sessionUpdate: "connection_lost" });
    assert.equal(presenter.disconnected, true);

    emitEvent({
        sessionUpdate: "session_message",
        messageId: "sm1",
        senderSessionId: "worker1",
        recipientSessionId: "s1",
        content: [{ type: "text", text: "ping" }],
    });
    emitEvent({
        sessionUpdate: "notice",
        severity: "warning",
        title: "warn",
        description: "watch out",
    });
    emitEvent({
        sessionUpdate: "user_message_chunk",
        messageId: "um-worker",
        content: { type: "text", text: "done work" },
        _meta: { plurnk: { source: "session://worker1", op: "send" } },
    });
    surface.stop();

    // Non-surface (plain stream) runTermViewport end-to-end
    const tmpDir = mkdtempSync(join(tmpdir(), "plurnk-vp-plain-"));
    const agentApp = createAcpAgent({ name: "mock-vp-plain" })
        .onRequest(methods.agent.initialize, async () => ({
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "mock", version: "1.0.0" },
            capabilities: {},
        }))
        .onRequest(methods.agent.session.new, async () => ({
            sessionId: "ws1#session1",
            configOptions: [],
            _meta: { plurnk: { workspace: { name: "ws1", projectRoot: tmpDir }, sessionName: "session1" } },
        }))
        .onRequest(methods.agent.session.resume, async ({ client, params }) => {
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: { sessionUpdate: "replay_complete" },
            });
            return { configOptions: [] };
        })
        .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_thought_chunk",
                    messageId: "t1",
                    content: { type: "text", text: "plain thought\n" },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: "1/1/1",
                    name: "edit",
                    title: "edit (a.ts)",
                    status: "completed",
                    rawInput: { body: "line1" },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: "m1",
                    content: { type: "text", text: "Plain reply" },
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
            return { messageId: "m1" };
        })
        .onRequest(
            "_plurnk/action",
            (raw) => raw as { kind: string },
            async () => ({}),
        );

    const acpServer = new AcpServer({ agent: agentApp });
    const handler = createNodeHttpHandler(acpServer);
    const httpServer = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    const port = (httpServer.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${String(port)}/acp`;

    try {
        const plainIn = new PassThrough();
        const plainOut = new PassThrough();
        const plainErr = new PassThrough();
        let plainText = "";
        plainOut.on("data", (c) => (plainText += String(c)));

        const vpPromise = runTermViewport(
            {
                url,
                explicitAcpUrl: true,
                host: "127.0.0.1",
                port,
                credential: new Credential({ HOME: tmpDir, XDG_STATE_HOME: tmpDir }),
                env: { HOME: tmpDir, XDG_STATE_HOME: tmpDir },
                cwd: tmpDir,
                workspace: "ws1",
                sessionId: "session1",
                termSession: "session1",
                autostart: false,
                daemonTimeoutMs: 2000,
                oauthTimeoutMs: 2000,
                cancelGraceMs: 200,
                yolo: false,
                auto: false,
                bell: false,
                json: false,
                previewLines: 3,
                historyEntries: 5,
                mermaidTimeoutMs: 1000,
                color: "never",
            },
            { stdin: plainIn, stdout: plainOut, stderr: plainErr },
        );

        plainIn.write("hello plain\n");
        await new Promise((r) => setTimeout(r, 80));
        plainIn.end("/quit\n");

        assert.equal(await vpPromise, 0);
        assert.match(plainText, /\[\/~\/ws1#session1\]/u);
        assert.match(plainText, /Plain reply/u);
    } finally {
        await new Promise<void>((r) => httpServer.close(() => r()));
        rmSync(tmpDir, { recursive: true, force: true });
    }
});
