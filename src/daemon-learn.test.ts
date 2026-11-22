// Unit and mock-server coverage for `plurnk daemon`, `/learn`,
// `/yolo` session mode binding, `?` loop review override, and slash-command completion (#254, #277)
// ({§cli-subcommands}, {§cli-model-selection}, {§cli-interactive-command-discovery}, {§cli-inline-review}, {§cli-repl-mode}).

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
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
import {
    runCliDaemon,
    runReplSession,
    type CliCommonOptions,
} from "./cli-runner.ts";
import { expandLearnCommand, renderCommandReference } from "./commands.ts";
import Credential from "./credential.ts";
import { completeInput } from "./term-completion.ts";

const makeCommon = (overrides: Partial<CliCommonOptions>): CliCommonOptions => ({
    url: "http://127.0.0.1:9/acp",
    explicitAcpUrl: true,
    host: "127.0.0.1",
    port: 9,
    credential: new Credential({}),
    env: {},
    cwd: "/tmp",
    termSession: "session1",
    autostart: false,
    daemonTimeoutMs: 2000,
    oauthTimeoutMs: 2000,
    cancelGraceMs: 500,
    yolo: false,
    auto: false,
    bell: false,
    json: false,
    repl: false,
    previewLines: 5,
    historyEntries: 10,
    mermaidTimeoutMs: 1000,
    color: "never",
    ...overrides,
});

test("{§cli-interactive-command-discovery} {§cli-model-selection} {§cli-subcommands}: expandLearnCommand, selector-scoped /model effort completion, /mode, and family subcommand/alias completion (#254, #277)", async () => {
    assert.equal(expandLearnCommand("hello world"), null);
    assert.equal(expandLearnCommand("/models"), null);

    const bare = expandLearnCommand("/learn");
    assert.ok(bare !== null);
    assert.match(bare, /mcp:\/\/\/plurnk\/skills\.json/u);
    assert.match(bare, /`skills` tool/u);

    const targeted = expandLearnCommand("  /learn   deploy staging safely  ");
    assert.ok(targeted !== null);
    assert.match(targeted, /mcp:\/\/\/plurnk\/skills\.json/u);
    assert.match(targeted, /deploy staging safely/u);
    assert.match(targeted, /`skills` tool/u);

    const headlessDefault = expandLearnCommand("/learn", { projectRoot: null });
    assert.ok(headlessDefault !== null);
    assert.match(headlessDefault, /plurnk\/skills\/<name>\/SKILL\.md/u);
    assert.equal(expandLearnCommand("/learn --scope project", { projectRoot: null }), null);
    const explicitPlurnk = expandLearnCommand("/learn --scope plurnk cross-project deploy", { projectRoot: "/tmp" });
    assert.ok(explicitPlurnk !== null);
    assert.match(explicitPlurnk, /plurnk\/skills\/<name>\/SKILL\.md/u);

    const baseCtx = {
        cwd: "/tmp",
        getProjectRoot: () => "/tmp",
        getEfforts: () => ["low", "medium"],
        getEffortsForModel: async (selector: string) =>
            selector === "anthropic/claude-opus-4-6" ? ["adaptive", "high", "max"] : null,
        getFamilyAliases: (family: string) => (family === "mcp" ? ["github", "gitea"] : []),
    };

    const completedLearn = await completeInput("/lea", baseCtx);
    assert.ok(completedLearn.suggestions.some((s) => s.value === "/learn"));

    const completedOpusEfforts = await completeInput("/model anthropic/claude-opus-4-6 ", baseCtx);
    assert.deepEqual(
        completedOpusEfforts.suggestions.map((s) => s.value),
        ["adaptive", "high", "max"],
    );

    const completedFallbackEfforts = await completeInput("/model custom-alias ", baseCtx);
    assert.deepEqual(
        completedFallbackEfforts.suggestions.map((s) => s.value),
        ["low", "medium"],
    );

    const completedModes = await completeInput("/mode ", baseCtx);
    assert.deepEqual(
        completedModes.suggestions.map((s) => s.value),
        ["review", "accept", "reject"],
    );

    const completedMembersSubs = await completeInput("/members ", baseCtx);
    assert.ok(!completedMembersSubs.suggestions.some((s) => s.value === "replace"));
    assert.ok(completedMembersSubs.suggestions.some((s) => s.value === "add"));

    const completedMcpOAuth = await completeInput("/mcp oauth g", baseCtx);
    assert.deepEqual(
        completedMcpOAuth.suggestions.map((s) => s.value),
        ["github", "gitea"],
    );

    const completedEnvScope = await completeInput("/env --scope ", baseCtx);
    assert.deepEqual(
        completedEnvScope.suggestions.map((s) => s.value),
        ["session", "workspace"],
    );

    assert.match(renderCommandReference("darwin"), /⌘\+Enter/u);
    assert.match(renderCommandReference("linux"), /Ctrl\+Enter/u);
    assert.match(renderCommandReference("linux"), /Shortcuts:/u);
});

test("{§cli-subcommands}: runCliDaemon forwards status -> config, passes custom arguments, and fails with 127 when service is absent (#254)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "plurnk-daemon-test-"));
    try {
        const outLog = join(tmp, "args.json");
        const fakeService = join(tmp, "fake-service.mjs");
        writeFileSync(
            fakeService,
            `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(outLog)}, JSON.stringify(process.argv.slice(2)));
process.exit(0);
`,
            "utf8",
        );

        const statusCode = await runCliDaemon(
            ["status"],
            makeCommon({ serviceBin: fakeService }),
        );
        assert.equal(statusCode, 0);
        assert.deepEqual(JSON.parse(readFileSync(outLog, "utf8")), ["config"]);

        const configCode = await runCliDaemon(
            ["config", "defaults"],
            makeCommon({ serviceBin: fakeService }),
        );
        assert.equal(configCode, 0);
        assert.deepEqual(JSON.parse(readFileSync(outLog, "utf8")), ["config", "defaults"]);

        await assert.rejects(
            () =>
                runCliDaemon(
                    ["status"],
                    makeCommon({
                        serviceBin: "/nonexistent/plurnk-service-bin",
                    }),
                ),
            (err: unknown) => {
                assert.equal((err as { exitCode?: number }).exitCode, 127);
                assert.equal(
                    (err as { problem?: { type?: string } }).problem?.type,
                    "https://problems.plurnk.xyz/client/daemon/not-installed",
                );
                return true;
            },
        );
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("{§cli-subcommands} {§cli-inline-review} {§cli-repl-mode}: /learn, /yolo mode sync, and ? prompt proposalPolicy override (#254, #277)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "plurnk-learn-test-"));
    const receivedPrompts: Array<{ text: string; meta: unknown }> = [];
    const setConfigCalls: Array<{ configId: string; value: unknown }> = [];
    let currentMode = "review";

    const buildSessionOpen = () => ({
        sessionId: "1#session1",
        configOptions: [
            {
                type: "select" as const,
                configId: "mode",
                name: "Approval",
                currentValue: currentMode,
                options: [
                    { value: "review", name: "Review" },
                    { value: "accept", name: "Accept" },
                    { value: "reject", name: "Reject" },
                ],
            },
            {
                type: "select" as const,
                configId: "model",
                name: "Model",
                currentValue: "mocktest/fast",
                options: [{ value: "mocktest/fast", name: "Fast" }],
            },
        ],
    });
    const agentApp = createAcpAgent({ name: "learn-mock" })
        .onRequest(methods.agent.initialize, async () => ({
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "@plurnk/plurnk-service", version: "8.0.0" },
            capabilities: { session: { prompt: {}, resume: {} } },
        }))
        .onRequest(methods.agent.session.new, async () => buildSessionOpen())
        .onRequest(methods.agent.session.resume, async () => buildSessionOpen())
        .onRequest(methods.agent.session.setConfigOption, async ({ params }) => {
            setConfigCalls.push({ configId: params.configId, value: params.value });
            if (params.configId === "mode" && typeof params.value === "string") {
                currentMode = params.value;
            }
            return { configOptions: buildSessionOpen().configOptions };
        })
        .onRequest(
            "_plurnk/action",
            (raw) => raw as { kind: string },
            async () => ({}),
        )
        .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
            const text = params.prompt
                .map((b) => ("text" in b && typeof b.text === "string" ? b.text : ""))
                .join("\n");
            receivedPrompts.push({ text, meta: params._meta });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: "m-1",
                    content: { type: "text", text: "Created SKILL.md" },
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
            return { messageId: "m-1" };
        });

    const acpServer = new AcpServer({ agent: agentApp });
    const server = http.createServer(createNodeHttpHandler(acpServer));

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");

    try {
        const acpUrl = `http://127.0.0.1:${String(addr.port)}/acp`;
        const stateDir = join(tmp, "state");
        const env = { XDG_STATE_HOME: stateDir };
        const common = makeCommon({
            url: acpUrl,
            port: addr.port,
            credential: new Credential(env),
            env,
        });

        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const events = new PassThrough();
        const reasoning = new PassThrough();

        const replPromise = runReplSession(
            { ...common, repl: true },
            { stdin, stdout, stderr, events, reasoning },
        );
        stdin.write("/yolo\n");
        stdin.write("? audit before applying\n");
        stdin.write("/learn write release notes\n");
        const deadline = Date.now() + 3000;
        while (receivedPrompts.length < 2 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 20));
        }
        stdin.write("/yolo\n");
        stdin.write("/quit\n");
        const replCode = await replPromise;
        assert.equal(replCode, 0);
        assert.deepEqual(setConfigCalls, [
            { configId: "mode", value: "accept" },
            { configId: "mode", value: "review" },
        ]);
        assert.equal(receivedPrompts.length, 2);
        assert.equal(receivedPrompts[0]!.text, "audit before applying");
        assert.equal(
            (receivedPrompts[0]!.meta as { plurnk?: { proposalPolicy?: string } } | undefined)?.plurnk?.proposalPolicy,
            "review",
        );
        assert.match(receivedPrompts[1]!.text, /mcp:\/\/\/plurnk\/skills\.json/u);
        assert.match(receivedPrompts[1]!.text, /write release notes/u);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
        await acpServer.close();
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
    }
});
