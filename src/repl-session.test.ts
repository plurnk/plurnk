// Unit coverage for the 5-stream REPL engine, input line accumulator, gate review commands,
// topology/loop slash commands, and catalog binding ({§cli-repl-mode}, {§cli-inline-review},
// {§cli-sessions-topology}, {§cli-configuration-source}, {§cli-output-channels}).

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
    type CreateElicitationResponse,
    type RequestPermissionResponse,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { AcpClient } from "./acp-client.ts";
import { AcpSession } from "./acp-session.ts";
import type { CliCommonOptions } from "./cli-connection.ts";
import Credential from "./credential.ts";
import {
    buildPromptBlocks,
    executeFamilyCommand,
    extractOpenPaths,
} from "./repl-commands.ts";
import {
    dispatchGateSlashCommand,
    type PendingGate,
} from "./repl-gate-commands.ts";
import { createReplLineAccumulator } from "./repl-input-reader.ts";
import {
    createReplCatalogFetchers,
    createReplElicitationHandler,
    createReplPermissionHandler,
    type ReplRuntimeState,
} from "./repl-session-binding.ts";
import { runReplSession } from "./repl-session.ts";

test("{§cli-repl-mode}: createReplLineAccumulator frames bracketed pastes, multiline MCP fences, continuations, and EOF flush", () => {
    const submissions: string[] = [];
    const acc = createReplLineAccumulator((s) => submissions.push(s));

    // Inline bracketed paste on a single line
    acc.feedLine("lead \x1b[200~pasted one\x1b[201~ tail");
    assert.deepEqual(submissions.splice(0), ["lead pasted one tail"]);

    // Multi-line bracketed paste
    acc.feedLine("\x1b[200~line A");
    acc.feedLine("line B");
    acc.feedLine("line C\x1b[201~");
    assert.deepEqual(submissions.splice(0), ["line A\nline B\nline C"]);

    // Backtick & tilde fenced MCP blocks
    acc.feedLine("```js");
    acc.feedLine("const x = 1;");
    acc.feedLine("```");
    acc.feedLine(": ~~~sh");
    acc.feedLine("echo hi");
    acc.feedLine("~~~");
    assert.deepEqual(submissions.splice(0), [
        "```js\nconst x = 1;\n```",
        ": ~~~sh\necho hi\n~~~",
    ]);

    // Backslash line continuation
    acc.feedLine("first part \\");
    acc.feedLine("second part \\");
    acc.feedLine("third part");
    assert.deepEqual(submissions.splice(0), ["first part \nsecond part \nthird part"]);

    // Unterminated paste / fence / continuation flushed at EOF
    acc.feedLine("\x1b[200~dangling paste");
    acc.flush();
    acc.feedLine("```sh");
    acc.feedLine("echo unterminated");
    acc.flush();
    acc.feedLine("dangling cont \\");
    acc.flush();
    assert.deepEqual(submissions.splice(0), [
        "dangling paste",
        "```sh\necho unterminated",
        "dangling cont ",
    ]);
});

test("{§cli-output-channels} {§cli-configuration-source}: extractOpenPaths, buildPromptBlocks, and executeFamilyCommand handle edge cases", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plurnk-repl-cmd-"));
    try {
        writeFileSync(join(tmpDir, "notes.txt"), "hello", "utf8");
        writeFileSync(join(tmpDir, "sample.env"), "FOO=1\nBAR=two\n", "utf8");
        assert.deepEqual(extractOpenPaths("Check @notes.txt, @../outside.txt and @missing.txt!", tmpDir), [
            "notes.txt",
        ]);
        assert.deepEqual(extractOpenPaths("@notes.txt", undefined), []);

        const blocks = buildPromptBlocks("Use $review. Keep $HOME untouched.", [
            { type: "skill", name: "review", description: "Code review" },
        ]);
        assert.deepEqual(blocks, [
            { type: "text", text: "Use " },
            { type: "skill", name: "review" },
            { type: "text", text: ". Keep $HOME untouched." },
        ]);

        const stdoutChunks: string[] = [];
        const errors: Array<{ type: string; status: number; detail: string }> = [];
        const mockClient = {
            action: async (kind: string, params?: Record<string, unknown>) => {
                if (kind === "workspace.schedule.list") {
                    return {
                        definitions: [
                            {
                                alias: "nightly",
                                state: "active",
                                definition: { rule: "manual", target: "session://s1", prompt: "check" },
                            },
                        ],
                    };
                }
                if (kind === "session.env.replace") {
                    if (params?.alias === "BAR") throw new Error("BAR rejected");
                    return { ok: true };
                }
                if (kind === "workspace.mcp.oauth.complete") {
                    return { status: 202, alias: params?.alias };
                }
                return {};
            },
        } as unknown as AcpClient;

        const outStream = new PassThrough();
        outStream.on("data", (c) => stdoutChunks.push(String(c)));

        // schedule inspect found, json, and not-found
        await executeFamilyCommand(mockClient, "schedule", ["inspect", "nightly"], {}, tmpDir, {
            stdout: outStream,
            onError: (p) => errors.push(p),
        });
        assert.match(stdoutChunks.join(""), /alias:\s+nightly/u);
        stdoutChunks.length = 0;

        await executeFamilyCommand(mockClient, "schedule", ["show", "nightly"], {}, tmpDir, {
            json: true,
            stdout: outStream,
            onError: (p) => errors.push(p),
        });
        assert.equal(JSON.parse(stdoutChunks.join("")).alias, "nightly");
        stdoutChunks.length = 0;

        await executeFamilyCommand(mockClient, "schedule", ["inspect", "missing"], {}, tmpDir, {
            stdout: outStream,
            onError: (p) => errors.push(p),
        });
        assert.equal(errors.at(-1)?.status, 404);

        // mcp oauth invalid args & direct callback completion
        await executeFamilyCommand(mockClient, "mcp", ["oauth"], {}, tmpDir, {
            stdout: outStream,
            onError: (p) => errors.push(p),
        });
        assert.equal(errors.at(-1)?.status, 400);

        await executeFamilyCommand(
            mockClient,
            "mcp",
            ["oauth", "srv", "http://127.0.0.1:9999/cb?code=1"],
            {},
            tmpDir,
            { stdout: outStream, onError: (p) => errors.push(p) },
        );
        assert.match(stdoutChunks.join(""), /Sign-in accepted; tools awaiting activation/u);
        stdoutChunks.length = 0;

        // env import missing path & partial failure
        await executeFamilyCommand(mockClient, "env", ["import"], {}, tmpDir, {
            stdout: outStream,
            onError: (p) => errors.push(p),
        });
        assert.equal(errors.at(-1)?.status, 400);

        await executeFamilyCommand(mockClient, "env", ["import", "sample.env"], {}, tmpDir, {
            stdout: outStream,
            onError: (p) => errors.push(p),
        });
        assert.match(stdoutChunks.join(""), /imported 1 of 2 into this session only/u);
        stdoutChunks.length = 0;

        await executeFamilyCommand(mockClient, "env", ["--scope", "service", "import", "sample.env"], {}, tmpDir, {
            stdout: outStream,
            onError: (p) => errors.push(p),
        });
        assert.match(stdoutChunks.join(""), /imported 2 of 2 into service defaults/u);
        stdoutChunks.length = 0;

        await executeFamilyCommand(
            mockClient,
            "mcp",
            ["--scope", "service", "secrets", "set", "weatherTracker", "WEATHER_KEY=sk-nyc"],
            {},
            tmpDir,
            { stdout: outStream, onError: (p) => errors.push(p) },
        );
        assert.match(stdoutChunks.join(""), /weatherTracker\s+secrets:/u);
        stdoutChunks.length = 0;

        await executeFamilyCommand(
            mockClient,
            "mcp",
            ["secrets", "set", "weatherTracker"],
            {},
            tmpDir,
            { stdout: outStream, onError: (p) => errors.push(p) },
        );
        assert.equal(errors.at(-1)?.status, 400);
        assert.match(String(errors.at(-1)?.detail), /usage: \/mcp \[--scope workspace\|service\] secrets set/u);
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("{§cli-inline-review} {§cli-repl-mode}: dispatchGateSlashCommand and REPL permission/elicitation handlers cover all outcomes", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const events = new PassThrough();
    let outBuf = "";
    let errBuf = "";
    let evtBuf = "";
    stdout.on("data", (c) => (outBuf += String(c)));
    stderr.on("data", (c) => (errBuf += String(c)));
    events.on("data", (c) => (evtBuf += String(c)));

    const streams = {
        stdin: new PassThrough(),
        stdout,
        stderr,
        events,
        reasoning: new PassThrough(),
    };
    const pendingGates = new Map<string, PendingGate>();
    const session = new AcpSession("1#session1", {
        configOptions: [
            {
                configId: "mode",
                name: "Mode",
                type: "select",
                currentValue: "review",
                options: [
                    { value: "review", name: "Review", description: null },
                    { value: "accept", name: "Accept", description: null },
                ],
            },
        ],
    });
    let yolo = false;
    const mockClient = {
        setConfigOption: async (_sid: string, _cid: string, value: string) => ({
            configOptions: [
                {
                    configId: "mode",
                    name: "Mode",
                    type: "select",
                    currentValue: value,
                    options: [],
                },
            ],
        }),
    } as unknown as AcpClient;

    const gateCtx = {
        client: mockClient,
        streams,
        pendingGates,
        getSession: () => session,
        getYolo: () => yolo,
        setYolo: (v: boolean) => {
            yolo = v;
        },
        clearForceReviewNextRun: () => {},
    };

    // Empty /review, missing @id, unknown @id
    await dispatchGateSlashCommand("review", [], "/review", gateCtx);
    assert.match(outBuf, /review: none/u);
    await dispatchGateSlashCommand("approve", [], "/approve", gateCtx);
    assert.match(errBuf, /Missing gate identifier/u);
    await dispatchGateSlashCommand("approve", ["@deadbeef"], "/approve @deadbeef", gateCtx);
    assert.match(errBuf, /No pending gate with id @deadbeef/u);

    // Permission + Elicitation gate operations: /review, /edit, /answer, /reject, /cancel, /yolo
    let permResolved: RequestPermissionResponse | null = null;
    let elicitResolved: CreateElicitationResponse | null = null;
    const addGates = () => {
        pendingGates.set("aaaa1111", {
            kind: "permission",
            id: "aaaa1111",
            sessionId: "1#session1",
            request: {
                sessionId: "1#session1",
                subject: { type: "command", command: "edit a.ts", cwd: "/tmp" },
                title: "edit a.ts",
                options: [
                    { optionId: "allow", name: "Allow", kind: "allow_once" },
                    { optionId: "deny", name: "Deny", kind: "reject_once" },
                ],
            },
            resolveGate: (res) => {
                permResolved = res;
                pendingGates.delete("aaaa1111");
            },
        });
        pendingGates.set("bbbb2222", {
            kind: "elicitation",
            id: "bbbb2222",
            sessionId: "1#session1",
            request: {
                sessionId: "1#session1",
                mode: "form",
                message: "Pick target",
                requestedSchema: { type: "object", properties: {} },
            },
            resolveGate: (res) => {
                elicitResolved = res;
                pendingGates.delete("bbbb2222");
            },
        });
    };

    addGates();
    outBuf = "";
    await dispatchGateSlashCommand("review", [], "/review", gateCtx);
    assert.match(outBuf, /@aaaa1111\s+permission/u);
    assert.match(outBuf, /@bbbb2222\s+elicitation/u);

    // Wrong-kind refusals (/edit on elicitation, /answer on permission)
    errBuf = "";
    await dispatchGateSlashCommand("edit", ["@bbbb2222"], "/edit @bbbb2222 hi", gateCtx);
    assert.match(errBuf, /not a permission gate/u);
    await dispatchGateSlashCommand("answer", ["@aaaa1111"], "/answer @aaaa1111 {}", gateCtx);
    assert.match(errBuf, /not an elicitation gate/u);

    // /edit on permission & /answer JSON + plain text on elicitation
    await dispatchGateSlashCommand("edit", ["@aaaa1111", "patched"], "/edit @aaaa1111 patched content", gateCtx);
    assert.deepEqual((permResolved as unknown as { _meta?: unknown })?._meta, {
        plurnk: { body: "patched content" },
    });
    await dispatchGateSlashCommand("answer", ["@bbbb2222"], '/answer @bbbb2222 {"choice":"A"}', gateCtx);
    assert.deepEqual(elicitResolved, { action: "accept", content: { choice: "A" } });

    addGates();
    await dispatchGateSlashCommand("reject", ["@aaaa1111"], "/reject @aaaa1111", gateCtx);
    assert.deepEqual(permResolved, { outcome: { outcome: "selected", optionId: "deny" } });
    await dispatchGateSlashCommand("answer", ["@bbbb2222"], "/answer @bbbb2222 plain text", gateCtx);
    assert.deepEqual(elicitResolved, { action: "accept", content: { answer: "plain text" } });

    addGates();
    await dispatchGateSlashCommand("cancel", ["@aaaa1111"], "/cancel @aaaa1111", gateCtx);
    assert.deepEqual(permResolved, { outcome: { outcome: "cancelled" } });
    await dispatchGateSlashCommand("reject", ["@bbbb2222"], "/reject @bbbb2222", gateCtx);
    assert.deepEqual(elicitResolved, { action: "decline" });

    addGates();
    await dispatchGateSlashCommand("yolo", [], "/yolo", gateCtx);
    assert.equal(yolo, true);
    assert.deepEqual(permResolved, { outcome: { outcome: "selected", optionId: "allow" } });

    // Direct permission & elicitation handler edge cases (abort, auto, mcp-oauth bypass)
    const runtimeState: ReplRuntimeState = {
        options: { auto: false, env: {} } as unknown as CliCommonOptions,
        streams,
        currentWorkspace: "ws1",
        currentSessionName: "s1",
        currentProjectRoot: "/tmp",
        boundWorkspaceProjectRoot: "/tmp",
        currentYolo: false,
        forceReviewNextRun: false,
        gateSeq: 0,
        currentLifecycle: "running",
        stagedComposerText: "",
        activeSession: session,
        activeLocalMcpOAuth: 1,
        activeLocalOAuthControllers: new Set(),
        pendingGates,
    };
    const permHandler = createReplPermissionHandler(runtimeState);
    const elicitHandler = createReplElicitationHandler(runtimeState);

    const preAborted = new AbortController();
    preAborted.abort();
    assert.deepEqual(
        await permHandler(
            {
                sessionId: "1#s1",
                subject: { type: "command", command: "sh", cwd: "/tmp" },
                title: "sh",
                options: [],
            },
            preAborted.signal,
        ),
        { outcome: { outcome: "cancelled" } },
    );
    assert.deepEqual(
        await elicitHandler(
            { sessionId: "1#s1", mode: "form", message: "q", requestedSchema: { type: "object", properties: {} } },
            preAborted.signal,
        ),
        { action: "cancel" },
    );

    // Local MCP OAuth URL elicitation auto-accepts
    assert.deepEqual(
        await elicitHandler(
            { sessionId: "1#s1", mode: "url", elicitationId: "mcp-oauth:gitea", message: "Sign in", url: "http://x" },
            new AbortController().signal,
        ),
        { action: "accept" },
    );

    // Mid-wait abort settles elsewhere
    const livePermAbort = new AbortController();
    const pendingPermPromise = permHandler(
        {
            sessionId: "1#s1",
            subject: { type: "command", command: "sh", cwd: "/tmp" },
            title: "sh",
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
        livePermAbort.signal,
    );
    livePermAbort.abort();
    assert.deepEqual(await pendingPermPromise, { outcome: { outcome: "cancelled" } });
    assert.match(evtBuf, /settled_elsewhere/u);

    // Catalog fetchers caching & efforts lookup
    let providerFetcher: ((p: string) => Promise<readonly string[]>) | null = null;
    let searchFetcher: ((q: string) => Promise<readonly string[]>) | null = null;
    let effortsFetcher: ((s: string) => Promise<readonly string[] | null>) | null = null;
    const catHelpers = createReplCatalogFetchers(
        {
            action: async (_k: string, p?: Record<string, unknown>) => ({
                items: [
                    {
                        selector: p?.provider ? `${String(p.provider)}/m1` : "anthropic/claude-4",
                        capabilities: { efforts: ["low", "high"] },
                        readiness: { ready: true },
                    },
                ],
            }),
        } as unknown as AcpClient,
        {
            onProviderModelsFetcher: (f) => {
                providerFetcher = f;
            },
            onModelSearchFetcher: (f) => {
                searchFetcher = f;
            },
            onModelEffortsFetcher: (f) => {
                effortsFetcher = f;
            },
        },
    );
    catHelpers.aliasTargetByName.set("smart", "anthropic/claude-4");
    assert.deepEqual(await searchFetcher!("claude"), ["anthropic/claude-4"]);
    assert.deepEqual(await effortsFetcher!("smart"), ["low", "high"]);
    assert.deepEqual(await providerFetcher!("openai"), ["openai/m1"]);
    assert.deepEqual(await effortsFetcher!("openai/m1"), ["low", "high"]);
});

test("{§cli-repl-mode} {§cli-sessions-topology} {§cli-subcommands}: runReplSession executes slash topology, loops, compose, config, !shell, MCP expressions, and prompts", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plurnk-repl-intg-"));
    writeFileSync(join(tmpDir, "draft.md"), "Imported context", "utf8");
    writeFileSync(join(tmpDir, "ops.plk"), 'plurnk.sh({"command":"echo plk"})\n', "utf8");
    const fakeEditor = join(tmpDir, "editor.mjs");
    writeFileSync(
        fakeEditor,
        `import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "Edited prompt\\n");\n`,
        "utf8",
    );

    const execReceived: string[] = [];
    const promptsReceived: Array<{ text: string; meta: unknown }> = [];

    const agentApp = createAcpAgent({ name: "mock-repl" })
        .onRequest(methods.agent.initialize, async () => ({
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "mock-repl", version: "1.0.0" },
            capabilities: { session: { fork: {} } },
        }))
        .onRequest(methods.agent.session.new, async ({ params }) => {
            const plurnk = (params._meta as { plurnk?: { session?: string; workspace?: string } } | undefined)?.plurnk;
            const ws = plurnk?.workspace ?? "ws1";
            const sess = plurnk?.session ?? "session1";
            return {
                sessionId: `${ws}#${sess}`,
                availableCommands: [{ type: "command", name: "custom:deploy", description: "Deploy" }],
                configOptions: [
                    {
                        configId: "model",
                        name: "Model",
                        type: "select",
                        currentValue: "fast",
                        options: [{ value: "fast", name: "Fast", description: null }],
                    },
                    {
                        configId: "thought_level",
                        name: "Effort",
                        type: "select",
                        currentValue: "low",
                        options: [{ value: "low", name: "Low", description: null }],
                    },
                    {
                        configId: "child",
                        name: "Child",
                        type: "select",
                        currentValue: "fast",
                        options: [{ value: "fast", name: "Fast", description: null }],
                    },
                ],
                _meta: {
                    plurnk: {
                        workspace: { name: ws, projectRoot: tmpDir },
                        sessionName: sess,
                    },
                },
            };
        })
        .onRequest(methods.agent.session.resume, async ({ client, params }) => {
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: { sessionUpdate: "replay_complete" },
            });
            return { configOptions: [] };
        })
        .onRequest(methods.agent.session.fork, async ({ params }) => {
            const custom = (params._meta as { plurnk?: { sessionName?: string } } | undefined)?.plurnk?.sessionName;
            const name = custom ?? "fork1";
            return {
                sessionId: `ws1#${name}`,
                configOptions: [],
                _meta: { plurnk: { sessionName: name } },
            };
        })
        .onRequest(methods.agent.session.setConfigOption, async ({ params }) => ({
            configOptions: [
                {
                    configId: params.configId,
                    name: params.configId,
                    type: "select",
                    currentValue: String(params.value),
                    options: [{ value: String(params.value), name: String(params.value), description: null }],
                },
            ],
        }))
        .onNotification(methods.agent.session.cancel, async () => {})
        .onRequest(methods.agent.auth.logout, async () => ({}))
        .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
            const first = params.prompt[0];
            const text = first && "text" in first && typeof first.text === "string" ? first.text : "";
            promptsReceived.push({ text, meta: params._meta });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_thought_chunk",
                    messageId: "th1",
                    content: { type: "text", text: "pondering" },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: "1/1/1",
                    title: "read (a.ts)",
                    status: "completed",
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "notice",
                    severity: "info",
                    title: "status",
                    _meta: { plurnk: { notice: { kind: "loop_status", status: 102 } } },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "config_option_update",
                    configOptions: [
                        {
                            configId: "mode",
                            name: "Mode",
                            type: "select",
                            currentValue: "accept",
                            options: [],
                        },
                    ],
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "_plurnk_telemetry",
                    _meta: { plurnk: { notice: { kind: "turn_queued" } } },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "state_update",
                    state: "running",
                    _meta: { plurnk: { status: { lifecycle: "parked" } } },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: "m1",
                    content: { type: "text", text: `Echo: ${text}` },
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
            (raw) => raw as { kind: string; params?: Record<string, unknown> },
            async ({ params: req }) => {
            switch (req.kind) {
                case "workspace.sessions":
                    return {
                        sessions: [
                            { id: 1, name: "session1", parentSessionId: null, lifecycle: "idle" },
                            { id: 2, name: "childA", parentSessionId: 1, lifecycle: "running" },
                            { id: 3, name: "childB", parentSessionId: 1, lifecycle: "idle" },
                        ],
                    };
                case "workspace.list":
                    return {
                        workspaces: [{ id: 1, name: "ws1", projectRoot: tmpDir, createdAt: "2026-01-01" }],
                    };
                case "workspace.rename":
                    return { id: 1, name: String(req.params?.name ?? "ws2") };
                case "workspace.share":
                    return { folder: String(req.params?.folder ?? "") };
                case "session.rollback":
                    return { to: String(req.params?.to ?? ""), restored: [], skipped: [], stopped: null };
                case "service.update":
                    return { catalog: { status: "ok", models: 5, providers: 1 }, service: { version: "8.0.0" } };
                case "models.list":
                    return { total: 0, offset: 0, items: [] };
                case "session.loops":
                    return {
                        items: [
                            { sequence: 1, opening: "First loop", status: 200, lifecycle: "idle" },
                            { sequence: 2, opening: "Second loop", source: "session://worker", status: 499, lifecycle: "cancelled" },
                        ],
                        updates:
                            req.params?.loopSeq === 1
                                ? [
                                      {
                                          sessionUpdate: "agent_message_chunk",
                                          messageId: "l1",
                                          content: { type: "text", text: "Loop 1 reply" },
                                      },
                                  ]
                                : undefined,
                    };
                case "log.read":
                    return { entries: [{ loopSeq: 2, turnSeq: 1, sequence: 1, op: "done", status: 200 }] };
                case "op.exec":
                    execReceived.push(String(req.params?.text ?? ""));
                    return { results: [{ status: 200, content: `ran:${String(req.params?.text ?? "")}` }] };
                default:
                    return { definitions: [] };
            }
        },
        );

    const acpServer = new AcpServer({ agent: agentApp });
    const handler = createNodeHttpHandler(acpServer);
    const httpServer = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    const port = (httpServer.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${String(port)}/acp`;

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const events = new PassThrough();
    const reasoning = new PassThrough();

    let outLog = "";
    let errLog = "";
    let evtLog = "";
    let reasonLog = "";
    stdout.on("data", (c) => (outLog += String(c)));
    stderr.on("data", (c) => (errLog += String(c)));
    events.on("data", (c) => (evtLog += String(c)));
    reasoning.on("data", (c) => (reasonLog += String(c)));

    const opts: CliCommonOptions = {
        url,
        explicitAcpUrl: true,
        host: "127.0.0.1",
        port,
        credential: new Credential({ HOME: tmpDir, XDG_STATE_HOME: tmpDir }),
        env: {
            HOME: tmpDir,
            XDG_STATE_HOME: tmpDir,
            VISUAL: `${process.execPath} ${fakeEditor}`,
        },
        cwd: tmpDir,
        workspace: "ws1",
        sessionId: "session1",
        termSession: "session1",
        autostart: false,
        daemonTimeoutMs: 2000,
        oauthTimeoutMs: 2000,
        cancelGraceMs: 500,
        yolo: false,
        auto: false,
        bell: false,
        json: false,
        repl: true,
        previewLines: 4,
        historyEntries: 10,
        mermaidTimeoutMs: 1000,
        color: "never",
    };

    try {
        const replPromise = runReplSession(opts, { stdin, stdout, stderr, events, reasoning });

        const commands = [
            "?",
            "/help model",
            "/update",
            "/sessions",
            "/session",
            "/parent",
            "/enter",
            "/older",
            "/newer",
            "/parent",
            "/session custom1",
            "/fork branched",
            "/workspaces",
            "/workspace",
            "/workspace ws1",
            "/rename",
            "/rename wsRenamed",
            "/models",
            "/loops",
            "/loop bad",
            "/loop 99",
            "/loop 1",
            "/loop 2",
            "/share",
            "/share ~/shared-out",
            "/rollback",
            "/rollback 1/1/1",
            "/import",
            "/import draft.md",
            "/editor",
            "/script",
            "/script ops.plk",
            "/model",
            "/model fast high",
            "/child inherit",
            "/mcp list",
            "/mcp add \"unterminated",
            "/logout",
            "/custom:deploy now",
            "/nonexistent",
            ":",
            "!",
            "! echo direct",
            'await plurnk.read({"target":"a.ts"})',
            "... follow up",
            "? careful question",
            ": literal text",
            "/learn --scope invalid",
            "/stop",
            "/quit",
        ];

        for (const cmd of commands) {
            stdin.write(`${cmd}\n`);
        }

        const exitCode = await replPromise;
        assert.equal(exitCode, 0);
        assert.match(outLog, /\/model \[selector\] \[effort\]/u);
        assert.match(outLog, /catalog: ok/u);
        assert.match(outLog, /● session1/u);
        assert.match(outLog, /\(at the root: no parent\)/u);
        assert.match(outLog, /session: childB \(bound\)/u);
        assert.match(outLog, /session: childA \(bound\)/u);
        assert.match(outLog, /session: branched \(forked\)/u);
        assert.match(outLog, /workspace: wsRenamed/u);
        assert.match(outLog, /1: First loop/u);
        assert.match(outLog, /2: ~worker: Second loop 🛑/u);
        assert.match(outLog, /usage: \/loop \[n\]/u);
        assert.match(outLog, /no loop 99/u);
        assert.match(outLog, /cancelled \(final 499\)/u);
        assert.match(evtLog, /"sessionUpdate":"loop_replay"/u);
        assert.match(evtLog, /"sessionUpdate":"composer_updated"/u);
        assert.match(reasonLog, /pondering\n/u);
        assert.match(errLog, /unknown-command/u);
        assert.match(errLog, /Empty literal prompt/u);
        assert.match(errLog, /Empty shell command/u);
        assert.match(errLog, /Unterminated quote/u);
        assert.match(errLog, /Invalid \/learn scope/u);
        assert.ok(execReceived.some((x) => x.includes("echo direct")));
        assert.ok(execReceived.some((x) => x.includes("plurnk.read")));
        assert.ok(promptsReceived.some((p) => p.text.includes("Edited prompt")));
        assert.ok(promptsReceived.some((p) => p.text === "/custom:deploy now"));
        assert.ok(promptsReceived.some((p) => p.text === "careful question"));
        assert.ok(promptsReceived.some((p) => p.text === "literal text"));
    } finally {
        await new Promise<void>((r) => httpServer.close(() => r()));
        rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("{§cli-repl-mode} {§cli-configuration-source} {§cli-problems-and-notices}: /stop cancels an in-flight /mcp oauth wait without blocking the REPL queue and oauth.complete errors surface diagnostic details", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plurnk-repl-oauth-"));
    const oauthBegun = Promise.withResolvers<string>();
    let beginCount = 0;

    const agentApp = createAcpAgent({ name: "repl-oauth-test-agent" })
        .onRequest(methods.agent.initialize, async () => ({
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "@plurnk/plurnk-service", version: "1.0.0" },
            capabilities: { session: { prompt: {}, resume: {} } },
        }))
        .onRequest(methods.agent.session.new, async () => ({
            sessionId: "1#session1",
            configOptions: [],
            _meta: { plurnk: { workspace: { id: 1, name: "alpha", projectRoot: tmpDir }, sessionName: "session1" } },
        }))
        .onRequest(methods.agent.session.resume, async () => ({
            configOptions: [],
            _meta: { plurnk: { workspace: { id: 1, name: "alpha", projectRoot: tmpDir }, sessionName: "session1" } },
        }))
        .onRequest(
            "_plurnk/action",
            (raw) => raw as { kind: string; params?: Record<string, unknown> },
            async ({ params }) => {
                if (params.kind === "workspace.create" || params.kind === "workspace.attach") {
                    return { workspaceId: 1, workspaceName: "alpha", projectRoot: tmpDir };
                }
                if (params.kind === "workspace.mcp.list") {
                    return {
                        definitions: [
                            {
                                alias: "cloudflare",
                                state: "authorization-required",
                                definition: { type: "streamable-http", url: "https://mcp.cloudflare.com/mcp" },
                            },
                        ],
                    };
                }
                if (params.kind === "workspace.mcp.oauth.begin") {
                    beginCount += 1;
                    const redirectUrl = String(params.params?.redirectUrl ?? "");
                    const authUrl = `https://identity.example/authorize?state=s-${String(beginCount)}&redirect_uri=${encodeURIComponent(redirectUrl)}`;
                    if (beginCount === 1) oauthBegun.resolve(redirectUrl);
                    return {
                        status: 202,
                        alias: "cloudflare",
                        authorization: { url: authUrl },
                    };
                }
                if (params.kind === "workspace.mcp.oauth.complete") {
                    const { RequestError } = await import("@agentclientprotocol/sdk/experimental/v2/unstable");
                    throw new RequestError(
                        -32000,
                        "OAuth authorization for MCP server 'cloudflare' could not be completed. (oauth-callback-invalid)",
                        {
                            type: "https://problems.plurnk.xyz/mcp/management/oauth-callback-invalid",
                            title: "OAuth callback invalid",
                            status: 400,
                            detail: "OAuth authorization for MCP server 'cloudflare' could not be completed.",
                            diagnostic: "Issuer mismatch in authorization response (RFC 9207)",
                            recovery: "Re-run /mcp oauth cloudflare.",
                        },
                    );
                }
                return {};
            },
        );

    const acpServer = new AcpServer({ agent: agentApp });
    const handler = createNodeHttpHandler(acpServer);
    const httpServer = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    const port = (httpServer.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${String(port)}/acp`;

    try {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const events = new PassThrough();
        let outBuf = "";
        let errBuf = "";
        let evtBuf = "";
        stdout.on("data", (c) => (outBuf += String(c)));
        stderr.on("data", (c) => (errBuf += String(c)));
        events.on("data", (c) => (evtBuf += String(c)));

        const replPromise = runReplSession(
            {
                url,
                explicitAcpUrl: true,
                host: "127.0.0.1",
                port,
                credential: new Credential({ HOME: tmpDir, XDG_STATE_HOME: tmpDir }),
                env: { HOME: tmpDir, XDG_STATE_HOME: tmpDir },
                cwd: tmpDir,
                workspace: "alpha",
                sessionId: "session1",
                termSession: "session1",
                autostart: false,
                daemonTimeoutMs: 2000,
                oauthTimeoutMs: 60_000,
                cancelGraceMs: 200,
                yolo: true,
                auto: false,
                bell: false,
                json: false,
                repl: true,
                previewLines: 3,
                historyEntries: 5,
                mermaidTimeoutMs: 1000,
                color: "never",
            },
            {
                stdin,
                stdout,
                stderr,
                events,
                reasoning: new PassThrough(),
                openBrowser: async () => {},
            },
        );

        // 1. Start /mcp oauth cloudflare with a 60s timeout and immediately cancel it via /stop.
        stdin.write("/mcp oauth cloudflare\n");
        await oauthBegun.promise;
        stdin.write("/stop\n");
        // Wait for cancellation error to land without waiting anywhere near 60s.
        const cancelDeadline = Date.now() + 3_000;
        while (!errBuf.includes("OAuth sign-in cancelled.") && Date.now() < cancelDeadline) {
            await new Promise((r) => setTimeout(r, 20));
        }
        assert.match(errBuf, /OAuth sign-in cancelled\./u);
        assert.match(evtBuf, /"sessionUpdate":"local_oauth","active":true/u);
        assert.match(evtBuf, /"sessionUpdate":"local_oauth","active":false/u);

        // 2. REPL queue remains healthy: direct callback completion surfaces Problem diagnostic + recovery.
        stdin.write("/mcp oauth cloudflare http://127.0.0.1:41234/callback?code=c&state=s\n");
        stdin.write("/help\n");
        stdin.write("/quit\n");

        const exitCode = await replPromise;
        assert.equal(exitCode, 0);
        assert.match(errBuf, /Issuer mismatch in authorization response \(RFC 9207\)/u);
        assert.match(errBuf, /Re-run \/mcp oauth cloudflare\./u);
        assert.match(outBuf, /\/help/u);
    } finally {
        await acpServer.close();
        httpServer.closeAllConnections();
        await new Promise<void>((r) => httpServer.close(() => r()));
        rmSync(tmpDir, { recursive: true, force: true });
    }
});
