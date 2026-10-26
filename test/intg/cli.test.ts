import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import * as readline from "node:readline";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import { createNodeHttpHandler } from "@agentclientprotocol/sdk/experimental/node";
import {
    agent as createAcpAgent,
    methods,
    PROTOCOL_VERSION,
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
    const sessions = new Map<string, { cwd: string; model: string; effort: string }>();
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
                        providers: [
                            {
                                id: "mocktest",
                                name: "Mock Provider",
                                status: "ready",
                                models: [{ id: "mocktest/mock-v1", name: "Mock V1" }],
                            },
                        ],
                        aliases: [],
                    };
                }
                if (params.kind === "workspace.list") {
                    return {
                        workspaces: [
                            { id: 1, name: "test-ws", projectRoot: "/tmp", projectLabel: "test-ws" },
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
                return { ok: true };
            },
        )
        .onRequest(methods.agent.session.new, async ({ params }) => {
            const name = (params._meta as any)?.plurnk?.name ?? "session-1";
            const sessionId = `1#${name}`;
            sessions.set(sessionId, { cwd: params.cwd, model: "mocktest/mock-v1", effort: "medium" });
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
                ],
                availableCommands: [
                    { name: "mcp", description: "Manage MCP servers" },
                    { name: "skills", description: "Manage Agent Skills" },
                    { name: "members", description: "Manage file members" },
                    { name: "env", description: "Manage environment" },
                    { name: "schedule", description: "Manage scheduled messages" },
                    { name: "script", description: "Execute .plk script" },
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
                sessions.set(params.sessionId, { cwd: params.cwd, model: "mocktest/mock-v1", effort: "medium" });
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
        .onRequest(methods.agent.session.setConfigOption, async () => ({
            configOptions: [],
        }))
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
                            terminal: { status: 200, turns: 1, reason: "end_turn" },
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
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
};

test("{§cli-workspaces-and-sessions} {§cli-project-root} {§cli-workspace-open-settings} {§cli-history-lost} {§cli-one-shot-mode} {§cli-one-shot-flow} {§cli-output-channels} {§cli-what-one-shot-mode-does-not-do} {§cli-prompt-prefixes} {§cli-prompt-open-paths} {§cli-exit-codes} {§cli-partial-record} {§cli-interrupted-record}: one-shot prompt execution, --session attach-or-create, --json record, and exit codes", async () => {
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
        assert.match(String(doc.response), /Answered: JSON check/);
    } finally {
        await server.close();
    }
});

test("{§cli-model-selection} {§cli-child-provider-selection} {§cli-effort} {§cli-proposal-review} {§cli-session-ownership} {§cli-gate-answer-lifetime} {§cli-notification-shape} {§cli-review-attribution} {§cli-review-menu-interactive} {§cli-inline-review} {§cli-yolo-plurnkyolo} {§cli-tool-acceptance} {§cli-fail-closed-no-review-channel} {§cli-question-forms} {§cli-proposal-review-boundaries}: model/effort flags and permission handling under --yolo and fail-closed non-interactive review", async () => {
    const server = await createMockAcpServer();
    try {
        // With --yolo (default), ASK_PERMISSION is auto-approved
        const yoloRes = await runCli(
            ["--yolo", "--model", "mocktest/mock-v1", "--effort", "high", "ASK_PERMISSION"],
            {
                ...process.env,
                PLURNK_ACP_URL: server.url,
                PLURNK_CLIENT_AUTOSTART: "0",
            },
        );
        assert.equal(yoloRes.status, 0, `stderr was: ${yoloRes.stderr}`);
        assert.match(yoloRes.stdout, /Permission outcome: allow_once/);

        // With PLURNK_CLIENT_YOLO=0 and non-TTY stdin, permission request fails closed (denies/rejects) ({§cli-fail-closed-no-review-channel})
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

test("{§cli-subcommands} {§cli-plurnk-models} {§cli-models-efforts} {§cli-plurnk-workspace-list} {§cli-plurnk-workspace-sessions-name} {§cli-plurnk-log-read} {§cli-plurnk-effort} {§cli-script-binding} {§cli-workspace-mcp-controls} {§cli-functionality-replacement} {§cli-universal-agent-skills} {§cli-file-members} {§cli-environment} {§cli-schedule}: CLI subcommands and Functionality family commands", async () => {
    const server = await createMockAcpServer();
    try {
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
    } finally {
        await server.close();
    }
});

test("{§cli-repl-mode} {§cli-tui-mode} {§cli-tui-flow} {§cli-interactive-command-discovery} {§cli-path-completion} {§cli-sessions-topology} {§cli-resume-observation} {§cli-session-history} {§cli-loops} {§cli-active-command-admission} {§cli-cancellation} {§cli-import-and-bracketed-paste} {§cli-problems-and-notices} {§cli-problem-control-flow} {§cli-connection-onboarding} {§cli-sign-in} {§cli-mcp-oauth-callback} {§cli-notice-rendering} {§cli-channel-posture} {§cli-stream-event-and-stream-concluded} {§cli-conformance} {§cli-acp-conformance} {§cli-test-daemon-lifecycle}: interactive REPL 5-stream contract, gate hash resolution, slash commands, problems, notices, streams, and conformance matrix", async () => {
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
    } finally {
        await server.close();
    }
});
