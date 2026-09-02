// Packed client/web composition gate. Installs both candidates into an empty
// consumer, launches the public `plurnk web` command, and verifies its resolved
// invocation at the AG-UI boundary without running a model.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { HttpAgent } from "@ag-ui/client";

const run = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const temp = await mkdtemp(join(tmpdir(), "plurnk-web-composition-"));
const consumer = join(temp, "consumer");
const configHome = join(temp, "config");
const projectRoot = join(temp, "project");
const webRoot = process.env.PLURNK_COMPOSITION_WEB_ROOT;
const webSpec = process.env.PLURNK_COMPOSITION_WEB ?? "@plurnk/plurnk-web@latest";

const listen = (server) => new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        assert(address !== null && typeof address !== "string");
        accept(address.port);
    });
});

const close = (server) => new Promise((accept, reject) => {
    server.close((cause) => cause === undefined ? accept() : reject(cause));
});

const stop = async (child) => {
    if (child === undefined || child.exitCode !== null) return;
    const exited = new Promise((accept) => child.once("exit", accept));
    child.kill("SIGTERM");
    await Promise.race([exited, new Promise((accept) => setTimeout(accept, 5_000))]);
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited;
};

const pack = async (packageRoot) => {
    await run("npm", ["run", "build"], { cwd: packageRoot, maxBuffer: 128 * 1024 * 1024 });
    const packed = JSON.parse((await run("npm", [
        "pack", "--ignore-scripts", "--json", "--pack-destination", temp,
    ], { cwd: packageRoot, maxBuffer: 128 * 1024 * 1024 })).stdout);
    assert(Array.isArray(packed) && typeof packed[0]?.filename === "string", "npm pack returned no artifact");
    return join(temp, packed[0].filename);
};

const readRequest = (request) => new Promise((accept, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.once("end", () => {
        try { accept(JSON.parse(body)); } catch (cause) { reject(cause); }
    });
    request.once("error", reject);
});

const sendEvents = (response, input, events = []) => {
    response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
    });
    const send = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
    for (const event of events) send(event);
    send({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId, outcome: { type: "success" } });
    response.end();
};

const collect = (agent, input) => new Promise((accept, reject) => {
    const events = [];
    agent.run(input).subscribe({
        next: (event) => events.push(event),
        error: reject,
        complete: () => accept(events),
    });
});

let upstream;
let client;
let passed = false;
const inputs = [];
try {
    await mkdir(consumer, { recursive: true });
    await mkdir(configHome, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await run("npm", ["init", "-y"], { cwd: consumer });

    const clientArtifact = await pack(root);
    const webArtifact = webRoot === undefined ? webSpec : await pack(resolve(webRoot));
    await run("npm", ["install", "--ignore-scripts", clientArtifact, webArtifact], {
        cwd: consumer,
        maxBuffer: 128 * 1024 * 1024,
    });

    upstream = createServer((request, response) => {
        void readRequest(request).then((input) => {
            inputs.push(input);
            const action = input.forwardedProps?.plurnk?.action;
            if (action !== undefined) {
                const result = action.kind === "workspace.create"
                    ? { id: 1, name: action.name ?? "minted", workerId: 1 }
                    : action.kind === "workspace.workers"
                        ? { workers: [{ id: 1, name: input.threadId, created_at: "now", origin: "client", parentWorkerId: null }] }
                        : action.kind === "workspace.list"
                            ? { workspaces: [{ id: 1, name: "web-composition", project_root: projectRoot, created_at: "now" }] }
                            : {};
                sendEvents(response, input, [{
                    type: "CUSTOM",
                    name: "plurnk.action.result",
                    value: { kind: action.kind, ok: true, result },
                }]);
                return;
            }
            sendEvents(response, input, [
                { type: "TEXT_MESSAGE_START", messageId: "answer", role: "assistant" },
                { type: "TEXT_MESSAGE_CONTENT", messageId: "answer", delta: "web composition ok" },
                { type: "TEXT_MESSAGE_END", messageId: "answer" },
            ]);
        }).catch((cause) => {
            response.statusCode = 500;
            response.end(String(cause));
        });
    });
    const upstreamPort = await listen(upstream);

    const reservation = createServer();
    const portalPort = await listen(reservation);
    await close(reservation);

    await writeFile(join(consumer, ".env"), [
        "PLURNK_CLIENT_WORKSPACE=web-composition",
        "PLURNK_CLIENT_WORKER=browser",
        "PLURNK_CLIENT_YOLO=1",
        "PLURNK_WEB_HOST=127.0.0.1",
        `PLURNK_WEB_PORT=${portalPort}`,
        "",
    ].join("\n"));

    const environment = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith("PLURNK_")),
    );
    const bin = join(consumer, "node_modules", ".bin", "plurnk");
    client = spawn(bin, [
        "web",
        "--model=fireox",
        "--reasoning=low",
        `--project-root=${projectRoot}`,
        "--files-items=3",
        "--max-commands=12",
        "--no-git",
        "--capabilities={\"deny\":[{\"operation\":\"EXEC\"}]}",
        "--policy={\"capabilities\":{},\"proposals\":\"review\"}",
        "--max-turns=7",
    ], {
        cwd: consumer,
        env: {
            ...environment,
            HOME: temp,
            XDG_CONFIG_HOME: configHome,
            PLURNK_AGUI_URL: `http://127.0.0.1:${upstreamPort}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    client.stdout.setEncoding("utf8");
    client.stderr.setEncoding("utf8");
    client.stdout.on("data", (chunk) => { stdout += chunk; });
    client.stderr.on("data", (chunk) => { stderr += chunk; });
    const portalOrigin = await new Promise((accept, reject) => {
        const timer = setTimeout(() => reject(new Error(
            `plurnk web did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        )), 30_000);
        const inspect = () => {
            const match = stderr.match(/plurnk web: (http:\/\/[^\s]+)/);
            if (match === null) return;
            clearTimeout(timer);
            accept(match[1]);
        };
        client.stderr.on("data", inspect);
        client.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`plurnk web exited ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        });
    });

    const bootstrap = await (await fetch(
        `${portalOrigin}/bootstrap.json?path=${encodeURIComponent("/web-composition/browser")}`,
    )).json();
    assert.deepEqual(bootstrap, {
        runtimeUrl: "/api/copilotkit",
        agentId: "default",
        workspace: "web-composition",
        threadId: "browser",
        runtimeThreadId: JSON.stringify(["web-composition", "browser"]),
        canonicalPath: "/web-composition/browser",
        workspaceLocked: true,
        workerLocked: true,
        workspaces: ["web-composition"],
        workers: ["browser"],
        autoAcceptProposals: true,
    });

    const agent = new HttpAgent({ url: `${portalOrigin}/api/copilotkit/agent/default/run` });
    const runInput = {
        threadId: bootstrap.runtimeThreadId,
        runId: "web-composition-run",
        state: {},
        messages: [{ id: "prompt", role: "user", content: "exercise the browser path" }],
        tools: [],
        context: [],
        forwardedProps: {},
    };
    const events = await collect(agent, runInput);
    assert(events.some((event) => event.type === "TEXT_MESSAGE_CONTENT" && event.delta === "web composition ok"));

    assert.equal(inputs.length, 6);
    assert.deepEqual(inputs[0].forwardedProps.plurnk, {
        action: {
            kind: "workspace.create",
            name: "web-composition",
            projectRoot,
            settings: {
                capabilities: { deny: [{ operation: "EXEC" }] },
                maxCommands: 12,
                git: false,
                filesItems: 3,
            },
        },
    });
    assert.deepEqual(inputs[1].forwardedProps.plurnk, {
        workspace: "web-composition",
        projectRoot,
        settings: {
            capabilities: { deny: [{ operation: "EXEC" }] },
            maxCommands: 12,
            git: false,
            filesItems: 3,
        },
        action: { kind: "workspace.workers" },
    });
    assert.deepEqual(inputs[2].forwardedProps.plurnk, {
        workspace: "web-composition",
        projectRoot,
        settings: {
            capabilities: { deny: [{ operation: "EXEC" }] },
            maxCommands: 12,
            git: false,
            filesItems: 3,
        },
        action: { kind: "worker.model.set", selector: "fireox" },
    });
    assert.deepEqual(inputs[3].forwardedProps.plurnk, {
        workspace: "web-composition",
        projectRoot,
        settings: {
            capabilities: { deny: [{ operation: "EXEC" }] },
            maxCommands: 12,
            git: false,
            filesItems: 3,
        },
        action: { kind: "worker.reasoning.set", policy: "low" },
    });
    assert.deepEqual(inputs[4].forwardedProps.plurnk, {
        action: { kind: "workspace.list" },
    });
    assert.deepEqual(inputs[5].forwardedProps.plurnk, {
        workspace: "web-composition",
        projectRoot,
        settings: {
            capabilities: { deny: [{ operation: "EXEC" }] },
            maxCommands: 12,
            git: false,
            filesItems: 3,
        },
        policy: { capabilities: {}, proposals: "review" },
        maxTurns: 7,
    });

    const clientPackage = JSON.parse(await readFile(join(consumer, "node_modules", "@plurnk", "plurnk", "package.json"), "utf8"));
    const webPackage = JSON.parse(await readFile(join(consumer, "node_modules", "@plurnk", "plurnk-web", "package.json"), "utf8"));
    process.stdout.write(`packed web composition GREEN: ${clientPackage.name}@${clientPackage.version} + ${webPackage.name}@${webPackage.version}\n`);
    passed = true;
} finally {
    await stop(client);
    if (upstream !== undefined) await close(upstream);
    if (passed) await rm(temp, { recursive: true, force: true });
    else process.stderr.write(`packed web composition evidence preserved at ${temp}\n`);
}
