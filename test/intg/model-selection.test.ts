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
    extraEnv: Record<string, string> = {},
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

const answer = (response: ServerResponse, model: string, content = "````SEND\nselected " + model + "\n````"): void => {
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

test("{§cli-what-one-shot-mode-does-not-do}: a built one-shot client cancels input requests and the worker resumes with that result", { timeout: 120_000 }, async (t) => {
    const service = resolve(import.meta.dirname, "../../../plurnk-service/plurnk-core/dist/service.js");
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
            : "````SEND\nNo input channel; continuing without a fabricated answer.\n````");
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
            PLURNK_PROVIDERS_REASONING: "off",
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
    assert.equal(packets.length, 2, "the interaction resolves without losing or restarting the worker loop");
    assert.match(packets[1]!, /\\"action\\": ?\\"cancel\\"/, "the next model packet contains the actual tool cancellation");
    assert.doesNotMatch(packets[1]!, /capability-denied|interaction-denied/, "input topology is not a workspace permission change");
});

// {§loop-attendance} — the seam nothing else covers: the client tests prove the policy reaches
// forwardedProps, the service tests prove behaviour given a policy, and only this proves they meet.
// `--auto` asserts nobody is watching, so the daemon must refuse the question outright rather than
// write it down and wait (plurnk/plurnk-service#765).
test("[§cli-invocation] {§loop-attendance} --auto is refused an interactive partner, and says so in one turn", { timeout: 60_000 }, async (t) => {
    const service = resolve(import.meta.dirname, "../../../plurnk-service/plurnk-core/dist/service.js");
    const packets: string[] = [];
    const endpoint = createServer(async (request, response) => {
        if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
            response.writeHead(404).end();
            return;
        }
        const body = await jsonBody(request);
        packets.push(JSON.stringify(body.messages));
        answer(response, "interaction-fixture", packets.length === 1
            ? "````question\n{\"message\":\"Choose a branch\",\"requestedSchema\":{\"type\":\"object\",\"properties\":{\"branch\":{\"type\":\"string\"}},\"required\":[\"branch\"]}}\n````\n\n````WAIT\nawait the answer\n````"
            : "````SEND\nNobody could answer; concluding on what I have.\n````");
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
            PLURNK_PROVIDERS_REASONING: "off",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
            // The question runtime stays REGISTERED: this proves attendance refuses it, not the
            // operator's executor switch, which is the only thing that protected a headless run before.
            PLURNK_EXECS_QUESTION: "1",
        },
    });
    t.after(daemon.cleanup);

    const started = Date.now();
    const result = await runClient(daemon.url, [
        "--json", "--auto", "--workspace", "cli-auto-unattended", "--worker", "auto-worker",
        "--project-root", "", "--max-turns", "3", "--timeout", "30", "Choose a branch.",
    ]);
    const elapsed = Date.now() - started;

    assert.equal(result.code, 0, result.stderr);
    const record = JSON.parse(result.stdout);
    assert.equal(record.timedOut, false, "the run ends on its own, never on the client's clock");
    assert.ok(elapsed < 25_000, `the refusal is immediate, not a wait: took ${elapsed}ms of a 30s budget`);
    assert.equal(record.response, "Nobody could answer; concluding on what I have.");
    assert.equal(packets.length, 2, "the model asked once, was refused, and concluded — no third turn");
    // The refusal comes from the cascade's loop ring, and names both the ring and what to do
    // instead: a tool that vanished must say why, or the model has learned nothing.
    assert.match(packets[1]!, /loop policy/, "the refusal names the ring that subtracted the tool");
    assert.match(packets[1]!, /unattended/, "and the reason, in terms the model can act on");
    assert.match(packets[1]!, /conclude stating what you could not resolve/, "and the recovery");
});

// The client states and the daemon composes: only this proves the refusals a user can meet arrive
// as sentences that name the way out.
test("[§cli-loop-policy] a refused statement and a retired spelling each name the way out", { timeout: 60_000 }, async (t) => {
    const service = resolve(import.meta.dirname, "../../../plurnk-service/plurnk-core/dist/service.js");
    const daemon = await bootDaemon(service, {
        readyTimeoutMs: 30_000,
        extraEnv: {
            PLURNK_MODEL: "unreached",
            PLURNK_MODEL_unreached: "openai/never-called",
            PLURNK_BASEURL_unreached: "http://127.0.0.1:9/v1",
            OPENAI_API_KEY: "unreached",
            PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
        },
    });
    t.after(daemon.cleanup);
    const base = ["--json", "--workspace", "cli-loop-policy", "--worker", "policy-worker", "--project-root", "", "--timeout", "20"];

    // Review with nobody attending is a wait nothing could end, so the daemon refuses the statement.
    const contradiction = await runClient(daemon.url, [...base, "--auto", "--proposals", "review", "Do the thing."]);
    assert.notEqual(contradiction.code, 0);
    const refused = JSON.parse(contradiction.stdout).problem;
    assert.match(refused.type, /loop-policy-invalid$/u);
    assert.match(refused.detail, /unattended loop cannot hold a proposal for review: nobody is present to answer/u);
    assert.equal(refused.recovery, "State proposals accept or reject, or attend the loop.");

    const vocabulary = await runClient(daemon.url, [...base, "--proposals", "sometimes", "Do the thing."]);
    assert.equal(vocabulary.code, 64);
    assert.match(vocabulary.stderr + vocabulary.stdout, /proposals must be one of review, accept, reject/u);

    const flag = await runClient(daemon.url, [...base, "--policy", "{\"proposals\":\"accept\"}", "Do the thing."]);
    assert.equal(flag.code, 64);
    assert.match(flag.stderr + flag.stdout, /--policy was retired; state --proposals <review\|accept\|reject> and --auto/u);

    for (const [name, successor] of [["PLURNK_AUTO", "PLURNK_CLIENT_AUTO"], ["PLURNK_CLIENT_LOOP_POLICY", "PLURNK_CLIENT_PROPOSALS and PLURNK_CLIENT_AUTO"]] as const) {
        const retired = await runClient(daemon.url, [...base, "Do the thing."], { [name]: "1" });
        assert.equal(retired.code, 64, name);
        assert.match(retired.stderr + retired.stdout, new RegExp(`${name} was retired; use ${successor}`, "u"));
    }
});
