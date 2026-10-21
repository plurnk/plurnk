import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { bootDaemon, locateDaemon } from "./harness.ts";

const run = promisify(execFile);
const bin = resolve(import.meta.dirname, "../../bin/plurnk.js");

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A loopback port nothing listens on yet: bound, then released.
const freePort = async (): Promise<number> => {
    const server = createServer();
    await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    await new Promise<void>((accept) => server.close(() => accept()));
    return address.port;
};

// An isolated home on its own port. Every service a test starts there is stopped when it ends.
const fixture = async (t: { after(fn: () => Promise<void>): void }, service: string) => {
    const resources = new AsyncDisposableStack();
    const directory = await mkdtemp(join(tmpdir(), "plurnk-autostart-"));
    resources.defer(() => rm(directory, { recursive: true, force: true }));
    t.after(() => resources.disposeAsync());
    const project = join(directory, "project");
    await mkdir(project);
    const port = await freePort();
    const env = {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PLURNK_/u.test(key) && !/_(API_KEY|BASE_URL)$/u.test(key))),
        HOME: directory,
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_DATA_HOME: join(directory, "data"),
        XDG_STATE_HOME: join(directory, "state"),
        XDG_CACHE_HOME: join(directory, "cache"),
        PLURNK_HOST: "127.0.0.1",
        PLURNK_PORT: String(port),
        PLURNK_AGUI_URL: "",
        PLURNK_MODEL: "",
        PLURNK_CLIENT_SERVICE_BIN: service,
        NO_COLOR: "1",
    };
    const database = join(directory, "data", "plurnk", "plurnk.db");
    const servicePid = async (): Promise<number> => (JSON.parse(await readFile(`${database}.lock`, "utf8")) as { pid: number }).pid;
    resources.defer(async () => {
        const pid = await servicePid().catch(() => null);
        if (pid === null || !alive(pid)) return;
        process.kill(pid, "SIGTERM");
        for (let waited = 0; alive(pid) && waited < 30_000; waited += 100) await new Promise((accept) => setTimeout(accept, 100));
    });
    // stdin ends at once: a one-shot appends piped stdin to its prompt and waits for its end.
    const invoke = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
        const pending = run(process.execPath, [bin, ...args], { cwd: project, env: { ...env, ...extra }, timeout: 45_000, maxBuffer: 4 * 1024 * 1024 });
        pending.child.stdin?.end();
        return pending;
    };
    return { directory, project, port, env, database, servicePid, invoke, resources };
};

test("[§cli-daemon-autostart] the built client starts the one shared service, leaves it running, and a later client attaches to it", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    if (service === null) { t.skip("no service checkout available"); return; }
    const { directory, project, env, servicePid, invoke } = await fixture(t, service);
    const first = await invoke(["workspace", "list", "--json"]);
    assert.equal(first.stderr, "", "JSON mode retains its silent stderr contract");
    assert.deepEqual(JSON.parse(first.stdout), []);
    const pid = await servicePid();
    assert.ok(alive(pid), "the service outlives the client that started it");
    await access(join(directory, "state", "plurnk", "service.log"));

    await writeFile(join(project, "seed.plk"), "````EDIT (worker://actor/witness.txt)\nKept by the one service.\n````");
    const seeded = await invoke(["script", "seed.plk", "--workspace", "retained", "--worker", "actor", "--json"]);
    assert.equal(JSON.parse(seeded.stdout).exitCode, 0);
    const later = await invoke(["workspace", "list", "--json"]);
    assert.deepEqual(JSON.parse(later.stdout).map(({ name }: { name: string }) => name), ["retained"], "a later client sees what an earlier one did");
    assert.equal(await servicePid(), pid, "and reached it through the same service");

    const stopped = await run(process.execPath, [...(service.endsWith(".ts") ? ["--conditions=plurnk-dev"] : []), service, "stop"], { env, timeout: 60_000 });
    assert.match(stopped.stderr, new RegExp(`stopped pid ${pid} `, "u"));
    assert.equal(alive(pid), false, "plurnk-service stop ends it");
});

test("[§cli-daemon-autostart] concurrent first launches share one service", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    if (service === null) { t.skip("no service checkout available"); return; }
    const { servicePid, invoke } = await fixture(t, service);
    const results = await Promise.all([invoke(["workspace", "list", "--json"]), invoke(["workspace", "list", "--json"])]);
    assert.ok(results.every(({ stdout }) => JSON.parse(stdout).length === 0), "the launch that lost the address attached to the winner");
    assert.ok(alive(await servicePid()));
});

test("[§cli-daemon-autostart] text mode names the service it started and how to stop it", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    if (service === null) { t.skip("no service checkout available"); return; }
    const { port, servicePid, invoke } = await fixture(t, service);
    const first = await invoke(["workspace", "list"]);
    const pid = await servicePid();
    assert.match(first.stderr, new RegExp(`client:daemon:started — Started plurnk-service \\(pid ${pid}\\) at http://127\\.0\\.0\\.1:${port}/agui`, "u"));
    assert.match(first.stderr, /plurnk-service stop/u);
    const attached = await invoke(["workspace", "list"]);
    assert.doesNotMatch(attached.stderr, /client:daemon:started/u, "attaching reports no start");
});

test("[§cli-workspaces-and-workers] each one-shot runs in a new worker of its own, and --worker continues one", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    if (service === null) { t.skip("no service checkout available"); return; }
    // The model fixture listens before the fixture picks the service's port, so the two cannot meet.
    const provider = createServer(async (request, response) => {
        if (request.method !== "POST") { response.writeHead(200).end("{}"); return; }
        for await (const _chunk of request) { /* consume the request */ }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const frame = (delta: object, finish_reason: string | null = null): void => {
            response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        };
        frame({ content: "````SEND [200]\nAnswered.\n````" });
        frame({}, "stop");
        response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((accept) => provider.listen(0, "127.0.0.1", accept));
    t.after(() => { provider.closeAllConnections(); return new Promise<void>((accept) => provider.close(() => accept())); });
    const { invoke } = await fixture(t, service);
    const address = provider.address();
    assert.ok(address !== null && typeof address === "object");
    const model = {
        PLURNK_MODEL: "oneshotfixture", PLURNK_MODEL_oneshotfixture: "openai/oneshot-fixture",
        OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`, OPENAI_API_KEY: "oneshot-fixture",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768", PLURNK_PROVIDERS_EFFORT: "off", PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    };
    const oneShot = async (args: string[] = []) => JSON.parse((await invoke(["--json", "--workspace", "shots", "--max-turns", "1", ...args, "Answer."], model)).stdout) as { worker: string; response: string };
    const [first, second] = [await oneShot(), await oneShot()];
    for (const record of [first, second]) {
        assert.match(record.worker, /^[0-9a-f]{12}$/u, "a one-shot with no worker stated gets twelve random hex characters");
        assert.equal(record.response, "Answered.");
    }
    assert.notEqual(first.worker, second.worker, "one-shots never share a conversation unless asked");
    assert.equal((await oneShot(["--worker", first.worker])).worker, first.worker, "--worker continues it");
    const text = await invoke(["--workspace", "shots", "--max-turns", "1", "Answer."], model);
    assert.match(text.stderr, /client:worker:new — New worker [0-9a-f]{12}/u, "text mode names the new worker");
    assert.match(text.stderr, /Continue it with --worker [0-9a-f]{12}/u);
    const { stdout } = await invoke(["workspace", "workers", "shots", "--json"]);
    assert.ok(!(JSON.parse(stdout) as Array<{ name: string }>).some(({ name }) => name === "user"), "no one-shot touched the TUI's worker");
});

test("[§cli-daemon-autostart] invocation flags override standing startup settings and reject invalid limits", { timeout: 20_000 }, async (t) => {
    const { directory, invoke } = await fixture(t, "/nonexistent/plurnk-service");
    for (const [args, extra, code, expected] of [
        [["--autostart", "0"], {}, 1, /fetch failed/],
        [["--autostart", "invalid"], {}, 64, /PLURNK_CLIENT_AUTOSTART/],
        [["--daemon-timeout-ms", "0"], {}, 64, /must be positive/],
        [[], { PLURNK_PORT: "0" }, 64, /Autostart needs the service's port; PLURNK_PORT is 0\./],
        [["--service-bin", "/also-missing/plurnk-service"], {}, 127, /also-missing/],
    ] as const) {
        await assert.rejects(invoke(["workspace", "list", "--json", ...args], { PLURNK_CLIENT_AUTOSTART: "1", ...extra }), (cause: unknown) => {
            assert.ok(cause instanceof Error && "stdout" in cause && typeof cause.stdout === "string" && "code" in cause);
            assert.equal(cause.code, code, args.join(" "));
            assert.match(JSON.parse(cause.stdout).problem.detail, expected);
            return true;
        });
    }
    await assert.rejects(access(join(directory, "state", "plurnk", "service.log")), { code: "ENOENT" }, "no refused invocation started a service");
});

test("[§cli-daemon-autostart] exiting an attached client leaves the existing service alive and starts nothing", { timeout: 60_000 }, async (t) => {
    const service = await locateDaemon();
    if (service === null) { t.skip("no service checkout available"); return; }
    const daemon = await bootDaemon(service, { readyTimeoutMs: 30_000 });
    t.after(daemon.cleanup);
    const { directory, invoke } = await fixture(t, service);
    const target = new URL(daemon.url);
    await invoke(["workspace", "list", "--json"], { PLURNK_HOST: target.hostname, PLURNK_PORT: target.port });
    assert.doesNotThrow(() => process.kill(daemon.pid, 0));
    await assert.rejects(access(join(directory, "state", "plurnk", "service.log")), { code: "ENOENT" }, "attaching starts no service");
});
