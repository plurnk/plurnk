import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { actionViaAcp } from "../../src/acp.ts";
import { ProblemError } from "../../src/diagnostics.ts";
import { bootDaemon, locateDaemon } from "./harness.ts";

const bin = resolve(import.meta.dirname, "../../bin/plurnk.js");

test("[§cli-prompt-prefixes] the built one-shot `! command` runs through op.exec and exits by its conclusion", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service, "the sibling plurnk-service checkout is reachable");
    const daemon = await bootDaemon(service);
    t.after(daemon.cleanup);
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun, reject) => {
        const child = spawn(process.execPath, [bin, ...args], {
            cwd: daemon.workspace,
            env: {
                ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PLURNK_") && !key.endsWith("_API_KEY"))),
                HOME: daemon.home, XDG_CONFIG_HOME: join(daemon.home, ".config"), NO_COLOR: "1",
                PLURNK_ACP_URL: daemon.url,
            },
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30_000,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (code) => resolveRun({ code, stdout, stderr }));
    });
    const workspaces = async (): Promise<string[]> => (await actionViaAcp<{ workspaces: Array<{ name: string }> }>(
        { acpUrl: daemon.url }, { threadId: "inspect", kind: "workspace.list" },
    )).workspaces.map(({ name }) => name);

    await t.test("the command's stdout is the client's stdout, and success exits 0", async () => {
        const result = await run(["--workspace", "exec", "! echo hi"]);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stdout, "hi\n");
        await assert.rejects(actionViaAcp({ acpUrl: daemon.url }, { threadId: "exec", workspace: "exec", kind: "workspace.prompts" }),
            (error: unknown) => error instanceof ProblemError && error.problem.type.endsWith("/worker-not-found"),
            "the command created no model worker, so nothing became a prompt");
    });

    await t.test("[§cli-environment] --env rides the command as its own environment and persists nowhere", async () => {
        const carried = await run(["--workspace", "exec-env", "--env", "GREETING=Hello", "! printf %s \"$GREETING\""]);
        assert.equal(carried.code, 0, carried.stderr);
        assert.equal(carried.stdout, "Hello");
        const { workers } = await actionViaAcp<{ workers: Array<{ origin: string }> }>({ acpUrl: daemon.url }, { threadId: "inspect", workspace: "exec-env", kind: "workspace.workers" });
        assert.deepEqual(workers.filter(({ origin }) => origin !== "_plurnk"), [], "a person's command runs in the workspace's runtime worker and writes no model worker");
        const refused = await run(["--workspace", "exec-env", "--env", "PLURNK_GREETING=Hello", "! echo ran"]);
        assert.equal(refused.code, 4, refused.stderr);
        assert.equal(refused.stdout, "", "a refused environment runs nothing");
        assert.match(refused.stderr, /PLURNK_GREETING/u);
    });

    await t.test("a failing command's stderr reaches stderr and the client exits 4", async () => {
        const result = await run(["--workspace", "exec", "! echo oops >&2; exit 3"]);
        assert.equal(result.code, 4, result.stderr);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /^oops$/mu);
    });

    await t.test("an execution the daemon refuses reports its Problem and exits 4", async () => {
        const result = await run(["--workspace", "exec-denied", "--capabilities", '{"deny":[{"runtime":"sh"}]}', "! echo denied"]);
        assert.equal(result.code, 4, result.stderr);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /Capability 'sh\/exec\/sh' is denied by workspace policy\./u);
    });

    await t.test("a ! prompt without a command is a usage error before the daemon is contacted", async () => {
        const result = await run(["--workspace", "exec-empty", "!"]);
        assert.equal(result.code, 64, result.stderr);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /client:usage:command-required/u);
        assert.ok(!(await workspaces()).includes("exec-empty"), "no workspace was created for it");
    });
});
