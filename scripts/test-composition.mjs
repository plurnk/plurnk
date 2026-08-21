// Packed client/service composition gate (#630). The client candidate and an
// explicit service artifact are installed into an empty consumer directory,
// then exercised through the public CLI and AG-UI listener. A deterministic
// local OpenAI-compatible endpoint supplies grammar-valid model turns.
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const temp = await mkdtemp(join(tmpdir(), "plurnk-composition-"));
const install = join(temp, "consumer");
const home = join(temp, "home");
const serviceSpec = process.env.PLURNK_COMPOSITION_SERVICE ?? "@plurnk/plurnk-service@latest";
const clientSpec = process.env.PLURNK_COMPOSITION_CLIENT;

const listen = (server) => new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => accept(server.address().port));
});
const stop = async (child) => {
    if (child === undefined || child.exitCode !== null) return;
    const exited = new Promise((accept) => child.once("exit", accept));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((accept) => setTimeout(accept, 5_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited;
};
const runClient = (file, args, options) => new Promise((accept, reject) => {
    const child = spawn(file, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), options.timeout);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
        clearTimeout(timer);
        if (code === 0) accept({ stdout, stderr });
        else reject(new Error(`client exited ${code ?? signal}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
});

let daemon;
let model;
let passed = false;
const modelRequests = [];
const selectedModels = [];
try {
    await run("npm", ["init", "-y"], { cwd: temp });
    await mkdir(install, { recursive: true });
    await mkdir(home, { recursive: true });
    await run("npm", ["init", "-y"], { cwd: install });

    let installedClient = clientSpec;
    if (installedClient === undefined) {
        await run("npm", ["run", "build"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
        const packed = JSON.parse((await run("npm", [
            "pack", "--ignore-scripts", "--json", "--pack-destination", temp,
        ], { cwd: root, maxBuffer: 64 * 1024 * 1024 })).stdout);
        if (!Array.isArray(packed) || typeof packed[0]?.filename !== "string") throw new Error("npm pack returned no client artifact");
        installedClient = join(temp, packed[0].filename);
    }
    await run("npm", ["install", "--ignore-scripts", installedClient, serviceSpec], {
        cwd: install,
        maxBuffer: 64 * 1024 * 1024,
    });

    model = createServer((req, res) => {
        modelRequests.push(`${req.method} ${req.url}`);
        if (req.method === "GET" && req.url === "/v1/models") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({
                object: "list",
                data: ["composition", "composition-family/selected"].map((id) => ({
                    id,
                    object: "model",
                    owned_by: "plurnk-test",
                })),
            }));
            return;
        }
        if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
            res.statusCode = 404;
            res.end();
            return;
        }
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk) => { body += chunk; });
        req.once("end", () => {
            const request = JSON.parse(body);
            selectedModels.push(request.model);
            const response = `# PLAN0\nVerify the packed client and service compose.\n## SEND0 [200]\ncomposition ok: ${request.model}`;
            res.writeHead(200, {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                connection: "keep-alive",
            });
            const frame = (value) => res.write(`data: ${JSON.stringify(value)}\n\n`);
            frame({
                id: "composition", object: "chat.completion.chunk", created: 1, model: request.model,
                choices: [{ index: 0, delta: { role: "assistant", content: response }, finish_reason: null }],
            });
            frame({
                id: "composition", object: "chat.completion.chunk", created: 1, model: request.model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            });
            res.end("data: [DONE]\n\n");
        });
    });
    const modelPort = await listen(model);

    const daemonBin = join(install, "node_modules", ".bin", "plurnk-service");
    const clientBin = join(install, "node_modules", ".bin", "plurnk");
    const db = join(temp, "composition.db");
    daemon = spawn(daemonBin, ["start"], {
        cwd: install,
        env: {
            ...process.env,
            HOME: home,
            PLURNK_HOST: "127.0.0.1",
            PLURNK_PORT: "0",
            PLURNK_SERVICE_DB_PATH: db,
            PLURNK_SERVICE_EMBED_DISABLE: "1",
            PLURNK_SCHEMES_HTTP_PLAYWRIGHT_METHOD: "disabled",
            PLURNK_MODEL: "composition",
            PLURNK_MODEL_composition: "openai/composition",
            PLURNK_BASEURL_composition: `http://127.0.0.1:${modelPort}/v1`,
            OPENAI_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
            OPENAI_API_KEY: "composition",
            PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
            PLURNK_PROVIDERS_REASONING: "off",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    daemon.stdout.setEncoding("utf8");
    daemon.stderr.setEncoding("utf8");
    daemon.stdout.on("data", (chunk) => { stdout += chunk; });
    daemon.stderr.on("data", (chunk) => { stderr += chunk; });
    const address = await new Promise((accept, reject) => {
        const timeout = setTimeout(() => reject(new Error(`service boot timeout\nstdout:\n${stdout}\nstderr:\n${stderr}`)), 30_000);
        const inspect = () => {
            const match = stdout.match(/agui=http:\/\/([^:]+):(\d+)/);
            if (match === null) return;
            clearTimeout(timeout);
            accept({ host: match[1], port: match[2] });
        };
        daemon.stdout.on("data", inspect);
        daemon.once("exit", (code) => {
            clearTimeout(timeout);
            reject(new Error(`service exited ${code} before ready\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        });
    });

    const env = {
        ...process.env,
        HOME: home,
        PLURNK_HOST: address.host,
        PLURNK_PORT: address.port,
    };
    const runPrompt = async (prompt, selector) => {
        let completed;
        try {
            completed = await runClient(clientBin, [
                "--json", "--workspace", "packed-composition", "--worker", "durable-worker",
                "--project-root", "", "--max-turns", "2", "--timeout", "20",
                ...(selector === undefined ? [] : ["--model", selector]),
                prompt,
            ], { cwd: install, env, timeout: 30_000 });
        } catch (cause) {
            throw new Error(
                `packed client run failed\nmodel requests: ${modelRequests.join(", ") || "(none)"}\nservice stdout:\n${stdout}\nservice stderr:\n${stderr}`,
                { cause },
            );
        }
        return JSON.parse(completed.stdout);
    };

    const seeded = await runPrompt("Seed the existing worker on the daemon default.");
    if (seeded.response !== "composition ok: composition") {
        throw new Error(`default packed run returned ${JSON.stringify(seeded.response)}`);
    }

    const exactSelector = "openai/composition-family/selected";
    const selected = await runPrompt("Select an exact model route for this worker.", exactSelector);
    if (selected.response !== "composition ok: composition-family/selected") {
        throw new Error(`selected packed run returned ${JSON.stringify(selected.response)}`);
    }

    const requestsBeforeRefusal = selectedModels.length;
    await runClient(clientBin, [
        "--json", "--workspace", "packed-composition", "--worker", "durable-worker",
        "--project-root", "", "--model", "missing-provider/missing-model",
        "This prompt must never reach a model.",
    ], { cwd: install, env, timeout: 30_000 }).then(
        () => { throw new Error("an unavailable explicit model selector was accepted"); },
        () => undefined,
    );
    if (selectedModels.length !== requestsBeforeRefusal) {
        throw new Error("a rejected explicit model selector still generated a model request");
    }

    const reconnected = await runPrompt("Reconnect without selecting a model.");
    if (reconnected.response !== "composition ok: composition-family/selected") {
        throw new Error(`reconnected packed run returned ${JSON.stringify(reconnected.response)}`);
    }
    const expectedModels = ["composition", "composition-family/selected", "composition-family/selected"];
    if (JSON.stringify(selectedModels) !== JSON.stringify(expectedModels)) {
        throw new Error(`worker model lifecycle selected ${JSON.stringify(selectedModels)}, expected ${JSON.stringify(expectedModels)}`);
    }

    const log = await runClient(clientBin, [
        "log", "read", "--json", "--workspace", "packed-composition", "--worker", "durable-worker", "--limit", "100",
    ], { cwd: install, env, timeout: 30_000 });
    const rows = JSON.parse(log.stdout);
    const entries = Array.isArray(rows) ? rows : rows.entries;
    if (!Array.isArray(entries) || !entries.some((entry) =>
        Number.isInteger(entry.worker_id) && Number.isInteger(entry.loop_id) && Number.isInteger(entry.turn_id))) {
        throw new Error(`packed run created no durable worker/loop/turn log entry; log.read returned ${log.stdout.trim()}`);
    }

    const clientPackage = JSON.parse(await readFile(join(install, "node_modules", "@plurnk", "plurnk", "package.json"), "utf8"));
    const servicePackage = JSON.parse(await readFile(join(install, "node_modules", "@plurnk", "plurnk-service", "package.json"), "utf8"));
    console.log(`packed composition GREEN: ${clientPackage.name}@${clientPackage.version} + ${servicePackage.name}@${servicePackage.version}`);
    passed = true;
} finally {
    await stop(daemon);
    if (model !== undefined) await new Promise((accept) => model.close(accept));
    if (passed) await rm(temp, { recursive: true, force: true });
    else process.stderr.write(`packed composition evidence preserved at ${temp}\n`);
}
