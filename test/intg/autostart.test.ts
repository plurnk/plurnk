import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { bootDaemon, locateDaemon } from "./harness.ts";

const run = promisify(execFile);
const bin = resolve(import.meta.dirname, "../../bin/plurnk.js");

const fixture = async (t: { after(fn: () => Promise<void>): void }, service: string) => {
    const resources = new AsyncDisposableStack();
    const directory = await mkdtemp(join(tmpdir(), "plurnk-autostart-"));
    resources.defer(() => rm(directory, { recursive: true, force: true }));
    t.after(() => resources.disposeAsync());
    const project = join(directory, "project");
    await mkdir(project);
    const env = {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PLURNK_/u.test(key) && !/_(API_KEY|BASE_URL)$/u.test(key))),
        HOME: directory,
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_DATA_HOME: join(directory, "data"),
        XDG_STATE_HOME: join(directory, "state"),
        XDG_CACHE_HOME: join(directory, "cache"),
        PLURNK_HOST: "127.0.0.1",
        PLURNK_PORT: "0",
        PLURNK_AGUI_URL: "",
        PLURNK_MODEL: "",
        PLURNK_CLIENT_SERVICE_BIN: service,
        NO_COLOR: "1",
    };
    const invoke = (args: string[], extra: NodeJS.ProcessEnv = {}) => run(process.execPath, [bin, ...args], {
        cwd: project, env: { ...env, ...extra }, timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
    });
    return { directory, project, env, invoke, resources };
};

test("[§cli-daemon-autostart] the built client starts a private installed backend, retains its state and resumes it", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    if (service === null) { t.skip("no service checkout available"); return; }
    const { directory, project, invoke } = await fixture(t, service);
    const listener = createServer();
    await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
    const address = listener.address();
    assert.ok(address !== null && typeof address === "object");
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const first = await invoke(["workspace", "list", "--json"], { PLURNK_PORT: String(address.port) });
    assert.equal(first.stderr, "", "JSON mode retains its silent stderr contract");
    assert.deepEqual(JSON.parse(first.stdout), []);
    const roots = await readdir(join(directory, "data", "plurnk", "instances"));
    assert.equal(roots.length, 1, "exactly one independent state root was allocated");
    const stateRoot = join(directory, "data", "plurnk", "instances", roots[0]!);
    const database = join(stateRoot, "data", "plurnk", "plurnk.db");
    assert.ok((await readFile(database)).length > 0, "shutdown retained the database");
    await assert.rejects(readFile(`${database}.lock`), { code: "ENOENT" }, "shutdown released exclusive ownership before the client exited");
    await writeFile(join(project, "seed.plk"), "````EDIT (worker://actor/witness.txt)\nRetained across private daemon lifetimes.\n````");
    const binding = { PLURNK_SERVICE_STATE_ROOT: stateRoot, PLURNK_SERVICE_DB_PATH: database };
    const seeded = await invoke(["script", "seed.plk", "--workspace", "retained", "--worker", "actor", "--json"], binding);
    assert.equal(JSON.parse(seeded.stdout).exitCode, 0);
    const resumed = await invoke(["workspace", "list", "--json"], binding);
    assert.deepEqual(JSON.parse(resumed.stdout).map(({ name }: { name: string }) => name), ["retained"]);
    await writeFile(join(project, "restore.plk"), "````COPY (worker://actor/witness.txt) (restored.txt)\n````");
    await invoke(["script", "restore.plk", "--workspace", "retained", "--worker", "actor", "--json"], binding);
    assert.equal(await readFile(join(project, "restored.txt"), "utf8"), "Retained across private daemon lifetimes.");
    assert.equal((await readdir(join(directory, "data", "plurnk", "instances"))).length, 1, "an explicit state root is reused, not replaced");
});

for (const [ending, status] of [["complete", 0], ["SIGINT", 130], ["SIGTERM", 143]] as const) {
    test(`[§cli-daemon-autostart] real CLI inference ${ending} flushes output and stops its private backend`, { timeout: 45_000 }, async (t) => {
        const service = await locateDaemon();
        assert.ok(service);
        const { directory, project, env, invoke, resources } = await fixture(t, service);
        const entered = Promise.withResolvers<void>();
        const disconnected = Promise.withResolvers<void>();
        const provider = createServer(async (request, response) => {
            if (request.method !== "POST") { response.writeHead(200).end("{}"); return; }
            for await (const _chunk of request) { /* consume the request */ }
            response.writeHead(200, { "content-type": "text/event-stream" });
            const frame = (delta: object, finish_reason: string | null = null): void => {
                response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
            };
            frame({ role: "assistant", reasoning_content: "Private inference is active." });
            response.once("close", () => disconnected.resolve());
            entered.resolve();
            if (ending === "complete") {
                frame({ content: "````KILL\nPrivate backend answered.\n````" });
                frame({}, "stop");
                response.end("data: [DONE]\n\n");
            }
        });
        await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
        resources.defer(() => { provider.closeAllConnections(); return new Promise<void>((resolve) => provider.close(() => resolve())); });
        const address = provider.address();
        assert.ok(address !== null && typeof address === "object");
        const stateRoot = join(directory, "backend");
        const child = spawn(process.execPath, [bin, "--json", "--workspace", "private", "--worker", "primary", "--max-turns", "1", "Test private inference."], {
            cwd: project, env: {
                ...env, PLURNK_SERVICE_STATE_ROOT: stateRoot,
                PLURNK_MODEL: "privatefixture", PLURNK_MODEL_privatefixture: "openai/private-fixture",
                OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`, OPENAI_API_KEY: "private-fixture",
                PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768", PLURNK_PROVIDERS_EFFORT: "off", PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
            }, stdio: ["ignore", "pipe", "pipe"],
        });
        const exited = once(child, "close");
        resources.defer(async () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await exited; });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        await Promise.race([entered.promise, exited.then(() => { throw new Error(`client exited before inference: ${stderr}\n${stdout}`); })]);
        const database = join(stateRoot, "data", "plurnk", "plurnk.db");
        const lock = JSON.parse(await readFile(`${database}.lock`, "utf8")) as { pid: number };
        if (ending === "SIGINT") {
            await assert.rejects(invoke(["workspace", "list", "--json"], { PLURNK_SERVICE_STATE_ROOT: stateRoot }), (cause: unknown) => {
                assert.ok(cause instanceof Error && "stdout" in cause && typeof cause.stdout === "string");
                assert.match(JSON.parse(cause.stdout).problem.detail, /database is already owned by daemon pid/);
                return true;
            });
            assert.doesNotThrow(() => process.kill(lock.pid, 0), "a storage conflict neither attaches to nor stops the other private service");
        }
        if (ending !== "complete") child.kill(ending);
        assert.deepEqual(await exited, [status, null], stderr + stdout);
        await disconnected.promise;
        const record = JSON.parse(stdout);
        assert.equal(record.prompt, "Test private inference.");
        if (ending === "complete") assert.equal(record.response, "Private backend answered.");
        assert.equal(stderr, "", "JSON mode remains silent on stderr");
        assert.throws(() => process.kill(lock.pid, 0), { code: "ESRCH" });
        await assert.rejects(readFile(`${database}.lock`), { code: "ENOENT" });
        assert.ok((await readFile(database)).length > 0);
    });
}

test("[§cli-daemon-autostart] failure after private admission still releases its backend", { timeout: 45_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service);
    const { directory, invoke } = await fixture(t, service);
    const stateRoot = join(directory, "failed-backend");
    const result = await invoke(["workspace", "not-a-command", "--json"], { PLURNK_SERVICE_STATE_ROOT: stateRoot }).then(
        () => { throw new Error("invalid command was accepted"); },
        (cause: Error & { stdout: string; stderr: string }) => cause,
    );
    assert.ok(JSON.parse(result.stdout).problem);
    assert.equal(result.stderr, "");
    const database = join(stateRoot, "data", "plurnk", "plurnk.db");
    assert.ok((await readFile(database)).length > 0);
    await assert.rejects(readFile(`${database}.lock`), { code: "ENOENT" });
});

test("[§cli-daemon-autostart] independent clients allocate independent databases", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    if (service === null) { t.skip("no service checkout available"); return; }
    const { directory, invoke } = await fixture(t, service);
    const results = await Promise.all([invoke(["workspace", "list", "--json"]), invoke(["workspace", "list", "--json"])]);
    assert.ok(results.every(({ stdout }) => JSON.parse(stdout).length === 0));
    assert.equal((await readdir(join(directory, "data", "plurnk", "instances"))).length, 2, "clients do not rendezvous or share a database");
});

test("[§cli-daemon-autostart] invocation flags override standing startup settings and reject invalid limits", { timeout: 20_000 }, async (t) => {
    const { directory, invoke } = await fixture(t, "/nonexistent/plurnk-service");
    for (const [args, code, expected] of [
        [["--autostart", "0"], 1, /fetch failed/],
        [["--autostart", "invalid"], 64, /PLURNK_CLIENT_AUTOSTART/],
        [["--daemon-timeout-ms", "0"], 64, /must be positive/],
        [["--daemon-stop-timeout-ms=-1"], 64, /non-negative safe integer/],
        [["--service-bin", "/also-missing/plurnk-service"], 127, /also-missing/],
    ] as const) {
        await assert.rejects(invoke(["workspace", "list", "--json", ...args], { PLURNK_CLIENT_AUTOSTART: "1" }), (cause: unknown) => {
            assert.ok(cause instanceof Error && "stdout" in cause && typeof cause.stdout === "string" && "code" in cause);
            assert.equal(cause.code, code, args.join(" "));
            assert.match(JSON.parse(cause.stdout).problem.detail, expected);
            return true;
        });
    }
    await assert.rejects(readdir(join(directory, "data", "plurnk", "instances")), { code: "ENOENT" });
});

test("[§cli-daemon-autostart] exiting an attached client leaves the existing service alive", { timeout: 60_000 }, async (t) => {
    const service = await locateDaemon();
    if (service === null) { t.skip("no service checkout available"); return; }
    const daemon = await bootDaemon(service, { readyTimeoutMs: 30_000 });
    t.after(daemon.cleanup);
    const { directory, invoke } = await fixture(t, service);
    const target = new URL(daemon.url);
    await invoke(["workspace", "list", "--json"], { PLURNK_HOST: target.hostname, PLURNK_PORT: target.port });
    assert.doesNotThrow(() => process.kill(daemon.pid, 0));
    await assert.rejects(readdir(join(directory, "data", "plurnk", "instances")), { code: "ENOENT" }, "attachment allocates no private storage");
});
