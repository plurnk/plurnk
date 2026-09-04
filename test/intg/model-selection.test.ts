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

const jsonBody = async (request: IncomingMessage): Promise<{ model?: unknown }> => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    return JSON.parse(body) as { model?: unknown };
};

const answer = (response: ServerResponse, model: string): void => {
    const content = `## PLAN0\n[{"content":"Confirm the selected route.","status":"completed"}]\n### SEND0 (TERM)\nselected ${model}`;
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
            PLURNK_PROVIDERS_REASONING: "off",
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
    assert.deepEqual(selectedModels, [
        "client-default",
        "client-family/selected",
        "client-family/selected",
    ]);
});
