// Packed client/service composition gate (#630). The client candidate and its
// optional backend are installed into an empty consumer directory,
// then exercised through the public CLI and AG-UI listener. A deterministic
// local OpenAI-compatible endpoint supplies grammar-valid model turns.
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, readdir, rm, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const temp = await mkdtemp(join(tmpdir(), "plurnk-composition-"));
const install = join(temp, "consumer");
const home = join(temp, "home");
const serviceSpec = process.env.PLURNK_COMPOSITION_SERVICE;
const serviceRoot = process.env.PLURNK_COMPOSITION_SERVICE_ROOT;
const clientSpec = process.env.PLURNK_COMPOSITION_CLIENT;

const listen = (server) => new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => accept(server.address().port));
});
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
const scriptedResponses = [];
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
    let serviceSpecs = serviceSpec === undefined ? [] : [serviceSpec];
    if (serviceRoot !== undefined && serviceRoot.length > 0) {
        const absoluteServiceRoot = resolve(serviceRoot);
        await run("npm", ["run", "build"], {
            cwd: absoluteServiceRoot,
            maxBuffer: 128 * 1024 * 1024,
        });
        const packed = JSON.parse((await run("npm", [
            "pack", "--workspaces", "--ignore-scripts", "--json", "--pack-destination", temp,
        ], { cwd: absoluteServiceRoot, maxBuffer: 128 * 1024 * 1024 })).stdout);
        if (!Array.isArray(packed) || packed.some((item) => typeof item?.filename !== "string")) {
            throw new Error("npm pack returned an invalid service workspace artifact set");
        }
        serviceSpecs = packed.map(({ filename }) => join(temp, filename));
    }
    await run("npm", ["install", "--ignore-scripts", installedClient, ...serviceSpecs], {
        cwd: install,
        maxBuffer: 64 * 1024 * 1024,
    });
    if (serviceSpecs.length === 0) {
        const consumer = JSON.parse(await readFile(join(install, "package.json"), "utf8"));
        if (Object.hasOwn(consumer.dependencies, "@plurnk/plurnk-service")) {
            throw new Error("the one-package install must obtain its backend through the client's optional dependency");
        }
    }

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
            const response = scriptedResponses.shift()
                // {§kill-conclusion}: final-answer fixtures conclude with parameterless KILL.
                ?? `\`\`\`\`KILL\ncomposition ok: ${request.model}
\`\`\`\``;
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
    const { default: Launch } = await import(pathToFileURL(
        createRequire(join(install, "package.json")).resolve("@plurnk/plurnk-service/launch"),
    ).href);
    const isolatedEnv = {
        ...Object.fromEntries(Object.entries(process.env)
            .filter(([key]) => !/^PLURNK_/.test(key) && !/_(API_KEY|BASE_URL)$/.test(key))),
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_STATE_HOME: join(home, ".local", "state"),
        XDG_CACHE_HOME: join(home, ".cache"),
    };
    const serviceEnv = {
            ...isolatedEnv,
            PLURNK_SCHEMES_HTTP_PLAYWRIGHT_METHOD: "disabled",
            PLURNK_MODEL: "composition",
            PLURNK_MODEL_composition: "openai/composition",
            PLURNK_BASEURL_composition: `http://127.0.0.1:${modelPort}/v1`,
            OPENAI_BASE_URL: `http://127.0.0.1:${modelPort}/v1`,
            OPENAI_API_KEY: "composition",
            PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
            PLURNK_PROVIDERS_EFFORT: "off",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    };
    daemon = await Launch.start({
        command: [daemonBin, "start"],
        cwd: install,
        env: serviceEnv,
        stateRoot: join(temp, "state"),
        host: "127.0.0.1",
        port: 0,
        readyTimeoutMs: 30_000,
        stopGraceMs: 5_000,
    }).catch((cause) => {
        throw new Error(`service startup failed\nstdout:\n${cause.stdout ?? ""}\nstderr:\n${cause.stderr ?? ""}`, { cause });
    });

    const env = {
        ...isolatedEnv,
        PLURNK_HOST: daemon.host,
        PLURNK_PORT: String(daemon.port),
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
                `packed client run failed\nmodel requests: ${modelRequests.join(", ") || "(none)"}\nservice stdout:\n${daemon.stdout()}\nservice stderr:\n${daemon.stderr()}`,
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

    const delegatedRoot = join(temp, "delegated-root");
    await mkdir(delegatedRoot, { recursive: true });
    scriptedResponses.push(
        "````WORK (worker://guesser1)\nCreate child.txt and conclude.\n````\n"
            + "````WAIT\nWaiting for guesser1.\n````",
        "````EDIT (child.txt)\ncreated by packed child\n````\n"
            + "````NOTE\nConfirming the write.\n````",
        "````KILL\nChild work complete.\n````",
        "````KILL\npacked descendant proposal complete\n````",
    );
    const requestsBeforeDelegation = selectedModels.length;
    const delegated = await runClient(clientBin, [
        "--json", "--yolo", "--workspace", "packed-delegation", "--worker", "delegation-parent",
        "--project-root", delegatedRoot, "--max-turns", "8", "--timeout", "30",
        "Exercise descendant proposal composition.",
    ], { cwd: install, env, timeout: 45_000 });
    const delegatedResult = JSON.parse(delegated.stdout);
    const parentLifecycle = delegatedResult.turns?.flatMap(({ ops }) => ops)
        .filter(({ op, origin }) => ["WAIT", "KILL", "SEND", "FAIL"].includes(op) && origin === "model");
    // Settlement may beat parking; either outcome must admit the unscoped WAIT. The parameterless
    // KILL that follows is the conclusion and carries the answer ({§kill-conclusion}); the daemon
    // mints no SEND row for it (platform 1.20.0).
    if (parentLifecycle?.length !== 2 || ![102, 202].includes(parentLifecycle[0].status)
        || parentLifecycle[0].op !== "WAIT" || parentLifecycle[1].op !== "KILL"
        || parentLifecycle[1].status !== 200 || parentLifecycle.some(({ scope }) => scope !== null)) {
        throw new Error(`descendant proposal did not admit and settle its parent's wait: ${JSON.stringify(parentLifecycle)}`);
    }
    if (delegatedResult.response !== "packed descendant proposal complete") {
        throw new Error(`descendant proposal run returned ${JSON.stringify(delegatedResult.response)}`);
    }
    if (await readFile(join(delegatedRoot, "child.txt"), "utf8") !== "created by packed child") {
        throw new Error("client yolo did not apply the descendant child's exact EDIT proposal");
    }
    if (scriptedResponses.length !== 0 || selectedModels.length - requestsBeforeDelegation !== 4) {
        throw new Error(
            `descendant proposal used ${selectedModels.length - requestsBeforeDelegation} provider requests with ${scriptedResponses.length} scripted responses left`,
        );
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

    // {§cli-daemon-autostart}: the installed client discovers the installed service,
    // launches privately, retains its state, and stops it without a pre-launched daemon.
    const privateEnv = { ...serviceEnv, PLURNK_HOST: "127.0.0.1", PLURNK_PORT: "0", PLURNK_AGUI_URL: "" };
    const privateRun = await runClient(clientBin, ["--json", "--workspace", "private-composition", "--worker", "primary", "--project-root", "", "Confirm private startup."], {
        cwd: install, env: privateEnv, timeout: 30_000,
    });
    if (JSON.parse(privateRun.stdout).response !== "composition ok: composition" || privateRun.stderr !== "") {
        throw new Error(`private packed run failed: ${privateRun.stdout}\n${privateRun.stderr}`);
    }
    const roots = await readdir(join(isolatedEnv.XDG_DATA_HOME, "plurnk", "instances"));
    if (roots.length !== 1) throw new Error(`private startup allocated ${roots.length} roots`);
    const stateRoot = join(isolatedEnv.XDG_DATA_HOME, "plurnk", "instances", roots[0]);
    const database = join(stateRoot, "data", "plurnk", "plurnk.db");
    await access(database);
    await access(`${database}.lock`).then(
        () => { throw new Error("private backend still owns its database after client exit"); },
        (cause) => { if (cause.code !== "ENOENT") throw cause; },
    );
    const resumed = await runClient(clientBin, ["log", "read", "--json", "--workspace", "private-composition", "--worker", "primary"], {
        cwd: install, env: { ...privateEnv, PLURNK_SERVICE_STATE_ROOT: stateRoot, PLURNK_SERVICE_DB_PATH: database }, timeout: 30_000,
    });
    if (!resumed.stdout.includes("composition ok: composition")) throw new Error("private conversation was not retained across daemon lifetimes");

    const clientPackage = JSON.parse(await readFile(join(install, "node_modules", "@plurnk", "plurnk", "package.json"), "utf8"));
    const servicePackage = JSON.parse(await readFile(join(install, "node_modules", "@plurnk", "plurnk-service", "package.json"), "utf8"));
    JSON.parse(await readFile(join(
        install,
        "node_modules",
        "@plurnk",
        "plurnk-contracts",
        "dist",
        "conformance",
        "agui-v1.json",
    ), "utf8"));
    console.log(`packed composition GREEN: ${clientPackage.name}@${clientPackage.version} + ${servicePackage.name}@${servicePackage.version}`);
    passed = true;
} finally {
    await daemon?.stop();
    if (model !== undefined) await new Promise((accept) => model.close(accept));
    if (passed) await rm(temp, { recursive: true, force: true });
    else process.stderr.write(`packed composition evidence preserved at ${temp}\n`);
}
