import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("[§cli-invocation] local CLI surfaces never open a daemon conversation", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-cli-invocation-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    let requests = 0;
    const daemon = createServer((_request, response) => {
        requests++;
        response.writeHead(503, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((resolve) => daemon.listen(0, "127.0.0.1", resolve));
    t.after(() => { daemon.closeAllConnections(); return new Promise<void>((resolve) => daemon.close(() => resolve())); });
    const address = daemon.address();
    assert.ok(address !== null && typeof address === "object");
    const run = (args: string[], source = "", env: NodeJS.ProcessEnv = {}) => new Promise<{
        code: number | null; stdout: string; stderr: string;
    }>((resolveRun, reject) => {
        const child = spawn(process.execPath, [resolve(import.meta.dirname, "../../bin/plurnk.js"), ...args], {
            cwd: home, timeout: 10_000,
            env: {
                ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), NO_COLOR: "1",
                PLURNK_AGUI_URL: `http://127.0.0.1:${address.port}`, PLURNK_CLIENT_JSON: "0", ...env,
            },
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (code) => resolveRun({ code, stdout, stderr }));
        child.stdin.end(source);
    });
    for (const env of [{}, { CI: "true" }, { PLURNK_CLIENT_JSON: "1" }]) {
        await t.test(`empty piped input is a usage error: ${JSON.stringify(env)}`, async () => {
            const result = await run([], " \n", env);
            assert.equal(result.code, 64, result.stderr);
            if (env.PLURNK_CLIENT_JSON === "1") {
                assert.equal(JSON.parse(result.stdout).problem.type, "https://problems.plurnk.xyz/client/usage/prompt-required");
                assert.equal(result.stderr, "");
            } else {
                assert.match(result.stderr, /Provide a prompt or use an interactive terminal/);
                assert.equal(result.stdout, "");
            }
            assert.equal(requests, 0, "empty input must not create a workspace or load the TUI");
        });
    }
    for (const name of ["models", "workspace", "log", "read", "script", "mcp", "effort", "capabilities", "web", "completion"]) {
        await t.test(`${name} --help`, async () => {
            const result = await run([name, "--help"]);
            assert.equal(result.code, 0, result.stderr);
            assert.equal(result.stderr, "");
            assert.ok(result.stdout.startsWith(`usage: plurnk ${name} `), result.stdout);
            assert.doesNotMatch(result.stdout, new RegExp(`plurnk ${name === "models" ? "workspace" : "models"} `));
            assert.equal(requests, 0);
        });
    }
    for (const [shell, file] of [["bash", "plurnk.bash"], ["zsh", "_plurnk"], ["fish", "plurnk.fish"]]) {
        await t.test(`completion ${shell} emits the packaged artifact`, async () => {
            const result = await run(["completion", shell], "ignored piped text", { PLURNK_CLIENT_YOLO: "not-a-boolean" });
            assert.equal(result.code, 0, result.stderr);
            assert.equal(result.stderr, "");
            assert.equal(result.stdout, await readFile(new URL(`../../completions/${file}`, import.meta.url), "utf8"));
            assert.equal(requests, 0);
        });
    }
    for (const args of [["completion"], ["completion", "../package.json"], ["completion", "bash", "extra"]]) {
        await t.test(`${args.join(" ")} is rejected as an invalid invocation`, async () => {
            const result = await run(args);
            assert.equal(result.code, 64, result.stderr);
            assert.equal(result.stdout, "");
            assert.match(result.stderr, /completion|bash|zsh|fish/);
            assert.equal(requests, 0);
        });
    }
    await t.test("YOLO help agrees with the packaged default", async () => {
        const result = await run(["--help"]);
        assert.equal(result.code, 0);
        assert.match(result.stdout, /--yolo[^\n]*\n[^\n]*On by default/);
        assert.doesNotMatch(result.stdout, /Review ships/);
    });
});
