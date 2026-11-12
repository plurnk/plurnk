// Unit and mock-server coverage for `plurnk daemon`, `plurnk web` (`/web`), `/learn`, and `plurnk onboard` (#254)
// ({§cli-subcommands}, {§cli-model-selection}, {§cli-interactive-command-discovery}, {§cli-repl-mode}).

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    openWebHandoff,
    runCliDaemon,
    runCliOnboard,
    runCliWeb,
    runReplSession,
    type CliCommonOptions,
} from "./cli-runner.ts";
import { expandLearnCommand } from "./commands.ts";
import Credential from "./credential.ts";
import { completeInput } from "./term-completion.ts";

const makeCommon = (overrides: Partial<CliCommonOptions>): CliCommonOptions => ({
    url: "http://127.0.0.1:9/acp",
    explicitAcpUrl: true,
    host: "127.0.0.1",
    port: 9,
    credential: new Credential({ PLURNK_SECRET: "test-operator-secret" }),
    env: { PLURNK_SECRET: "test-operator-secret" },
    cwd: "/tmp",
    termSession: "user",
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

test("{§cli-interactive-command-discovery} {§cli-subcommands}: expandLearnCommand expands /learn with and without instructions and /learn + /web appear in autocomplete (#254)", async () => {
    assert.equal(expandLearnCommand("hello world"), null);
    assert.equal(expandLearnCommand("/models"), null);

    const bare = expandLearnCommand("/learn");
    assert.ok(bare !== null);
    assert.match(bare, /skill:\/\/plurnk\/recipes\.md/u);
    assert.match(bare, /plurnk\.skills/u);

    const targeted = expandLearnCommand("  /learn   deploy staging safely  ");
    assert.ok(targeted !== null);
    assert.match(targeted, /skill:\/\/plurnk\/recipes\.md/u);
    assert.match(targeted, /deploy staging safely/u);
    assert.match(targeted, /plurnk\.skills/u);

    const completedLearn = await completeInput("/lea", { cwd: "/tmp", getProjectRoot: () => "/tmp" });
    assert.ok(completedLearn.suggestions.some((s) => s.value === "/learn"));

    const completedWeb = await completeInput("/we", { cwd: "/tmp", getProjectRoot: () => "/tmp" });
    assert.ok(completedWeb.suggestions.some((s) => s.value === "/web"));
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

test("{§cli-subcommands} {§cli-repl-mode}: runCliWeb and REPL /web + /learn mint operator handoff tickets without leaking ticket URLs on browser open and expand /learn into session/prompt (#254)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "plurnk-web-learn-test-"));
    const receivedPrompts: string[] = [];
    let handoffCount = 0;

    const sessionOpen = {
        sessionId: "1#user",
        configOptions: [
            {
                type: "select" as const,
                configId: "model",
                name: "Model",
                currentValue: "mocktest/fast",
                options: [{ value: "mocktest/fast", name: "Fast" }],
            },
        ],
    };
    const agentApp = createAcpAgent({ name: "web-learn-mock" })
        .onRequest(methods.agent.initialize, async () => ({
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "@plurnk/plurnk-service", version: "6.0.0" },
            capabilities: { session: { prompt: {}, resume: {} } },
        }))
        .onRequest(methods.agent.session.new, async () => sessionOpen)
        .onRequest(methods.agent.session.resume, async () => sessionOpen)
        .onRequest(
            "_plurnk/action",
            (raw) => raw as { kind: string },
            async () => ({}),
        )
        .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
            const text = params.prompt
                .map((b) => ("text" in b && typeof b.text === "string" ? b.text : ""))
                .join("\n");
            receivedPrompts.push(text);
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
    const acpHandler = createNodeHttpHandler(acpServer);

    const server = http.createServer(async (req, res) => {
        if (req.url === "/oauth/token" && req.method === "POST") {
            const chunks: Buffer[] = [];
            for await (const c of req) chunks.push(Buffer.from(c));
            const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
            if (form.get("client_id") === "operator" && form.get("client_secret") === "local-op-secret") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ access_token: "operator-jwt-token", expires_in: 300 }));
                return;
            }
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_client" }));
            return;
        }
        if (req.url === "/oauth/handoff" && req.method === "POST") {
            if (req.headers.authorization !== "Bearer operator-jwt-token") {
                res.writeHead(403, { "content-type": "application/json" });
                res.end(
                    JSON.stringify({
                        error: "unauthorized_client",
                        error_description: "Only the operator client may mint a browser sign-in handoff.",
                    }),
                );
                return;
            }
            handoffCount += 1;
            const addr = server.address();
            const port = addr && typeof addr === "object" ? addr.port : 0;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
                JSON.stringify({
                    ticket: `secret-ticket-${String(handoffCount)}`,
                    url: `http://127.0.0.1:${String(port)}/oauth/handoff?ticket=secret-ticket-${String(handoffCount)}`,
                    expires_in: 60,
                }),
            );
            return;
        }
        acpHandler(req, res);
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");

    try {
        const acpUrl = `http://127.0.0.1:${String(addr.port)}/acp`;
        const origin = `http://127.0.0.1:${String(addr.port)}`;
        // Even if grants.json holds a non-operator PKCE grant, operatorHeaders prefers the local operator secret!
        const stateDir = join(tmp, "state");
        const grantsDir = join(stateDir, "plurnk");
        const dataDir = join(tmp, "data");
        const secretDir = join(dataDir, "plurnk");
        writeFileSync(join(tmp, "dummy"), "");
        const env = {
            XDG_STATE_HOME: stateDir,
            XDG_DATA_HOME: dataDir,
        };
        const cred = new Credential(env);
        const grantsFile = cred.grantsPath();
        const { mkdirSync: mkdir } = await import("node:fs");
        mkdir(grantsDir, { recursive: true });
        mkdir(secretDir, { recursive: true });
        writeFileSync(
            grantsFile,
            JSON.stringify({
                [origin]: {
                    issuer: origin,
                    clientId: "pkce-non-operator",
                    accessToken: "pkce-jwt-token",
                    expiresAt: Date.now() + 60_000,
                },
            }),
            "utf8",
        );
        writeFileSync(join(secretDir, "secret"), "local-op-secret\n", "utf8");

        const common = makeCommon({
            url: acpUrl,
            port: addr.port,
            credential: cred,
            env,
        });

        const openedUrls: string[] = [];
        let printed = "";
        await openWebHandoff(common, {
            noOpen: false,
            openBrowser: async (u) => {
                openedUrls.push(u);
            },
            write: (t) => {
                printed += t;
            },
        });
        assert.equal(openedUrls.length, 1);
        assert.match(openedUrls[0]!, /\/oauth\/handoff\?ticket=secret-ticket-1$/u);
        // Must NOT print the secret ticket URL when browser launch succeeded!
        assert.doesNotMatch(printed, /secret-ticket-1/u);
        assert.match(printed, /Opened Plurnk Web in your browser/u);

        let noOpenPrinted = "";
        await openWebHandoff(common, {
            noOpen: true,
            write: (t) => {
                noOpenPrinted += t;
            },
        });
        assert.match(noOpenPrinted.trim(), /\/oauth\/handoff\?ticket=secret-ticket-2$/u);

        // Verify unauthenticated daemon (404 /oauth/handoff) probes HEAD / before returning root URL
        let rootMounted = false;
        const noAuthServer = http.createServer((req, res) => {
            if (req.url === "/" && req.method === "HEAD") {
                res.writeHead(rootMounted ? 200 : 404);
                res.end();
                return;
            }
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ status: 404, title: "Not found" }));
        });
        await new Promise<void>((r) => noAuthServer.listen(0, "127.0.0.1", r));
        try {
            const noAuthAddr = noAuthServer.address();
            assert.ok(noAuthAddr && typeof noAuthAddr === "object");
            const noAuthCommon = makeCommon({
                url: `http://127.0.0.1:${String(noAuthAddr.port)}/acp`,
                port: noAuthAddr.port,
                credential: new Credential({
                    XDG_STATE_HOME: join(tmp, "empty-state"),
                    XDG_DATA_HOME: join(tmp, "empty-data"),
                }),
                env: {},
            });
            await assert.rejects(
                openWebHandoff(noAuthCommon, { noOpen: true, write: () => {} }),
                (err: unknown) =>
                    err instanceof Error &&
                    /not mounted on this daemon/u.test(err.message),
            );
            rootMounted = true;
            let noAuthPrinted = "";
            await openWebHandoff(noAuthCommon, {
                noOpen: true,
                write: (t) => {
                    noAuthPrinted += t;
                },
            });
            assert.equal(noAuthPrinted.trim(), `http://127.0.0.1:${String(noAuthAddr.port)}/`);
        } finally {
            await new Promise<void>((r) => noAuthServer.close(() => r()));
        }

        // Verify runCliWeb entrypoint with browser fallback
        const code = await runCliWeb(false, common, async () => {
            throw new Error("no xdg-open");
        });
        assert.equal(code, 0);

        // Verify REPL /web --no-open and /learn [instructions]
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const events = new PassThrough();
        const reasoning = new PassThrough();
        let replOut = "";
        stdout.setEncoding("utf8");
        stdout.on("data", (chunk: string) => {
            replOut += chunk;
        });

        const replPromise = runReplSession(
            { ...common, repl: true },
            { stdin, stdout, stderr, events, reasoning },
        );
        stdin.write("/web --no-open\n");
        stdin.write("/learn write release notes\n");
        const deadline = Date.now() + 3000;
        while (receivedPrompts.length === 0 && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 20));
        }
        stdin.write("/quit\n");
        const replCode = await replPromise;
        assert.equal(replCode, 0);
        assert.match(replOut, /\/oauth\/handoff\?ticket=secret-ticket-4/u);
        assert.equal(receivedPrompts.length, 1);
        assert.match(receivedPrompts[0]!, /skill:\/\/plurnk\/recipes\.md/u);
        assert.match(receivedPrompts[0]!, /write release notes/u);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
        await acpServer.close();
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
    }
});

test("{§cli-model-selection} {§cli-subcommands}: runCliOnboard configures hosted API key with 0600 mode without echoing key AND configures probed local Ollama (#254)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "plurnk-onboard-test-"));
    const configHome = join(tmp, "config");
    const envPath = join(configHome, "plurnk", ".env");

    let deletedSessions: string[] = [];
    let promptCount = 0;

    const agentApp = createAcpAgent({ name: "onboard-mock" })
        .onRequest(methods.agent.initialize, async () => ({
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "@plurnk/plurnk-service", version: "6.0.0" },
            capabilities: { session: { prompt: {}, delete: {} } },
        }))
        .onRequest(methods.agent.session.new, async () => ({
            sessionId: `ephemeral-${String(promptCount + 1)}`,
            configOptions: [
                {
                    type: "select",
                    configId: "model",
                    name: "Model",
                    currentValue: "none",
                    options: [
                        { value: "deepseek", name: "deepseek" },
                        { value: "local", name: "local" },
                    ],
                },
            ],
        }))
        .onRequest(methods.agent.session.setConfigOption, async ({ params }) => ({
            configOptions: [
                {
                    type: "select",
                    configId: "model",
                    name: "Model",
                    currentValue: String(params.value),
                    options: [{ value: String(params.value), name: String(params.value) }],
                },
            ],
        }))
        .onRequest(methods.agent.session.delete, async ({ params }) => {
            deletedSessions.push(params.sessionId);
            return {};
        })
        .onRequest(
            "_plurnk/action",
            (raw) => raw as { kind: string; params?: { provider?: string } },
            async ({ params }) => {
                if (params.kind === "models.list") {
                    const currentEnv = (() => {
                        try {
                            return readFileSync(envPath, "utf8");
                        } catch {
                            return "";
                        }
                    })();
                    if (params.params?.provider === "deepseek" && currentEnv.includes("DEEPSEEK_API_KEY=")) {
                        return { items: [{ selector: "deepseek/deepseek-chat" }] };
                    }
                    return { items: [] };
                }
                return {};
            },
        )
        .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
            promptCount += 1;
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: "ok-1",
                    content: { type: "text", text: "OK" },
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
            return { messageId: "ok-1" };
        });

    const acpServer = new AcpServer({ agent: agentApp });
    const acpHandler = createNodeHttpHandler(acpServer);
    const acpHttp = http.createServer(acpHandler);
    await new Promise<void>((r) => acpHttp.listen(0, "127.0.0.1", r));
    const acpAddr = acpHttp.address();
    assert.ok(acpAddr && typeof acpAddr === "object");

    // Mock local Ollama server
    let ollamaModels: Array<{ name: string }> = [];
    const ollamaHttp = http.createServer((req, res) => {
        if (req.url === "/api/tags") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ models: ollamaModels }));
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise<void>((r) => ollamaHttp.listen(0, "127.0.0.1", r));
    const ollamaAddr = ollamaHttp.address();
    assert.ok(ollamaAddr && typeof ollamaAddr === "object");

    try {
        const common = makeCommon({
            url: `http://127.0.0.1:${String(acpAddr.port)}/acp`,
            port: acpAddr.port,
            env: {
                PLURNK_SECRET: "test-operator-secret",
                XDG_CONFIG_HOME: configHome,
            },
        });

        // 1. Hosted provider path (DeepSeek = option 4 when 0 local servers detected)
        let logOutput = "";
        const superSecretKey = "sk-super-secret-never-echo-999";
        const code1 = await runCliOnboard(common, {
            ollamaOrigin: `http://127.0.0.1:${String(ollamaAddr.port)}`,
            llamaServerOrigin: "http://127.0.0.1:9",
            write: (t) => {
                logOutput += t;
            },
            askLine: async () => "4",
            askSecret: async () => superSecretKey,
        });
        assert.equal(code1, 0);
        assert.ok(!logOutput.includes(superSecretKey), "API key must NEVER appear in output");
        const mode = statSync(envPath).mode & 0o777;
        assert.equal(mode, 0o600, ".env must be written with 0600 permissions");
        const envText1 = readFileSync(envPath, "utf8");
        assert.match(envText1, /DEEPSEEK_API_KEY=sk-super-secret-never-echo-999/u);
        assert.match(envText1, /PLURNK_MODEL_deepseek=deepseek\/deepseek-chat/u);
        assert.match(envText1, /PLURNK_MODEL=deepseek/u);
        assert.equal(promptCount, 1);
        assert.deepEqual(deletedSessions, ["ephemeral-1"]);

        // Test that even if file had looser permissions beforehand, upsertOperatorEnv tightens it back to 0600
        chmodSync(envPath, 0o644);

        // 2. Local Ollama path (appears as option 1 when Ollama reports a model)
        ollamaModels = [{ name: "qwen2.5-coder:7b" }];
        let localLog = "";
        const code2 = await runCliOnboard(common, {
            ollamaOrigin: `http://127.0.0.1:${String(ollamaAddr.port)}`,
            llamaServerOrigin: "http://127.0.0.1:9",
            write: (t) => {
                localLog += t;
            },
            askLine: async () => "", // default 1
        });
        assert.equal(code2, 0);
        assert.equal(statSync(envPath).mode & 0o777, 0o600);
        const envText2 = readFileSync(envPath, "utf8");
        assert.match(envText2, /PLURNK_MODEL_local=ollama\/qwen2\.5-coder:7b/u);
        assert.match(envText2, /PLURNK_MODEL=local/u);
        // Preserves prior DEEPSEEK_API_KEY entry without clobbering unrelated lines
        assert.match(envText2, /DEEPSEEK_API_KEY=sk-super-secret-never-echo-999/u);
        assert.match(localLog, /Local Ollama \(qwen2\.5-coder:7b/u);
        assert.equal(promptCount, 2);
        assert.deepEqual(deletedSessions, ["ephemeral-1", "ephemeral-2"]);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
        await acpServer.close();
        acpHttp.closeAllConnections();
        ollamaHttp.closeAllConnections();
        await new Promise<void>((r) => acpHttp.close(() => r()));
        await new Promise<void>((r) => ollamaHttp.close(() => r()));
    }
});
