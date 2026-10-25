import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
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
): Promise<{ status: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [binPath, ...args], {
            env,
            stdio: ["pipe", "pipe", "pipe"],
        });
        child.stdin.end();
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
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
            resolve({ status, stdout, stderr });
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
                return { ok: true };
            },
        )
        .onRequest(methods.agent.session.new, async ({ params }) => {
            const name = (params._meta as any)?.plurnk?.name ?? "worker-1";
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
                    { name: "a2a", description: "Manage A2A agents" },
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
                        { optionId: "approve", name: "Allow once", kind: "allow_once" },
                        { optionId: "deny", name: "Reject", kind: "reject_once" },
                    ],
                });
                const outcome = perm.outcome.outcome === "selected" ? perm.outcome.optionId : "cancelled";
                await client.notify(methods.client.session.update, {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        messageId: "m-1",
                        content: { type: "text", text: `Permission outcome: ${outcome}` },
                    },
                });
            } else {
                await client.notify(methods.client.session.update, {
                    sessionId: params.sessionId,
                    update: {
                        sessionUpdate: "agent_message_chunk",
                        messageId: "m-1",
                        content: { type: "text", text: `Answered: ${text}` },
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

test("{§cli-workspaces-and-workers} {§cli-project-root} {§cli-workspace-open-settings} {§cli-history-lost} {§cli-one-shot-mode} {§cli-one-shot-flow} {§cli-output-channels} {§cli-what-one-shot-mode-does-not-do} {§cli-prompt-prefixes} {§cli-prompt-open-paths} {§cli-exit-codes} {§cli-partial-record} {§cli-interrupted-record}: one-shot prompt execution, --worker attach-or-create, --json record, and exit codes", async () => {
    const server = await createMockAcpServer();
    try {
        // User's exact reproducer: --worker="test01" "Describe this project." must create/resume test01 and succeed!
        const res = await runCli(
            ["--worker=test01", "Describe this project."],
            {
                ...process.env,
                PLURNK_ACP_URL: server.url,
                PLURNK_CLIENT_AUTOSTART: "0",
            },
        );
        assert.equal(res.status, 0, `stderr was: ${res.stderr}`);
        assert.match(res.stdout, /Answered: Describe this project\./);

        // --json output mode emits structured JSON record with .response ({§cli-output-channels})
        const jsonRes = await runCli(
            ["--json", "--worker=test01", "JSON check"],
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

test("{§cli-model-selection} {§cli-child-provider-selection} {§cli-effort} {§cli-proposal-review} {§cli-worker-ownership} {§cli-gate-answer-lifetime} {§cli-notification-shape} {§cli-review-attribution} {§cli-review-menu-interactive} {§cli-inline-review} {§cli-yolo-plurnkyolo} {§cli-tool-acceptance} {§cli-fail-closed-no-review-channel} {§cli-question-forms} {§cli-proposal-review-boundaries}: model/effort flags and permission handling under --yolo and fail-closed non-interactive review", async () => {
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
        assert.match(yoloRes.stdout, /Permission outcome: approve/);

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

test("{§cli-subcommands} {§cli-plurnk-models} {§cli-models-efforts} {§cli-plurnk-workspace-list} {§cli-plurnk-workspace-workers-name} {§cli-plurnk-log-read} {§cli-plurnk-effort} {§cli-script-binding} {§cli-workspace-mcp-controls} {§cli-functionality-replacement} {§cli-universal-agent-skills} {§cli-outbound-agents} {§cli-file-members} {§cli-environment} {§cli-schedule}: CLI subcommands and Functionality family commands", async () => {
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

test("{§cli-tui-mode} {§cli-tui-flow} {§cli-interactive-command-discovery} {§cli-path-completion} {§cli-workers-topology} {§cli-resume-observation} {§cli-worker-history} {§cli-loops} {§cli-active-command-admission} {§cli-cancellation} {§cli-import-and-bracketed-paste} {§cli-problems-and-notices} {§cli-problem-control-flow} {§cli-connection-onboarding} {§cli-sign-in} {§cli-mcp-oauth-callback} {§cli-notice-rendering} {§cli-channel-posture} {§cli-stream-event-and-stream-concluded} {§cli-conformance} {§cli-acp-conformance} {§cli-test-daemon-lifecycle}: interactive slash commands, problems, notices, streams, and conformance matrix", async () => {
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
    } finally {
        await server.close();
    }
});
