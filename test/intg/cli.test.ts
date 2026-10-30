import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import * as readline from "node:readline";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import xtermPkg from "@xterm/headless";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
const { Terminal } = xtermPkg;
import { createNodeHttpHandler } from "@agentclientprotocol/sdk/experimental/node";
import {
    agent as createAcpAgent,
    methods,
    PROTOCOL_VERSION,
    RequestError,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const binPath = path.join(repoRoot, "bin", "plurnk.js");

const runCli = (
    args: string[],
    env: Record<string, string | undefined>,
    timeoutMs = 5000,
): Promise<{ status: number | null; stdout: string; stderr: string; events: string; reasoning: string }> =>
    new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [binPath, ...args], {
            cwd: repoRoot,
            env,
            stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
        });
        child.stdin!.end();
        let stdout = "";
        let stderr = "";
        let events = "";
        let reasoning = "";
        const fd3 = child.stdio[3] as Readable;
        const fd4 = child.stdio[4] as Readable;
        child.stdout!.setEncoding("utf8");
        child.stderr!.setEncoding("utf8");
        fd3.setEncoding("utf8");
        fd4.setEncoding("utf8");
        child.stdout!.on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.stderr!.on("data", (chunk: string) => {
            stderr += chunk;
        });
        fd3.on("data", (chunk: string) => {
            events += chunk;
        });
        fd4.on("data", (chunk: string) => {
            reasoning += chunk;
        });
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`CLI timed out after ${timeoutMs}ms: ${args.join(" ")}\nstdout: ${stdout}\nstderr: ${stderr}`));
        }, timeoutMs);
        child.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on("close", (status) => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr, events, reasoning });
        });
    });

const createMockAcpServer = async () => {
    const sessions = new Map<string, { cwd: string; model: string; effort: string; persona: string; systemPrompt?: string }>();
    const agentApp = createAcpAgent({ name: "mock-plurnk-service" })
        .onRequest(methods.agent.initialize, async () => ({
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "@plurnk/plurnk-service", version: "4.3.2" },
            capabilities: {
                session: {
                    fork: {},
                    delete: {},
                    prompt: { image: {}, embeddedContext: {} },
                },
            },
        }))
        .onRequest(methods.agent.providers.list, async () => ({
            providers: [
                {
                    providerId: "mocktest",
                    supported: ["mocktest"],
                    required: false,
                    _meta: {
                        plurnk: {
                            id: "mocktest",
                            name: "Mock Provider",
                            status: "ready",
                            models: [{ id: "mocktest/mock-v1", name: "Mock V1" }],
                        },
                    },
                },
            ],
        }))
        .onRequest(
            "_plurnk/action",
            (raw) => raw as { kind: string; params?: Record<string, unknown> },
            async ({ params }) => {
                if (params.kind === "models.list") {
                    return {
                        items: [
                            {
                                selector: "mocktest/mock-v1",
                                provider: "mocktest",
                                providerName: "Mock Provider",
                                model: "mock-v1",
                                modelName: "Mock V1",
                                readiness: { ready: true },
                            },
                        ],
                        offset: 0,
                        total: 1,
                    };
                }
                if (params.kind === "service.update") {
                    return {
                        catalog: {
                            status: "updated",
                            providers: 10,
                            models: 300,
                            addedModels: 2,
                            updatedAt: "2026-10-26T00:00:00.000Z",
                            path: "/tmp/models.json",
                        },
                        service: {
                            package: "@plurnk/plurnk-service",
                            version: "4.3.3",
                            artifact: "source",
                            upgradeCommand: "npm install -g @plurnk/plurnk-service@latest @plurnk/plurnk@latest",
                        },
                    };
                }
                if (params.kind === "workspace.list") {
                    return {
                        workspaces: [
                            { id: 1, name: "test-ws", project_root: "/tmp", project_label: "test-ws" },
                        ],
                    };
                }
                if (params.kind === "workspace.sessions") {
                    return {
                        sessions: [
                            { id: 1, name: "repl01", lifecycle: "idle" },
                        ],
                    };
                }
                if (params.kind === "session.loops") {
                    const items = [
                        {
                            id: 1,
                            sessionId: 1,
                            sequence: 1,
                            status: 200,
                            prompt: "First loop question\nSecond line",
                            promptSource: "acp://operator/sessions/1%23repl01/messages/m1",
                        },
                        {
                            id: 2,
                            sessionId: 1,
                            sequence: 2,
                            status: 499,
                            prompt: "Cancelled loop",
                            promptSource: "session://helper",
                        },
                    ];
                    if (typeof params.params?.loopSeq === "number") {
                        return {
                            items,
                            updates: [
                                {
                                    sessionUpdate: "user_message_chunk",
                                    messageId: "m1",
                                    content: { type: "text", text: "First loop question" },
                                },
                                {
                                    sessionUpdate: "agent_message_chunk",
                                    messageId: "1/1/1",
                                    content: { type: "text", text: "First loop answer" },
                                    _meta: { plurnk: { id: 1, op: "SEND", status: 200 } },
                                },
                            ],
                        };
                    }
                    return { items };
                }
                if (params.kind === "op.parse") {
                    const rawText = String(params.params?.text ?? "");
                    return {
                        results: [
                            {
                                status: 200,
                                content: `OP_PARSE_OK: ${rawText.replace(/\r?\n/gu, "\\n")}`,
                            },
                        ],
                    };
                }
                if (params.kind === "session.env.replace") {
                    const alias = params.params?.alias;
                    const value = params.params?.value;
                    if (typeof alias !== "string" || typeof value !== "string") {
                        throw new RequestError(-32602, "Action 'session.env.replace' rejected parameters.");
                    }
                    if (alias.startsWith("PLURNK_")) {
                        throw new RequestError(
                            -32602,
                            `Environment variable '${alias}' is reserved by the PLURNK platform.`,
                            {
                                type: "https://problems.plurnk.xyz/config/invalid",
                                title: "Invalid configuration",
                                status: 400,
                                detail: `Environment variable '${alias}' is reserved by the PLURNK platform.`,
                            },
                        );
                    }
                    return { alias, state: "active", definition: { value } };
                }
                return { ok: true };
            },
        )
        .onRequest(methods.agent.session.new, async ({ params }) => {
            const name = (params._meta as any)?.plurnk?.name ?? "session-1";
            const sessionId = `1#${name}`;
            const spText = (params.systemPrompt as any)?.content?.[0]?.text;
            const initialPersona = typeof spText === "string" && spText.length > 0 ? "custom" : "none";
            sessions.set(sessionId, {
                cwd: params.cwd,
                model: "mocktest/mock-v1",
                effort: "medium",
                persona: initialPersona,
                ...(typeof spText === "string" ? { systemPrompt: spText } : {}),
            });
            return {
                sessionId,
                configOptions: [
                    {
                        configId: "model",
                        name: "Model",
                        category: "model",
                        type: "select",
                        currentValue: "mocktest/mock-v1",
                        options: [{ value: "mocktest/mock-v1", name: "Mock V1" }],
                    } as any,
                    {
                        configId: "thought_level",
                        name: "Effort",
                        category: "thought_level",
                        type: "select",
                        currentValue: "medium",
                        options: [
                            { value: "low", name: "Low" },
                            { value: "medium", name: "Medium" },
                            { value: "high", name: "High" },
                        ],
                    } as any,
                    {
                        configId: "persona",
                        name: "Persona",
                        category: "persona",
                        type: "select",
                        currentValue: initialPersona,
                        options: [
                            { value: "none", name: "None" },
                            { value: "reviewer", name: "reviewer", description: "Strict code reviewer" },
                            ...(initialPersona === "custom" ? [{ value: "custom", name: "Custom" }] : []),
                        ],
                    } as any,
                ],
                availableCommands: [
                    { type: "command", name: "mcp", description: "Manage MCP servers" },
                    { type: "command", name: "skills", description: "Manage Agent Skills" },
                    { type: "command", name: "members", description: "Manage file members" },
                    { type: "command", name: "env", description: "Manage environment" },
                    { type: "command", name: "schedule", description: "Manage scheduled messages" },
                    { type: "command", name: "script", description: "Execute .plk script" },
                ],
                _meta: {
                    plurnk: {
                        workspace: { id: 1, name: "test-ws", projectRoot: params.cwd, projectLabel: "test-ws" },
                        status: { model: { provider: "mocktest", model: "mock-v1" }, loopId: null, loopSeq: null },
                    },
                },
            };
        })
        .onRequest(methods.agent.session.resume, async ({ params, client }) => {
            if (!sessions.has(params.sessionId) && !(params._meta as any)?.plurnk?.create) {
                throw new Error(`Session '${params.sessionId}' does not exist.`);
            }
            if (!sessions.has(params.sessionId)) {
                sessions.set(params.sessionId, { cwd: params.cwd, model: "mocktest/mock-v1", effort: "medium", persona: "none" });
            }
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "state_update",
                    state: "idle",
                    stopReason: "end_turn",
                },
            });
            return {
                configOptions: [],
                availableCommands: [],
                _meta: {
                    plurnk: {
                        workspace: { id: 1, name: "test-ws", projectRoot: params.cwd, projectLabel: "test-ws" },
                    },
                },
            };
        })
        .onRequest(methods.agent.session.list, async () => ({
            sessions: [...sessions.entries()].map(([sessionId, s]) => ({
                sessionId,
                cwd: s.cwd,
                title: sessionId,
            })),
        }))
        .onRequest(methods.agent.session.fork, async ({ params }) => ({
            sessionId: `${params.sessionId}-fork`,
            configOptions: [],
        }))
        .onRequest(methods.agent.session.delete, async ({ params }) => {
            sessions.delete(params.sessionId);
            return {};
        })
        .onRequest(methods.agent.session.close, async () => ({}))
        .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
            const existing = sessions.get(params.sessionId) ?? {
                cwd: "/tmp",
                model: "mocktest/mock-v1",
                effort: "medium",
                persona: "none",
            };
            if (params.configId === "model") {
                if (params.value !== "mocktest/mock-v1" && params.value !== "mocktest") {
                    throw new RequestError(
                        -32000,
                        `Provider alias '${String(params.value)}' is not declared. (https://problems.plurnk.xyz/daemon/provider/alias-not-found)`,
                        {
                            type: "https://problems.plurnk.xyz/daemon/provider/alias-not-found",
                            title: "Provider alias not found",
                            status: 404,
                            detail: `Provider alias '${String(params.value)}' is not declared.`,
                        },
                    );
                }
                existing.model = "mocktest/mock-v1";
            } else if (params.configId === "thought_level") {
                if (!["low", "medium", "high"].includes(String(params.value))) {
                    throw new RequestError(
                        -32602,
                        `Effort '${String(params.value)}' is not supported.`,
                        {
                            type: "https://problems.plurnk.xyz/config/invalid",
                            title: "Invalid configuration",
                            status: 400,
                            detail: `Effort '${String(params.value)}' is not supported.`,
                        },
                    );
                }
                existing.effort = String(params.value);
            } else if (params.configId === "persona") {
                if (!["none", "reviewer"].includes(String(params.value))) {
                    throw new RequestError(
                        -32602,
                        `Persona '${String(params.value)}' was not found.`,
                        {
                            type: "https://problems.plurnk.xyz/acp/persona-not-found",
                            title: "Persona not found",
                            status: 404,
                            detail: `Persona '${String(params.value)}' was not found.`,
                        },
                    );
                }
                existing.persona = String(params.value);
                if (existing.persona === "reviewer") {
                    existing.effort = "high";
                }
            }
            sessions.set(params.sessionId, existing);
            return {
                configOptions: [
                    {
                        configId: "model",
                        name: "Model",
                        category: "model",
                        type: "select",
                        currentValue: existing.model,
                        options: [{ value: "mocktest/mock-v1", name: "Mock V1" }],
                    } as any,
                    {
                        configId: "thought_level",
                        name: "Effort",
                        category: "thought_level",
                        type: "select",
                        currentValue: existing.effort,
                        options: [
                            { value: "low", name: "Low" },
                            { value: "medium", name: "Medium" },
                            { value: "high", name: "High" },
                        ],
                    } as any,
                    {
                        configId: "persona",
                        name: "Persona",
                        category: "persona",
                        type: "select",
                        currentValue: existing.persona,
                        options: [
                            { value: "none", name: "None" },
                            { value: "reviewer", name: "reviewer", description: "Strict code reviewer" },
                        ],
                    } as any,
                ],
                _meta: {
                    plurnk: {
                        status: {
                            model: { provider: "mocktest", model: "mock-v1", chosenEffort: existing.effort },
                        },
                    },
                },
            };
        })
        .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
            const text = params.prompt
                .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
                .map((b) => b.text)
                .join("\n");
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_thought_chunk",
                    messageId: "t-1",
                    content: { type: "text", text: `Thinking about: ${text}` },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: "tc-1",
                    title: "READ file:///tmp/test.txt",
                    status: "completed",
                    _meta: {
                        plurnk: {
                            id: 1,
                            turnId: 1,
                            op: "READ",
                            origin: "model",
                            status: 200,
                            coordinate: "1/1/1",
                        },
                    },
                },
            });
            if (text.includes("TUI_WATERFALL_CHECK")) {
                await client.notify(methods.client.session.update, {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: "tc-find",
                        title: "FIND",
                        status: "completed",
                        rawInput: { target: { raw: "workspace:///*" }, aside: "entries" },
                        rawOutput: { matches: [1, 2, 3] },
                        content: [{ type: "content", content: { type: "text", text: '[{"path":"workspace:///notes/**"}]' } }],
                        _meta: { plurnk: { id: 2, turnId: 1, op: "FIND", origin: "model", status: 200, coordinate: "1/1/2" } },
                    },
                });
                await client.notify(methods.client.session.update, {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: "tc-note",
                        title: "NOTE — plan",
                        status: "completed",
                        rawInput: { aside: "plan", body: "Check waterfall spacing." },
                        _meta: { plurnk: { id: 3, turnId: 1, op: "NOTE", origin: "model", status: 200, coordinate: "1/1/3" } },
                    },
                });
                await client.notify(methods.client.session.update, {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: "tc-exec",
                        title: "brave",
                        status: "in_progress",
                        rawInput: { target: { raw: "brave_web_search" }, body: '{"query":"yemen"}' },
                        content: [{ type: "terminal", terminalId: "term:4" }],
                        _meta: { plurnk: { id: 4, turnId: 1, op: "brave", origin: "model", coordinate: "1/1/4" } },
                    },
                });
                await client.notify(methods.client.session.update, {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: "terminal_output_chunk",
                        terminalId: "term:4",
                        data: Buffer.from("Sana'a result 1\nSana'a result 2\n", "utf8").toString("base64"),
                        _meta: { plurnk: { opId: 4, target: "brave_web_search" } },
                    },
                });
                await client.notify(methods.client.session.update, {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: "tc-exec",
                        title: "brave",
                        status: "completed",
                        rawInput: { target: { raw: "brave_web_search" }, body: '{"query":"yemen"}' },
                        content: [{ type: "terminal", terminalId: "term:4" }],
                        _meta: { plurnk: { id: 4, turnId: 1, op: "brave", origin: "model", status: 200, coordinate: "1/1/4" } },
                    },
                });
            }
            if (text.includes("ASK_PERMISSION")) {
                const perm = await client.request(methods.client.session.requestPermission, {
                    sessionId: params.sessionId,
                    title: "Run command",
                    subject: {
                        type: "command",
                        command: "echo permitted",
                        cwd: "/tmp",
                    },
                    options: [
                        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
                        { optionId: "allow_always", name: "Allow always", kind: "allow_always" },
                        { optionId: "reject_once", name: "Reject once", kind: "reject_once" },
                        { optionId: "reject_always", name: "Reject always", kind: "reject_always" },
                    ],
                });
                const outcome = perm.outcome.outcome === "selected" ? perm.outcome.optionId : "cancelled";
                const editedBody = (perm as { _meta?: { plurnk?: { body?: string } } })._meta?.plurnk?.body;
                const bodySuffix = editedBody !== undefined ? ` | body=${JSON.stringify(editedBody)}` : "";
                await client.notify(methods.client.session.update, {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        messageId: "m-1",
                        content: { type: "text", text: `Permission outcome: ${outcome}${bodySuffix}` },
                    },
                });
            } else {
                await client.notify(methods.client.session.update, {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        messageId: "m-1",
                        content: { type: "text", text: `Answered: ${text.replace(/\r?\n/gu, "\\n")}` },
                    },
                });
            }
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "usage_update",
                    used: 42,
                    size: 128000,
                    cost: { amount: 0.001, currency: "USD" },
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
                            terminal: { status: 200, turnCount: 1, reason: "end_turn" },
                        },
                    },
                },
            });
            return { messageId: "user-m-1" };
        });

    const acpServer = new AcpServer({ agent: agentApp });
    const httpHandler = createNodeHttpHandler(acpServer);

    const server = http.createServer((req, res) => {
        if (!req.url?.startsWith("/acp")) {
            res.statusCode = 404;
            res.end();
            return;
        }
        void httpHandler(req, res);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address() as { port: number };
    return {
        url: `http://127.0.0.1:${address.port}/acp`,
        port: address.port,
        async close() {
            await acpServer.close();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
};

test("{§cli-workspaces-and-sessions} {§cli-output-channels}: one-shot prompt execution, --session attach-or-create, --json record, and exit codes", async () => {
    const server = await createMockAcpServer();
    try {
        // User's exact reproducer: --session="test01" "Describe this project." must create/resume test01 and succeed!
        const res = await runCli(
            ["--session=test01", "Describe this project."],
            {
                ...process.env,
                PLURNK_ACP_URL: server.url,
                PLURNK_CLIENT_AUTOSTART: "0",
            },
        );
        assert.equal(res.status, 0, `stderr was: ${res.stderr}`);
        assert.equal(res.stderr, "");
        assert.equal(res.stdout, "Answered: Describe this project.\n");
        assert.equal(res.reasoning, "Thinking about: Describe this project.\n");
        const eventLines = res.events
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { sessionUpdate: string });
        assert.ok(eventLines.some((e) => e.sessionUpdate === "session_bound"));
        assert.ok(eventLines.some((e) => e.sessionUpdate === "tool_call_update"));
        assert.ok(eventLines.some((e) => e.sessionUpdate === "usage_update"));
        assert.ok(eventLines.some((e) => e.sessionUpdate === "state_update"));

        // --json output mode emits structured JSON record with .response ({§cli-output-channels})
        const jsonRes = await runCli(
            ["--json", "--session=test01", "JSON check"],
            {
                ...process.env,
                PLURNK_ACP_URL: server.url,
                PLURNK_CLIENT_AUTOSTART: "0",
            },
        );
        assert.equal(jsonRes.status, 0, `stderr was: ${jsonRes.stderr}`);
        const doc = JSON.parse(jsonRes.stdout);
        assert.equal(doc.schemaVersion, 6);
        assert.equal("items" in doc, false);
        assert.match(String(doc.response), /Answered: JSON check/);
    } finally {
        await server.close();
    }
});

test("{§cli-model-selection} {§cli-inline-review}: model/effort flags and permission handling under --yolo and fail-closed non-interactive review", async () => {
    const server = await createMockAcpServer();
    try {
        // With --yolo (default), ASK_PERMISSION is auto-approved
        const yoloRes = await runCli(
            ["--yolo", "--model", "mocktest/mock-v1", "--effort", "high", "--env", "CUSTOM_VAR=ok", "ASK_PERMISSION"],
            {
                ...process.env,
                PLURNK_ACP_URL: server.url,
                PLURNK_CLIENT_AUTOSTART: "0",
            },
        );
        assert.equal(yoloRes.status, 0, `stderr was: ${yoloRes.stderr}`);
        assert.match(yoloRes.stdout, /Permission outcome: allow_once/);

        // Pre-admission rejection on invalid --model, --effort, or reserved --env exits 1 cleanly without hanging ({§cli-model-selection}, {§cli-output-channels})
        const badModelCli = await runCli(
            ["--model=granite", "--session=granite", "Hello"],
            {
                ...process.env,
                PLURNK_ACP_URL: server.url,
                PLURNK_CLIENT_AUTOSTART: "0",
            },
        );
        assert.equal(badModelCli.status, 1);
        assert.match(badModelCli.stderr, /Provider alias 'granite' is not declared\./u);

        const badEffortRepl = await runCli(
            ["--repl", "--effort=bogus", "--session=granite"],
            {
                ...process.env,
                PLURNK_ACP_URL: server.url,
                PLURNK_CLIENT_AUTOSTART: "0",
            },
        );
        assert.equal(badEffortRepl.status, 1);
        assert.match(badEffortRepl.stderr, /Effort 'bogus' is not supported\./u);

        const badEnvCli = await runCli(
            ["--env", "PLURNK_MODEL=illegal", "Hello"],
            {
                ...process.env,
                PLURNK_ACP_URL: server.url,
                PLURNK_CLIENT_AUTOSTART: "0",
            },
        );
        assert.equal(badEnvCli.status, 1);
        assert.match(badEnvCli.stderr, /reserved by the PLURNK platform/u);

        // User's exact PTY TUI reproducer: `plurnk --model="granite" --session="granite"` exits 1 cleanly without hanging or writing raw-mode escape queries
        let badModelPtyOut = "";
        const badModelPty = pty.spawn(
            process.execPath,
            [binPath, "--model=granite", "--session=granite"],
            {
                name: "xterm-256color",
                cols: 100,
                rows: 30,
                cwd: repoRoot,
                env: {
                    ...process.env,
                    PLURNK_ACP_URL: server.url,
                    PLURNK_CLIENT_AUTOSTART: "0",
                    NO_COLOR: "1",
                } as Record<string, string>,
            },
        );
        badModelPty.onData((chunk) => {
            badModelPtyOut += chunk;
        });
        const badModelPtyExit = await new Promise<number>((resolveExit, rejectExit) => {
            const timer = setTimeout(() => {
                badModelPty.kill();
                rejectExit(new Error(`PTY hung on --model=granite:\n${badModelPtyOut}`));
            }, 4000);
            badModelPty.onExit(({ exitCode }) => {
                clearTimeout(timer);
                resolveExit(exitCode);
            });
        });
        assert.equal(badModelPtyExit, 1);
        assert.match(badModelPtyOut, /Provider alias 'granite' is not declared\./u);
        assert.doesNotMatch(badModelPtyOut, /\x1b\[\?2004h/u, "Must not enable raw terminal modes before admission succeeds");

        // With PLURNK_CLIENT_YOLO=0 and non-TTY stdin, permission request fails closed (denies/rejects) ({§cli-inline-review})
        const noYoloRes = await runCli(
            ["ASK_PERMISSION"],
            {
                ...process.env,
                PLURNK_ACP_URL: server.url,
                PLURNK_CLIENT_AUTOSTART: "0",
                PLURNK_CLIENT_YOLO: "0",
            },
        );
        assert.match(noYoloRes.stdout + noYoloRes.stderr, /deny|reject|cancelled/i);
    } finally {
        await server.close();
    }
});

test("{§cli-subcommands} {§cli-configuration-source}: CLI subcommands and Functionality family commands", async () => {
    const server = await createMockAcpServer();
    try {
        const updateRes = await runCli(
            ["update"],
            {
                ...process.env,
                PLURNK_ACP_URL: server.url,
                PLURNK_CLIENT_AUTOSTART: "0",
            },
        );
        assert.equal(updateRes.status, 0, `stderr was: ${updateRes.stderr}`);
        assert.match(updateRes.stdout, /catalog: updated \(300 models across 10 providers, \+2 new\)/);
        assert.match(updateRes.stdout, /version: @plurnk\/plurnk-service@4\.3\.3 \(source checkout\) — to update packages, stop the daemon and run: npm install -g @plurnk\/plurnk-service@latest @plurnk\/plurnk@latest/);

        const modelsRes = await runCli(
            ["models", "--json"],
            {
                ...process.env,
                PLURNK_ACP_URL: server.url,
                PLURNK_CLIENT_AUTOSTART: "0",
            },
        );
        assert.equal(modelsRes.status, 0, `stderr was: ${modelsRes.stderr}`);

        const wsListRes = await runCli(
            ["workspace", "list", "--json"],
            {
                ...process.env,
                PLURNK_ACP_URL: server.url,
                PLURNK_CLIENT_AUTOSTART: "0",
            },
        );
        assert.equal(wsListRes.status, 0, `stderr was: ${wsListRes.stderr}`);

        const personaRes = await runCli(
            ["persona", "reviewer"],
            {
                ...process.env,
                PLURNK_ACP_URL: server.url,
                PLURNK_CLIENT_AUTOSTART: "0",
            },
        );
        assert.equal(personaRes.status, 0, `stderr was: ${personaRes.stderr}`);
        assert.match(personaRes.stdout, /persona \(Persona\): reviewer \[\*none|persona \(Persona\): reviewer \[none, \*reviewer\]/);

        const sysPromptRes = await runCli(
            ["--system-prompt", "Act as security auditor.", "--json", "hello"],
            {
                ...process.env,
                PLURNK_ACP_URL: server.url,
                PLURNK_CLIENT_AUTOSTART: "0",
                PLURNK_PERSONA: "reviewer",
            },
        );
        assert.equal(sysPromptRes.status, 0, `stderr was: ${sysPromptRes.stderr}`);
        const sysPromptPayload = JSON.parse(sysPromptRes.stdout) as { configOptions?: Array<{ configId: string; currentValue: string }> };
        assert.equal(
            sysPromptPayload.configOptions?.find((o) => o.configId === "persona")?.currentValue,
            "custom",
            "--system-prompt must seed session role and override ambient PLURNK_PERSONA",
        );
    } finally {
        await server.close();
    }
});

test("{§cli-repl-mode} {§cli-interactive-command-discovery} {§cli-sessions-topology} {§cli-inline-review} {§cli-problems-and-notices} {§cli-configuration-source} {§cli-conformance}: interactive REPL 5-stream contract, gate hash resolution, slash commands, problems, notices, streams, and conformance matrix", async () => {
    const server = await createMockAcpServer();
    try {
        const compRes = await runCli(
            ["completion", "bash"],
            {
                ...process.env,
                PLURNK_ACP_URL: server.url,
                PLURNK_CLIENT_AUTOSTART: "0",
            },
        );
        assert.equal(compRes.status, 0);
        assert.match(compRes.stdout, /plurnk/);

        // Exercise interactive --repl mode over all 5 file descriptors (0..4)
        const replChild = spawn(
            process.execPath,
            [binPath, "--repl", "--session=repl01"],
            {
                cwd: repoRoot,
                env: {
                    ...process.env,
                    PLURNK_ACP_URL: server.url,
                    PLURNK_CLIENT_AUTOSTART: "0",
                    PLURNK_CLIENT_YOLO: "0",
                },
                stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
            },
        );

        const stdoutLines: string[] = [];
        const stderrObjs: Record<string, unknown>[] = [];
        const eventObjs: Record<string, unknown>[] = [];
        let reasoningText = "";

        const stdoutRl = readline.createInterface({ input: replChild.stdout!, terminal: false });
        const stderrRl = readline.createInterface({ input: replChild.stderr!, terminal: false });
        const eventsRl = readline.createInterface({ input: replChild.stdio[3] as Readable, terminal: false });
        const reasoningStream = replChild.stdio[4] as Readable;
        reasoningStream.setEncoding("utf8");
        reasoningStream.on("data", (chunk: string) => {
            reasoningText += chunk;
        });

        const stdoutWaiters: Array<{ pred: (line: string) => boolean; resolve: (line: string) => void }> = [];
        const stderrWaiters: Array<{ pred: (obj: Record<string, unknown>) => boolean; resolve: (obj: Record<string, unknown>) => void }> = [];
        const eventWaiters: Array<{ pred: (obj: Record<string, unknown>) => boolean; resolve: (obj: Record<string, unknown>) => void }> = [];

        stdoutRl.on("line", (line) => {
            stdoutLines.push(line);
            for (let i = stdoutWaiters.length - 1; i >= 0; i -= 1) {
                if (stdoutWaiters[i]!.pred(line)) {
                    const w = stdoutWaiters.splice(i, 1)[0]!;
                    w.resolve(line);
                }
            }
        });
        stderrRl.on("line", (line) => {
            const obj = JSON.parse(line) as Record<string, unknown>;
            stderrObjs.push(obj);
            for (let i = stderrWaiters.length - 1; i >= 0; i -= 1) {
                if (stderrWaiters[i]!.pred(obj)) {
                    const w = stderrWaiters.splice(i, 1)[0]!;
                    w.resolve(obj);
                }
            }
        });
        eventsRl.on("line", (line) => {
            const obj = JSON.parse(line) as Record<string, unknown>;
            eventObjs.push(obj);
            for (let i = eventWaiters.length - 1; i >= 0; i -= 1) {
                if (eventWaiters[i]!.pred(obj)) {
                    const w = eventWaiters.splice(i, 1)[0]!;
                    w.resolve(obj);
                }
            }
        });

        const waitStdout = (pred: (line: string) => boolean): Promise<string> => {
            const existing = stdoutLines.find(pred);
            if (existing !== undefined) return Promise.resolve(existing);
            return new Promise((resolve) => stdoutWaiters.push({ pred, resolve }));
        };
        const waitStderr = (pred: (obj: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
            const existing = stderrObjs.find(pred);
            if (existing !== undefined) return Promise.resolve(existing);
            return new Promise((resolve) => stderrWaiters.push({ pred, resolve }));
        };
        const waitEvent = (pred: (obj: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
            const existing = eventObjs.find(pred);
            if (existing !== undefined) return Promise.resolve(existing);
            return new Promise((resolve) => eventWaiters.push({ pred, resolve }));
        };

        const boundEvent = await waitEvent((e) => e.sessionUpdate === "session_bound");
        assert.ok(Array.isArray(boundEvent.history), "session_bound carries history array");
        assert.ok(Array.isArray(boundEvent.sessions), "session_bound carries sessions array");
        assert.ok(Array.isArray(boundEvent.workspaces), "session_bound carries workspaces array");
        await waitStdout((l) => l === "workspace: test-ws");

        // Slash commands on fd 0 -> output on fd 1
        replChild.stdin!.write("/model\n");
        await waitStdout((l) => l.includes("model (Model): mocktest/mock-v1"));

        replChild.stdin!.write("/persona reviewer\n");
        await waitStdout((l) => l.includes("persona (Persona): reviewer"));
        replChild.stdin!.write("/persona none\n");
        await waitStdout((l) => l.includes("persona (Persona): none"));

        // /loops and /loop 1
        replChild.stdin!.write("/loops\n");
        await waitStdout((l) => l === "  1: First loop question…");
        await waitStdout((l) => l === "  2: ~helper: Cancelled loop 🛑");
        replChild.stdin!.write("/loop 1\n");
        const loopReplayEvent = await waitEvent((e) => e.sessionUpdate === "loop_replay" && e.loopSeq === 1);
        assert.ok(Array.isArray(loopReplayEvent.history) && loopReplayEvent.history.length === 2);

        // Unknown command -> structured Problem JSONL on fd 2 (stderr)
        replChild.stdin!.write("/nonexistent\n");
        const errObj = await waitStderr((e) => e.type === "https://problems.plurnk.xyz/client/unknown-command");
        assert.equal(errObj.status, 400);

        // Multiline executable backtick fence on fd 0 -> routes to op.parse
        replChild.stdin!.write("```READ file:///tmp/test.txt\n```\n");
        await waitStdout((l) => l === "OP_PARSE_OK: ```READ file:///tmp/test.txt\\n```");

        // Bracketed paste multiline submission on fd 0 -> single prompt with preserved newlines
        replChild.stdin!.write("\x1b[200~Bracketed line 1\nBracketed line 2\x1b[201~\n");
        await waitStdout((l) => l === "Answered: Bracketed line 1\\nBracketed line 2");

        // Backslash line continuation on fd 0 -> single prompt with preserved newline
        replChild.stdin!.write("Continued line 1 \\\nContinued line 2\n");
        await waitStdout((l) => l === "Answered: Continued line 1 \\nContinued line 2");

        // /import <path> stages local file and emits composer_updated on fd 3, then prepends to next prompt
        replChild.stdin!.write("/import package.json\n");
        const composerEvent = await waitEvent(
            (e) => e.sessionUpdate === "composer_updated" && e.source === "import" && e.path === "package.json",
        );
        assert.match(String(composerEvent.text ?? ""), /"@plurnk\/plurnk"/u);
        replChild.stdin!.write("Summarize imported package\n");
        await waitStdout((l) => l.includes("Answered:") && l.includes("@plurnk/plurnk") && l.includes("Summarize imported package"));

        // Prompt that triggers a permission gate while yolo is off
        replChild.stdin!.write("ASK_PERMISSION\n");
        const permEvent = await waitEvent((e) => e.sessionUpdate === "permission_request");
        const gateId = String(permEvent.id ?? "");
        assert.match(gateId, /^[0-9a-f]{8}$/u);

        // /review lists the pending gate with its @<id> hash
        replChild.stdin!.write("/review\n");
        await waitStdout((l) => l.includes(`@${gateId}`) && l.includes("permission"));

        // Omitting @<id> in REPL mode is refused with 400 on fd 2 (stderr)
        replChild.stdin!.write("/approve allow_always\n");
        const missingIdErr = await waitStderr(
            (e) => e.type === "https://problems.plurnk.xyz/client/usage" && String(e.detail ?? "").includes("@<id>"),
        );
        assert.equal(missingIdErr.status, 400);

        // /edit @<id> with bracketed-paste multiline body preserves embedded newlines
        replChild.stdin!.write(`\x1b[200~/edit @${gateId} edited line 1\nedited line 2\x1b[201~\n`);
        const resolvedEvent = await waitEvent((e) => e.sessionUpdate === "gate_resolved" && e.id === gateId);
        assert.deepEqual(resolvedEvent.outcome, { outcome: "selected", optionId: "allow_once" });

        await waitStdout((l) => l === 'Permission outcome: allow_once | body="edited line 1\\nedited line 2"');
        assert.ok(!stdoutLines.some((l) => l.startsWith("approved ")), "stdout must stay free of gate resolution acks");
        await waitEvent((e) => e.sessionUpdate === "state_update" && e.state === "idle");
        assert.match(reasoningText, /Thinking about: ASK_PERMISSION/);

        replChild.stdin!.write("/quit\n");
        const exitCode = await new Promise<number | null>((resolve) => replChild.on("close", resolve));
        assert.equal(exitCode, 0);

        // Exercise interactive TUI mode in a real PTY + headless xterm and verify waterfall spacing and previews
        const xterm = new Terminal({ cols: 100, rows: 45, allowProposedApi: true });
        let rawPty = "";
        const tuiPty = pty.spawn(
            process.execPath,
            [binPath, "--session=tui01"],
            {
                name: "xterm-256color",
                cols: 100,
                rows: 45,
                cwd: repoRoot,
                env: {
                    ...process.env,
                    PLURNK_ACP_URL: server.url,
                    PLURNK_CLIENT_AUTOSTART: "0",
                    NO_COLOR: "1",
                } as Record<string, string>,
            },
        );
        try {
            tuiPty.onData((chunk) => {
                rawPty += chunk;
                xterm.write(chunk);
            });
            const waitPty = (re: RegExp, timeoutMs = 5000): Promise<void> =>
                new Promise((resolveWait, rejectWait) => {
                    if (re.test(rawPty)) {
                        resolveWait();
                        return;
                    }
                    const start = Date.now();
                    const iv = setInterval(() => {
                        if (re.test(rawPty)) {
                            clearInterval(iv);
                            resolveWait();
                        } else if (Date.now() - start > timeoutMs) {
                            clearInterval(iv);
                            rejectWait(new Error(`Timed out waiting for ${String(re)} in TUI PTY:\n${rawPty}`));
                        }
                    }, 25);
                });
            await waitPty(/workspace: test-ws/u);
            await new Promise((r) => setTimeout(r, 100));
            tuiPty.write("TUI_WATERFALL_CHECK\r");
            await waitPty(/Answered: TUI_WATERFALL_CHECK/u);
            await new Promise((r) => setTimeout(r, 150));

            const buf = xterm.buffer.active;
            const screenLines: string[] = [];
            for (let i = 0; i < buf.length; i += 1) {
                const line = (buf.getLine(i)?.translateToString(true) ?? "").trimEnd();
                screenLines.push(line);
            }
            const readIdx = screenLines.findIndex((l) => l.startsWith("📖 (file:///tmp/test.txt)"));
            const findIdx = screenLines.findIndex((l) => l.startsWith("🔎 (workspace:///*)"));
            assert.ok(readIdx >= 0 && findIdx >= 0, `Expected READ and FIND rows on screen:\n${screenLines.join("\n")}`);
            assert.equal(findIdx, readIdx + 1, "Consecutive READ and FIND rows must have zero blank lines between them");
            assert.ok(!screenLines.some((l) => l.includes('[{"path":"workspace:///notes/**"}]')), "FIND result body must not be shown");
            assert.ok(screenLines.some((l) => l === "🚧"), `Model plan NOTE must render glyph without category word:\n${screenLines.join("\n")}`);
            assert.ok(screenLines.some((l) => l.startsWith("⚙️  brave (brave_web_search)")), `Runtime execution row must render with two spaces after gear:\n${screenLines.join("\n")}`);
            assert.ok(!screenLines.some((l) => l.includes('{"query":"yemen"}')), "MCP request body must not be shown in TUI");
            assert.ok(screenLines.some((l) => l === "    Sana'a result 1"), "Concluded execution output must preview indented 4 spaces");
            assert.ok(screenLines.some((l) => /^🐹 1 turn · \d+ms/u.test(l)), `Model reply must render with hamster glyph and inline loop summary:\n${screenLines.join("\n")}`);

            // /quit in PTY TUI must exit cleanly with code 0 on its own without kill()
            const tuiExitCode = await new Promise<number>((resolveExit, rejectExit) => {
                const timer = setTimeout(() => {
                    tuiPty.kill();
                    rejectExit(new Error("TUI PTY hung after /quit"));
                }, 4000);
                tuiPty.onExit(({ exitCode }) => {
                    clearTimeout(timer);
                    resolveExit(exitCode);
                });
                tuiPty.write("/quit\r");
            });
            assert.equal(tuiExitCode, 0);
        } finally {
            try {
                tuiPty.kill();
            } catch {
                // already exited
            }
            xterm.dispose();
        }
    } finally {
        await server.close();
    }
});
