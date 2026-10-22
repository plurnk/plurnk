import { servicePath } from "../service-checkout.ts";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { bootDaemon, locateDaemon } from "./harness.ts";

const CLIENT_BIN = resolve(import.meta.dirname, "../../bin/plurnk.js");

const listen = (server: ReturnType<typeof createServer>): Promise<number> =>
    new Promise((resolvePort, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolvePort((server.address() as { port: number }).port));
    });

const close = (server: ReturnType<typeof createServer>): Promise<void> =>
    new Promise((resolveClose, reject) => server.close((error) => error === undefined ? resolveClose() : reject(error)));

const runClient = async (
    url: string,
    args: string[],
    extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> => {
    const address = new URL(url);
    return new Promise((resolveRun, reject) => {
        const child = spawn(process.execPath, [CLIENT_BIN, ...args], {
            env: {
                ...process.env,
                HOME: resolve(import.meta.dirname, "../.client-test-home"),
                XDG_CONFIG_HOME: resolve(import.meta.dirname, "../.client-test-config"),
                PLURNK_AGUI_URL: "",
                PLURNK_HOST: address.hostname,
                PLURNK_PORT: address.port,
                NO_COLOR: "1",
                ...extraEnv,
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
        child.once("error", reject);
        child.once("exit", (code) => {
            clearTimeout(timeout);
            resolveRun({ code, stdout, stderr });
        });
    });
};

const jsonBody = async (request: IncomingMessage): Promise<{ model?: unknown; messages?: unknown }> => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    return JSON.parse(body) as { model?: unknown; messages?: unknown };
};

const answer = (response: ServerResponse, model: string, content = "````SEND [200]\nselected " + model + "\n````"): void => {
    response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
    });
    const frame = (value: unknown): void => { response.write(`data: ${JSON.stringify(value)}\n\n`); };
    frame({
        id: "model-selection",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    });
    frame({
        id: "model-selection",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    response.end("data: [DONE]\n\n");
};

test("{§cli-model-selection}: separate client invocations replace and retain one worker's durable exact route", { timeout: 120_000 }, async (t) => {
    const service = await locateDaemon();
    if (service === null) { t.skip("no plurnk-service binary reachable"); return; }

    const selectedModels: string[] = [];
    const endpoint = createServer(async (request, response) => {
        if (request.method === "GET" && request.url === "/v1/models") {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ object: "list", data: [] }));
            return;
        }
        if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
            response.writeHead(404).end();
            return;
        }
        const body = await jsonBody(request);
        if (typeof body.model !== "string") {
            response.writeHead(400).end("model is required");
            return;
        }
        selectedModels.push(body.model);
        answer(response, body.model);
    });
    const endpointPort = await listen(endpoint);
    const daemon = await bootDaemon(service, {
        readyTimeoutMs: 30_000,
        extraEnv: {
            PLURNK_MODEL: "clientdefault",
            PLURNK_MODEL_clientdefault: "openai/client-default",
            PLURNK_BASEURL_clientdefault: `http://127.0.0.1:${endpointPort}/v1`,
            OPENAI_BASE_URL: `http://127.0.0.1:${endpointPort}/v1`,
            OPENAI_API_KEY: "model-selection-test",
            PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
            PLURNK_PROVIDERS_EFFORT: "off",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
        },
    });
    t.after(async () => {
        await daemon.cleanup();
        await close(endpoint);
    });

    const common = [
        "--json",
        "--workspace", "client-model-lifecycle",
        "--worker", "durable-worker",
        "--project-root", "",
        "--max-turns", "2",
        "--timeout", "20",
    ];
    const first = await runClient(daemon.url, [...common, "Use the initial worker model."]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).response, "selected client-default");

    const exactSelector = "openai/client-family/selected";
    const changed = await runClient(daemon.url, [
        ...common,
        "--model", exactSelector,
        "Replace the existing worker model.",
    ]);
    assert.equal(changed.code, 0, changed.stderr);
    assert.equal(JSON.parse(changed.stdout).response, "selected client-family/selected");

    const requestsBeforeRefusal = selectedModels.length;
    const refused = await runClient(daemon.url, [
        ...common,
        "--model", "missing-provider/missing-model",
        "This prompt must never reach inference.",
    ]);
    assert.notEqual(refused.code, 0, "an unavailable explicit selector fails the invocation");
    assert.equal(selectedModels.length, requestsBeforeRefusal, "selection failure occurs before inference");

    const reconnected = await runClient(daemon.url, [...common, "Reconnect without selecting a model."]);
    assert.equal(reconnected.code, 0, reconnected.stderr);
    assert.equal(JSON.parse(reconnected.stdout).response, "selected client-family/selected");

    const envSelected = await runClient(
        daemon.url,
        [...common, "Select via PLURNK_CLIENT_MODEL."],
        { PLURNK_CLIENT_MODEL: "openai/client-family/from-env" },
    );
    assert.equal(envSelected.code, 0, envSelected.stderr);
    assert.equal(JSON.parse(envSelected.stdout).response, "selected client-family/from-env");
    assert.deepEqual(selectedModels, [
        "client-default",
        "client-family/selected",
        "client-family/selected",
        "client-family/from-env",
    ]);

    const requestsBeforeEffort = selectedModels.length;
    const selectedEffort = await runClient(daemon.url, ["effort", "adaptive", ...common]);
    assert.equal(selectedEffort.code, 0, selectedEffort.stderr);
    assert.equal(JSON.parse(selectedEffort.stdout).effort, "adaptive");
    const inspectedEffort = await runClient(daemon.url, ["effort", ...common]);
    assert.equal(inspectedEffort.code, 0, inspectedEffort.stderr);
    assert.deepEqual(JSON.parse(inspectedEffort.stdout), JSON.parse(selectedEffort.stdout));
    assert.equal(selectedModels.length, requestsBeforeEffort, "effort is a durable worker action, never an inference prompt");

    // {§cli-environment} — worker environment admission creates an absent worker when needed,
    // cascades PLURNK_CLIENT_ENV_INHERIT < PLURNK_CLIENT_ENV_<NAME> < --env, and fails before inference on refusal.
    const envWorkerArgs = [
        "--json",
        "--workspace", "client-model-lifecycle",
        "--worker", "env-admitted-worker",
        "--project-root", "",
        "--max-turns", "2",
        "--timeout", "20",
    ];
    const admittedEnv = await runClient(
        daemon.url,
        [
            ...envWorkerArgs,
            "--env", "TEST_INHERIT_NAME=FromFlag",
            "Run with admitted worker environment.",
        ],
        {
            TEST_INHERIT_NAME: "FromShell",
            TEST_INHERIT_EMAIL: "shell@example.com",
            PLURNK_CLIENT_ENV_INHERIT: "TEST_INHERIT_*",
            PLURNK_CLIENT_ENV_TEST_INHERIT_EMAIL: "cascade@example.com",
            PLURNK_CLIENT_ENV_COMMITTER_ROLE: "reviewer",
        },
    );
    assert.equal(admittedEnv.code, 0, admittedEnv.stderr);
    const listedEnv = await runClient(daemon.url, [
        "--json",
        "--workspace", "client-model-lifecycle",
        "--worker", "env-admitted-worker",
        "env", "list",
    ]);
    assert.equal(listedEnv.code, 0, listedEnv.stderr);
    const definitions = (JSON.parse(listedEnv.stdout) as {
        definitions: Array<{ alias: string; origin: string; state: string; definition?: { value: string } }>;
    }).definitions;
    assert.deepEqual(
        definitions
            .filter(({ origin }) => origin === "worker")
            .map(({ alias, state, definition }) => ({ alias, state, value: definition?.value })),
        [
            { alias: "COMMITTER_ROLE", state: "active", value: "reviewer" },
            { alias: "TEST_INHERIT_EMAIL", state: "active", value: "cascade@example.com" },
            { alias: "TEST_INHERIT_NAME", state: "active", value: "FromFlag" },
        ],
    );

    const requestsBeforeEnvRefusal = selectedModels.length;
    const refusedEnv = await runClient(daemon.url, [
        ...envWorkerArgs,
        "--env", "PLURNK_MODEL=illegal",
        "This prompt must never reach inference.",
    ]);
    assert.notEqual(refusedEnv.code, 0, "a reserved worker env variable fails admission");
    assert.equal(selectedModels.length, requestsBeforeEnvRefusal, "worker env admission failure occurs before inference");
});

test("[§cli-worker-ownership]: a headless owner advertises no clarification tool, so its worker's question is refused", { timeout: 120_000 }, async (t) => {
    const service = servicePath("plurnk-core/dist/service.js");
    const packets: string[] = [];
    const endpoint = createServer(async (request, response) => {
        if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
            response.writeHead(404).end();
            return;
        }
        const body = await jsonBody(request);
        packets.push(JSON.stringify(body.messages));
        answer(response, "interaction-fixture", packets.length === 1
            ? "````question\n{\"message\":\"Choose a branch\",\"requestedSchema\":{\"type\":\"object\",\"properties\":{\"branch\":{\"type\":\"string\"}},\"required\":[\"branch\"]}}\n````\n````WAIT\nAwait the branch choice.\n````"
            : "````SEND [200]\nNo input channel; continuing without a fabricated answer.\n````");
    });
    const endpointPort = await listen(endpoint);
    t.after(() => close(endpoint));
    const daemon = await bootDaemon(service, {
        readyTimeoutMs: 30_000,
        extraEnv: {
            PLURNK_MODEL: "inputfixture",
            PLURNK_MODEL_inputfixture: "openai/interaction-fixture",
            PLURNK_BASEURL_inputfixture: `http://127.0.0.1:${endpointPort}/v1`,
            OPENAI_API_KEY: "input-fixture",
            PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
            PLURNK_PROVIDERS_EFFORT: "off",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
        },
    });
    t.after(daemon.cleanup);
    const result = await runClient(daemon.url, [
        "--json", "--yolo", "--workspace", "cli-input", "--worker", "input-worker",
        "--project-root", "", "--max-turns", "3", "--timeout", "20", "Choose a branch.",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).response, "No input channel; continuing without a fabricated answer.");
    assert.equal(packets.length, 2, "the refusal neither loses nor restarts the worker loop");
    assert.match(packets[1]!, /capability-denied/u, "the daemon refuses a tool the worker's owner does not receive");
    assert.match(packets[1]!, /Nobody is present to answer/u, "and the refusal says what to do instead");
});
