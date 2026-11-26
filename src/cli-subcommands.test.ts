// Unit coverage for CLI subcommands, dispatcher entrypoint, option assembly, render filter,
// and runtime floor ({§cli-invocation}, {§cli-subcommands}, {§cli-configuration-source}, {§cli-markdown-projection}).

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
    type SessionConfigOption,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { CliCommonOptions } from "./cli-connection.ts";
import {
    assembleCliCommonOptions,
    collectSessionEnv,
    detectInitialJsonMode,
    main,
    parseSwitchValue,
} from "./dispatcher.ts";
import {
    formatConfigOption,
    formatServiceUpdateResult,
    runCliCompletion,
    runCliConfig,
    runCliDaemon,
    runCliDeleteSession,
    runCliFamily,
    runCliForkSession,
    runCliListSessions,
    runCliLogin,
    runCliLogout,
    runCliLogRead,
    runCliModels,
    runCliNewSession,
    runCliReadCoord,
    runCliResumeSession,
    runCliScript,
    runCliUpdate,
    runCliWorkspace,
} from "./cli-subcommands.ts";
import Credential from "./credential.ts";
import * as publicIndex from "./index.ts";
import { runRender } from "./render-filter.ts";
import { NODE_MAJOR_FLOOR, refuseBelowFloor } from "./runtime-floor.ts";

const captureProcessOutput = async <T>(fn: () => Promise<T> | T): Promise<{
    result: T;
    stdout: string;
    stderr: string;
    exitCode: number | string | null | undefined;
}> => {
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    const prevExit = process.exitCode ?? 0;
    let stdout = "";
    let stderr = "";
    process.exitCode = 0;
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
        if (typeof chunk === "string") {
            stdout += chunk;
            return true;
        }
        return (origOut as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
        if (typeof chunk === "string") {
            stderr += chunk;
            return true;
        }
        return (origErr as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    try {
        const result = await fn();
        return { result, stdout, stderr, exitCode: process.exitCode };
    } finally {
        process.stdout.write = origOut;
        process.stderr.write = origErr;
        process.exitCode = prevExit;
    }
};

test("{§cli-invocation}: refuseBelowFloor accepts matching Node floor and exits 1 with stderr diagnostic below floor", () => {
    assert.equal(typeof publicIndex.AcpClient, "function");
    assert.equal(typeof publicIndex.main, "function");
    refuseBelowFloor("plurnk", `${String(NODE_MAJOR_FLOOR)}.2.0`);

    let exitedWith: number | string | null | undefined = null;
    const origExit = process.exit.bind(process);
    const origErr = process.stderr.write.bind(process.stderr);
    let errText = "";
    process.stderr.write = ((chunk: unknown) => {
        errText += String(chunk);
        return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: number | string | null) => {
        exitedWith = code;
        throw new Error("EXIT_INTERCEPTED");
    }) as typeof process.exit;
    try {
        assert.throws(() => refuseBelowFloor("plurnk", "22.1.0"), /EXIT_INTERCEPTED/u);
        assert.equal(exitedWith, 1);
        assert.match(errText, /plurnk: requires Node\.js >= 26 \(found 22\.1\.0\)/u);
    } finally {
        process.exit = origExit;
        process.stderr.write = origErr;
    }
});

test("{§cli-markdown-projection}: runRender reads Markdown from stdin and writes plain Unicode projection to stdout", async () => {
    const fakeStdin = new PassThrough();
    const origStdin = Object.getOwnPropertyDescriptor(process, "stdin");
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
    try {
        fakeStdin.end("# Heading\n\n- item one\n- item two\n");
        const { result, stdout } = await captureProcessOutput(() => runRender(60));
        assert.equal(result, 0);
        assert.match(stdout, /Heading/u);
        assert.match(stdout, /item one/u);
    } finally {
        if (origStdin) Object.defineProperty(process, "stdin", origStdin);
    }
});

test("{§cli-invocation} {§cli-color-policy}: cli-options helpers validate switches, JSON detection, session env, and conflicting flags", () => {
    assert.equal(parseSwitchValue("PLURNK_CLIENT_YOLO", undefined, false), false);
    assert.equal(parseSwitchValue("PLURNK_CLIENT_YOLO", "1"), true);
    assert.equal(parseSwitchValue("PLURNK_CLIENT_YOLO", "0"), false);
    assert.throws(() => parseSwitchValue("PLURNK_CLIENT_YOLO", "maybe"), /expects 0 or 1/u);

    assert.equal(detectInitialJsonMode(["--json"], undefined), true);
    assert.equal(detectInitialJsonMode(["--json", "--no-json"], "1"), false);
    assert.equal(detectInitialJsonMode(["--", "--json"], "0"), false);
    assert.equal(detectInitialJsonMode([], "1"), true);

    const collected = collectSessionEnv(
        {
            PLURNK_CLIENT_ENV_FOO: "bar",
            PLURNK_CLIENT_ENV_INHERIT: "APP_*",
            APP_TOKEN: "t1",
            APP_SECRET: "s1",
            EXTRA_KEY: "ek",
        },
        ["EXTRA_KEY", "INLINE=val"],
        "APP_*",
        "APP_SECRET",
    );
    assert.deepEqual(collected, {
        FOO: "bar",
        APP_TOKEN: "t1",
        EXTRA_KEY: "ek",
        INLINE: "val",
    });

    const tmpDir = mkdtempSync(join(tmpdir(), "plurnk-opts-test-"));
    try {
        const promptFile = join(tmpDir, "role.md");
        writeFileSync(promptFile, "Be concise.", "utf8");
        const assembled = assembleCliCommonOptions(
            {
                "system-prompt": `@role.md`,
                "files-items": "10",
                "max-commands": "5",
                "no-git": true,
                "max-turns": "12",
                "timeout-ms": "5000",
                "debug-no-meta": true,
                color: "never",
            },
            { HOME: tmpDir, XDG_CONFIG_HOME: join(tmpDir, "cfg") },
            tmpDir,
        );
        assert.equal(assembled.systemPrompt, "Be concise.");
        assert.deepEqual(assembled.workspaceConfig, {
            PLURNK_SERVICE_FILES_ITEMS: "10",
            PLURNK_SERVICE_MAX_COMMANDS: "5",
            PLURNK_SERVICE_GIT_ALLOWED: "0",
        });
        assert.equal(assembled.maxTurns, 12);
        assert.equal(assembled.timeoutMs, 5000);
        assert.equal(assembled.debugNoMeta, true);
        assert.equal(assembled.color, "never");

        assert.throws(
            () => assembleCliCommonOptions({ persona: "reviewer", "system-prompt": "hi" }, { HOME: tmpDir }, tmpDir),
            /cannot be used together/u,
        );
        assert.throws(
            () => assembleCliCommonOptions({ "system-prompt": "@missing.md" }, { HOME: tmpDir }, tmpDir),
            /Failed to read --system-prompt file/u,
        );
        assert.throws(
            () => assembleCliCommonOptions({ color: "rainbow" }, { HOME: tmpDir }, tmpDir),
            /must be "always", "auto", or "never"/u,
        );
        assert.throws(
            () => assembleCliCommonOptions({ "mermaid-timeout-ms": "0" }, { HOME: tmpDir }, tmpDir),
            /must be a positive integer/u,
        );
        assert.throws(
            () => assembleCliCommonOptions({ "env-file": [join(tmpDir, "nope.env")] }, { HOME: tmpDir }, tmpDir),
            /Environment file not found/u,
        );
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("{§cli-subcommands} {§cli-configuration-source} {§cli-interactive-command-discovery}: standalone CLI subcommands and main() dispatcher round-trip over ACPv2", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plurnk-subcmd-test-"));
    const configOptionsState: SessionConfigOption[] = [
        {
            configId: "model",
            name: "Model",
            type: "select",
            currentValue: "fast",
            options: [
                { value: "fast", name: "Fast", description: null },
                { value: "pro", name: "Pro", description: null },
            ],
        },
        {
            configId: "thought_level",
            name: "Effort",
            type: "select",
            currentValue: "medium",
            options: [
                {
                    groupId: "levels",
                    name: "Levels",
                    options: [
                        { value: "low", name: "Low", description: null },
                        { value: "medium", name: "Medium", description: null },
                        { value: "high", name: "High", description: null },
                    ],
                },
            ],
        },
        {
            configId: "persona",
            name: "Persona",
            type: "select",
            currentValue: "none",
            options: [
                { value: "none", name: "None", description: null },
                { value: "architect", name: "Architect", description: null },
            ],
        },
        {
            configId: "verbose",
            name: "Verbose",
            type: "boolean",
            currentValue: false,
        },
    ];

    const deletedIds: string[] = [];
    let logoutCalled = false;

    const agentApp = createAcpAgent({ name: "mock-subcommands" })
        .onRequest(methods.agent.initialize, async () => ({
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "mock", version: "1.0.0" },
            capabilities: { session: { fork: {}, delete: {} } },
        }))
        .onRequest(methods.agent.session.list, async () => ({
            sessions: [
                { sessionId: "1#session1", cwd: tmpDir, title: "Main", updatedAt: "2026-01-01T00:00:00Z" },
            ],
        }))
        .onRequest(methods.agent.session.new, async () => ({
            sessionId: "1#session1",
            configOptions: configOptionsState,
        }))
        .onRequest(methods.agent.session.resume, async ({ params, client }) => {
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "user_message_chunk",
                    messageId: "u1",
                    content: { type: "text", text: "Hello" },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_thought_chunk",
                    messageId: "t1",
                    content: { type: "text", text: "Thinking..." },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: "1/1/1",
                    title: "read (a.ts)",
                    status: "completed",
                    content: [
                        { type: "content", content: { type: "text", text: "line 1" } },
                        {
                            type: "diff",
                            changes: [{ operation: "modify", path: "/repo/a.ts" }],
                            patch: { format: "git_patch", text: "@@ -1 +1 @@" },
                        },
                        { type: "session", sessionId: "1#worker" },
                    ],
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "terminal_update",
                    terminalId: "term-1",
                    command: "echo ok",
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "terminal_output_chunk",
                    terminalId: "term-1",
                    data: Buffer.from("ok\n", "utf8").toString("base64"),
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "notice",
                    severity: "info",
                    title: "note",
                    description: "resumed",
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: "m1",
                    content: { type: "text", text: "Done!" },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "replay_complete",
                },
            });
            return { configOptions: configOptionsState };
        })
        .onRequest(methods.agent.session.fork, async () => ({
            sessionId: "1#forked1",
            configOptions: configOptionsState,
        }))
        .onRequest(methods.agent.session.delete, async ({ params }) => {
            deletedIds.push(params.sessionId);
            return {};
        })
        .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
            const idx = configOptionsState.findIndex((o) => o.configId === params.configId);
            if (idx >= 0) {
                const prev = configOptionsState[idx]!;
                configOptionsState[idx] = {
                    ...prev,
                    currentValue: params.value,
                } as SessionConfigOption;
            }
            return { configOptions: configOptionsState };
        })
        .onRequest(methods.agent.auth.logout, async () => {
            logoutCalled = true;
            return {};
        })
        .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: "m-prompt",
                    content: { type: "text", text: "Answered!" },
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
            return { messageId: "m-prompt" };
        })
        .onRequest(
            "_plurnk/action",
            (raw) => raw as { kind: string; params?: Record<string, unknown> },
            async ({ params: req }) => {
            switch (req.kind) {
                case "service.update":
                    return {
                        catalog: { status: "updated", models: 42, providers: 5, addedModels: 3 },
                        service: { package: "@plurnk/plurnk-service", version: "8.0.0", artifact: "source" },
                    };
                case "models.list":
                    return {
                        total: 1,
                        offset: 0,
                        items: [
                            {
                                selector: "openai/gpt-5",
                                modelName: "GPT-5",
                                limits: { contextTokens: 200_000 },
                                capabilities: { reasoning: true, efforts: ["low", "high"] },
                                readiness: { ready: true },
                            },
                        ],
                    };
                case "workspace.list":
                    return {
                        workspaces: [{ id: 1, name: "ws1", projectRoot: tmpDir, createdAt: "2026-01-01" }],
                    };
                case "workspace.sessions":
                    return {
                        sessions: [{ id: 1, name: "session1", lifecycle: "idle" }],
                    };
                case "workspace.rename":
                    return { id: 1, name: String(req.params?.name ?? "ws2") };
                case "log.read":
                    return {
                        entries: [{ loopSeq: 1, turnSeq: 1, sequence: 1, op: "read", status: 200 }],
                    };
                case "entry.read":
                    return {
                        status: 200,
                        entry: { channels: { body: { content: "entry body text" } } },
                    };
                case "op.exec":
                    return {
                        results: [{ status: 200, content: "script-ok" }],
                    };
                case "session.env.list":
                    return {
                        definitions: [{ alias: "API_URL", state: "active", definition: { value: "http://x" } }],
                    };
                default:
                    return {};
            }
        },
        );

    const acpServer = new AcpServer({ agent: agentApp });
    const handler = createNodeHttpHandler(acpServer);
    const httpServer = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    const port = (httpServer.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${String(port)}/acp`;

    const fakeServiceBin = join(tmpDir, "fake-service.mjs");
    writeFileSync(
        fakeServiceBin,
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(tmpDir, "daemon-args.json"))}, JSON.stringify(process.argv.slice(2)));
process.exit(0);\n`,
        "utf8",
    );
    const plkFile = join(tmpDir, "run.plk");
    writeFileSync(plkFile, 'plurnk.sh({"command":"echo hi"})\n', "utf8");

    const baseOpts: CliCommonOptions = {
        url,
        explicitAcpUrl: true,
        host: "127.0.0.1",
        port,
        credential: new Credential({ HOME: tmpDir, XDG_STATE_HOME: tmpDir }),
        env: { HOME: tmpDir, XDG_STATE_HOME: tmpDir, PLURNK_ACP_URL: url },
        cwd: tmpDir,
        workspace: "ws1",
        sessionId: "session1",
        termSession: "session1",
        autostart: false,
        daemonTimeoutMs: 2000,
        oauthTimeoutMs: 2000,
        cancelGraceMs: 500,
        serviceBin: fakeServiceBin,
        yolo: false,
        auto: false,
        bell: false,
        json: false,
        previewLines: 4,
        historyEntries: 20,
        mermaidTimeoutMs: 1000,
        color: "never",
    };

    const prevAcpUrl = process.env.PLURNK_ACP_URL;
    process.env.PLURNK_ACP_URL = url;

    try {
        // formatConfigOption & formatServiceUpdateResult
        assert.match(formatConfigOption(configOptionsState[0]!), /model \(Model\): fast \[\*fast, pro\]/u);
        assert.match(formatConfigOption(configOptionsState[1]!), /thought_level \(Effort\): medium/u);
        assert.match(formatConfigOption(configOptionsState[3]!), /verbose \(Verbose\): false/u);
        assert.match(
            formatServiceUpdateResult({
                catalog: { status: "updated", models: 10, providers: 2, addedModels: 1 },
                service: { package: "@plurnk/plurnk-service", version: "8.0.0", artifact: "source" },
            }),
            /\+1 new[\s\S]*\(source checkout\)/u,
        );

        // Session CRUD subcommands (text + JSON)
        const listOut = await captureProcessOutput(() => runCliListSessions(baseOpts));
        assert.equal(listOut.result, 0);
        assert.match(listOut.stdout, /1#session1\t/u);
        const listJson = await captureProcessOutput(() => runCliListSessions({ ...baseOpts, json: true }));
        assert.equal(JSON.parse(listJson.stdout).sessions.length, 1);

        const newOut = await captureProcessOutput(() => runCliNewSession(baseOpts));
        assert.equal(newOut.stdout.trim(), "1#session1");
        const newJson = await captureProcessOutput(() => runCliNewSession({ ...baseOpts, json: true }));
        assert.equal(JSON.parse(newJson.stdout).sessionId, "1#session1");

        const resumeOut = await captureProcessOutput(() => runCliResumeSession("1#session1", baseOpts));
        assert.match(resumeOut.stdout, /> Hello/u);
        assert.match(resumeOut.stdout, /\[thought\] Thinking/u);
        assert.match(resumeOut.stdout, /\[tool:completed\] read \(a\.ts\)/u);
        assert.match(resumeOut.stdout, /\[diff\]/u);
        assert.match(resumeOut.stdout, /\[session\] 1#worker/u);
        assert.match(resumeOut.stdout, /\[terminal\] echo ok/u);
        assert.match(resumeOut.stdout, /\[info\] note: resumed/u);
        assert.match(resumeOut.stdout, /Done!/u);
        const resumeJson = await captureProcessOutput(() =>
            runCliResumeSession("1#session1", { ...baseOpts, json: true }),
        );
        assert.equal(JSON.parse(resumeJson.stdout).sessionId, "1#session1");

        const forkOut = await captureProcessOutput(() => runCliForkSession("1#session1", baseOpts));
        assert.equal(forkOut.stdout.trim(), "1#forked1");
        const delOut = await captureProcessOutput(() => runCliDeleteSession("1#forked1", baseOpts));
        assert.match(delOut.stdout, /Deleted 1#forked1/u);
        assert.deepEqual(deletedIds, ["1#forked1"]);

        // Config subcommands (get, set select, set boolean, invalid id)
        const cfgAll = await captureProcessOutput(() => runCliConfig(undefined, undefined, baseOpts));
        assert.match(cfgAll.stdout, /model \(Model\)/u);
        const cfgSet = await captureProcessOutput(() => runCliConfig("verbose", "true", baseOpts));
        assert.match(cfgSet.stdout, /verbose \(Verbose\): true/u);
        const cfgJson = await captureProcessOutput(() =>
            runCliConfig("model", "pro", { ...baseOpts, json: true }),
        );
        assert.equal(JSON.parse(cfgJson.stdout).configOptions[0].currentValue, "pro");
        await assert.rejects(
            () => runCliConfig("show", undefined, baseOpts),
            /plurnk daemon config show/u,
        );

        // Update, Models, Workspace, Log, ReadCoord, Script, Completion, Family
        const updOut = await captureProcessOutput(() => runCliUpdate(baseOpts));
        assert.match(updOut.stdout, /catalog: updated/u);
        const modelsOut = await captureProcessOutput(() =>
            runCliModels(["gpt"], { provider: "openai", all: true, offset: 0, limit: 10 }, baseOpts),
        );
        assert.match(modelsOut.stdout, /openai\/gpt-5/u);

        const wsList = await captureProcessOutput(() => runCliWorkspace("list", undefined, undefined, baseOpts));
        assert.match(wsList.stdout, /ws1/u);
        const wsSess = await captureProcessOutput(() => runCliWorkspace("sessions", "ws1", undefined, baseOpts));
        assert.match(wsSess.stdout, /session1\tidle/u);
        const wsRenMissing = await captureProcessOutput(() => runCliWorkspace("rename", "ws1", undefined, baseOpts));
        assert.equal(wsRenMissing.result, 64);
        const wsRen = await captureProcessOutput(() => runCliWorkspace("rename", "ws1", "ws2", baseOpts));
        assert.equal(wsRen.stdout.trim(), "ws2");
        const wsBad = await captureProcessOutput(() => runCliWorkspace("bogus", undefined, undefined, baseOpts));
        assert.equal(wsBad.result, 64);

        const logOut = await captureProcessOutput(() =>
            runCliLogRead({ loopId: 1, turnId: 1, sinceId: 0, limit: 10 }, baseOpts),
        );
        assert.match(logOut.stdout, /1\/1\/1\tread\t200/u);

        const coordOut = await captureProcessOutput(() => runCliReadCoord("1/1/1", baseOpts));
        assert.equal(coordOut.stdout.trim(), "entry body text");

        const scriptOut = await captureProcessOutput(() => runCliScript("run.plk", baseOpts));
        assert.equal(scriptOut.result, 0);
        assert.equal(scriptOut.stdout.trim(), "script-ok");

        const compBash = await captureProcessOutput(() => runCliCompletion("bash"));
        assert.equal(compBash.result, 0);
        assert.ok(compBash.stdout.length > 50);
        const compBad = await captureProcessOutput(() => runCliCompletion("tcsh"));
        assert.equal(compBad.result, 64);

        const famHelp = await captureProcessOutput(() => runCliFamily("mcp", ["--help"], baseOpts));
        assert.equal(famHelp.result, 0);
        assert.match(famHelp.stdout, /usage: plurnk mcp/u);
        const schedHelp = await captureProcessOutput(() => runCliFamily("schedule", ["-h"], baseOpts));
        assert.equal(schedHelp.result, 0);
        assert.match(schedHelp.stdout, /usage: plurnk schedule/u);
        const famList = await captureProcessOutput(() => runCliFamily("env", ["list"], baseOpts));
        assert.equal(famList.result, 0);
        assert.match(famList.stdout, /API_URL/u);

        // Login, Logout, Daemon restart/status
        const fakeCred = {
            login: async (_u: string, io: { write?: (m: string) => void }) => {
                io.write?.("Opening browser...\n");
                return {
                    issuer: "https://idp.example",
                    clientId: "cid",
                    accessToken: "tok",
                    expiresAt: 999999,
                };
            },
            logout: async () => ({ revoked: true, origin: "http://127.0.0.1" }),
            grantsPath: () => join(tmpDir, "grants.json"),
            headers: async () => ({}),
            invalidate: () => {},
        } as unknown as Credential;
        const loginOut = await captureProcessOutput(() =>
            runCliLogin({ ...baseOpts, credential: fakeCred }),
        );
        assert.match(loginOut.stdout, /authorized: https:\/\/idp\.example/u);
        const loginJson = await captureProcessOutput(() =>
            runCliLogin({ ...baseOpts, json: true, credential: fakeCred }),
        );
        assert.equal(JSON.parse(loginJson.stdout).status, "authorized");

        const logoutOut = await captureProcessOutput(() =>
            runCliLogout({ ...baseOpts, credential: fakeCred }),
        );
        assert.equal(logoutCalled, true);
        assert.match(logoutOut.stdout, /logged out:/u);

        const daemonStatus = await captureProcessOutput(() => runCliDaemon(["status"], baseOpts));
        assert.equal(daemonStatus.result, 0);
        const daemonRestart = await captureProcessOutput(() => runCliDaemon(["restart"], baseOpts));
        assert.equal(daemonRestart.result, 0);
        assert.match(daemonRestart.stdout, /daemon: restarted/u);
        await assert.rejects(() => runCliDaemon(["restart", "extra"], baseOpts), /usage: plurnk daemon restart/u);

        // main() end-to-end branches
        const helpMain = await captureProcessOutput(() => main(["node", "plurnk", "--help"]));
        assert.match(helpMain.stdout, /usage: plurnk/u);
        const renderHelpMain = await captureProcessOutput(() => main(["node", "plurnk", "render", "--help"]));
        assert.match(renderHelpMain.stdout, /usage: plurnk render/u);
        const verMain = await captureProcessOutput(() => main(["node", "plurnk", "--version"]));
        assert.ok(verMain.stdout.trim().length > 0);
        const compMain = await captureProcessOutput(() => main(["node", "plurnk", "completion", "zsh"]));
        assert.equal(compMain.exitCode, 0);
        assert.ok(compMain.stdout.length > 50);

        const badFlagJson = await captureProcessOutput(() =>
            main(["node", "plurnk", "--json", "--unknown-flag-xyz"]),
        );
        assert.equal(badFlagJson.exitCode, 64);
        assert.equal(JSON.parse(badFlagJson.stdout).schemaVersion, 6);

        const replJsonConflict = await captureProcessOutput(() =>
            main(["node", "plurnk", "--repl", "--json"]),
        );
        assert.equal(replJsonConflict.exitCode, 64);

        const subDispatch = await captureProcessOutput(() =>
            main(["node", "plurnk", "--workspace", "ws1", "models", "gpt", "--limit", "5"]),
        );
        assert.equal(subDispatch.exitCode, 0);
        assert.match(subDispatch.stdout, /openai\/gpt-5/u);

        const effortMain = await captureProcessOutput(() =>
            main(["node", "plurnk", "--workspace", "ws1", "effort", "high"]),
        );
        assert.equal(effortMain.exitCode, 0);
        assert.match(effortMain.stdout, /thought_level/u);

        const personaMain = await captureProcessOutput(() =>
            main(["node", "plurnk", "--workspace", "ws1", "persona", "architect"]),
        );
        assert.equal(personaMain.exitCode, 0);
        assert.match(personaMain.stdout, /persona/u);

        const sessionSubMain = await captureProcessOutput(() =>
            main(["node", "plurnk", "session", "list"]),
        );
        assert.equal(sessionSubMain.exitCode, 0);
        assert.match(sessionSubMain.stdout, /1#session1/u);

        assert.equal((await captureProcessOutput(() => main(["node", "plurnk", "session", "new"]))).exitCode, 0);
        assert.equal(
            (await captureProcessOutput(() => main(["node", "plurnk", "session", "resume", "1#session1"]))).exitCode,
            0,
        );
        assert.equal(
            (await captureProcessOutput(() => main(["node", "plurnk", "session", "fork", "1#session1"]))).exitCode,
            0,
        );
        assert.equal(
            (await captureProcessOutput(() => main(["node", "plurnk", "session", "delete", "1#session1"]))).exitCode,
            0,
        );
        assert.equal(
            (await captureProcessOutput(() => main(["node", "plurnk", "session", "bogus"]))).exitCode,
            64,
        );
        assert.equal(
            (await captureProcessOutput(() => main(["node", "plurnk", "render", "extra"]))).exitCode,
            64,
        );
        assert.equal(
            (await captureProcessOutput(() => main(["node", "plurnk", "render", "--width", "0"]))).exitCode,
            64,
        );
        assert.equal(
            (await captureProcessOutput(() => main(["node", "plurnk", "env", "list"]))).exitCode,
            0,
        );
        assert.equal(
            (await captureProcessOutput(() => main(["node", "plurnk", "config"]))).exitCode,
            0,
        );
        assert.equal(
            (await captureProcessOutput(() => main(["node", "plurnk", "update"]))).exitCode,
            0,
        );
        assert.equal(
            (await captureProcessOutput(() => main(["node", "plurnk", "workspace", "list"]))).exitCode,
            0,
        );
        assert.equal(
            (await captureProcessOutput(() => main(["node", "plurnk", "log", "read", "--loop", "1"]))).exitCode,
            0,
        );
        assert.equal(
            (await captureProcessOutput(() => main(["node", "plurnk", "read", "1/1/1"]))).exitCode,
            0,
        );
        assert.equal(
            (await captureProcessOutput(() => main(["node", "plurnk", "script", plkFile]))).exitCode,
            0,
        );
        assert.equal(
            (await captureProcessOutput(() => main(["node", "plurnk", "logout"]))).exitCode,
            0,
        );

        const origStdin = Object.getOwnPropertyDescriptor(process, "stdin");
        try {
            const pipedIn = new PassThrough();
            Object.defineProperty(process, "stdin", { value: pipedIn, configurable: true });
            pipedIn.end("extra stdin context\n");
            const promptMain = await captureProcessOutput(() =>
                main(["node", "plurnk", "--workspace", "ws1", "Say hello"]),
            );
            assert.equal(promptMain.exitCode, 0);
            assert.equal(promptMain.stdout.trim(), "Answered!");

            const emptyIn = new PassThrough();
            Object.defineProperty(process, "stdin", { value: emptyIn, configurable: true });
            emptyIn.end("");
            const missingPromptMain = await captureProcessOutput(() =>
                main(["node", "plurnk", "--json"]),
            );
            assert.equal(missingPromptMain.exitCode, 64);
        } finally {
            if (origStdin) Object.defineProperty(process, "stdin", origStdin);
        }
    } finally {
        if (prevAcpUrl === undefined) delete process.env.PLURNK_ACP_URL;
        else process.env.PLURNK_ACP_URL = prevAcpUrl;
        await acpServer.close();
        httpServer.closeAllConnections();
        await new Promise<void>((r) => httpServer.close(() => r()));
        rmSync(tmpDir, { recursive: true, force: true });
    }
});
