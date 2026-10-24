import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { actionViaAcp, type WorkspaceHandle } from "../../src/acp.ts";
import { bootDaemon, completionsEndpoint, locateDaemon } from "./harness.ts";

const exec = promisify(execFile);
const binary = resolve(import.meta.dirname, "../../bin/plurnk.js");
const clientEnv = (home: string, url: string) => ({
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PLURNK_"))),
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_STATE_HOME: join(home, ".local/state"),
    PLURNK_ACP_URL: url,
    PLURNK_CLIENT_AUTOSTART: "0",
    NO_COLOR: "1",
});

test("{§cli-workspaces-and-workers} built inspection selects names and folder defaults without creating state", { timeout: 30_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service);
    const daemon = await bootDaemon(service);
    t.after(daemon.cleanup);
    const target = { acpUrl: daemon.url };
    const env = clientEnv(daemon.home, daemon.url);
    const folder = join(daemon.home, "project");
    await mkdir(folder);
    const inspect = (args: string[], cwd = folder) => exec(binary, ["--json", ...args], { cwd, env, timeout: 10_000 });
    const list = () => actionViaAcp<{ workspaces: WorkspaceHandle[] }>(target, { threadId: "bootstrap", kind: "workspace.list" });
    for (const [args, cwd] of [
        [["capabilities"], folder],
        [["log", "read"], daemon.home],
        [["workspace", "workers", "absent"], folder],
        [["workspace", "rename", "absent", "new"], folder],
    ] as const) {
        await assert.rejects(inspect([...args], cwd), (error: unknown) => {
            assert.ok(error instanceof Error && "stdout" in error && typeof error.stdout === "string");
            const { problem } = JSON.parse(error.stdout);
            assert.equal(problem.status, 404);
            assert.equal(problem.type, "https://problems.plurnk.xyz/daemon/workspace/workspace-not-found");
            return true;
        });
        assert.deepEqual((await list()).workspaces, [], "inspection cannot mint an absent workspace");
    }

    const created = await actionViaAcp<WorkspaceHandle>(target, { threadId: "bootstrap", kind: "workspace.create", params: { projectRoot: folder } });
    assert.equal(created.name, "~/project", "the daemon, not the client, spells the home-relative default");
    const before = await list();
    assert.equal(JSON.parse((await inspect(["capabilities"])).stdout).workspace !== undefined, true);
    assert.deepEqual(await list(), before);
    assert.deepEqual((await actionViaAcp<{ workers: unknown[] }>(target, { threadId: `${created.id}#user`, kind: "workspace.workers" })).workers, []);

    const literalName = `${created.id}#user`;
    const literal = await actionViaAcp<WorkspaceHandle>(target, { threadId: "bootstrap", kind: "workspace.create", params: { name: literalName, projectRoot: null } });
    assert.notEqual(literal.id, created.id);
    assert.deepEqual(JSON.parse((await inspect(["workspace", "workers", literalName])).stdout), []);
    const renamed = JSON.parse((await inspect(["workspace", "rename", literalName, "renamed"])).stdout);
    assert.deepEqual(renamed, { id: literal.id, name: "renamed" });
    assert.equal((await list()).workspaces.find(({ id }) => id === created.id)?.name, created.name,
        "a qualified-looking label never selects another workspace's ID");
});

test("{§cli-workspaces-and-workers} built prompt CLI runs in a new worker of its own in a folder-named workspace and preserves explicit worker selection", { timeout: 30_000 }, async (t) => {
    let calls = 0;
    const provider = await completionsEndpoint(() => {
        calls += 1;
        return "````SEND [200]\nSELECTED_WORKER_ANSWER\n````";
    });
    t.after(provider.close);
    const service = await locateDaemon();
    assert.ok(service);
    const daemon = await bootDaemon(service, { extraEnv: {
        PLURNK_MODEL: "selectionfixture",
        PLURNK_MODEL_selectionfixture: "openai/selection-fixture",
        OPENAI_BASE_URL: provider.url,
        OPENAI_API_KEY: "fixture",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
        PLURNK_PROVIDERS_EFFORT: "off",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(daemon.cleanup);
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    const env = clientEnv(daemon.home, daemon.url);
    const folder = join(daemon.home, "project");
    await mkdir(folder);
    const bound: string[] = [];
    for (const args of [[], ["--worker", "reviewer"]]) {
        const invocation = exec(binary, ["--json", ...args, "Hello."], { cwd: folder, env, timeout: 10_000 });
        invocation.child.stdin?.end();
        const record = JSON.parse((await invocation).stdout) as { response: string; worker: string };
        assert.equal(record.response, "SELECTED_WORKER_ANSWER");
        bound.push(record.worker);
    }
    assert.match(bound[0]!, /^[0-9a-f]{12}$/u, "with no worker selected, the one-shot runs in a new worker of its own");
    assert.equal(bound[1], "reviewer");
    const target = { acpUrl: daemon.url };
    const { workspaces } = await actionViaAcp<{ workspaces: WorkspaceHandle[] }>(target, { threadId: "bootstrap", kind: "workspace.list" });
    assert.equal(workspaces.length, 1);
    assert.equal(workspaces[0]?.name, "~/project");
    const { workers } = await actionViaAcp<{ workers: { name: string; origin: string }[] }>(target, { threadId: `${workspaces[0]!.id}#user`, kind: "workspace.workers" });
    assert.deepEqual(workers.filter(({ origin }) => origin === "model").map(({ name }) => name).sort(), [...bound].sort());
    assert.equal(calls, 2);
});
