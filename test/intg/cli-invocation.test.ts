import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
        const child = spawn(resolve(import.meta.dirname, "../../bin/plurnk.js"), args, {
            cwd: home, timeout: 10_000,
            env: {
                ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), NO_COLOR: "1",
                PLURNK_CLIENT_COLOR: undefined, FORCE_COLOR: undefined, CLICOLOR_FORCE: undefined, CLICOLOR: undefined,
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
    await t.test("[§cli-worker-ownership] --auto is live; per-loop approval flags stay retired and name their successors", async () => {
        const auto = await run(["--auto", "--help"]);
        assert.equal(auto.code, 0, auto.stderr);
        assert.match(auto.stdout, /--auto {2,}nobody is attending/u);
        const before = requests;
        const retired = await run(["--proposals", "accept", "hello"]);
        assert.equal(retired.code, 64, retired.stderr);
        assert.match(retired.stderr, /Per-loop approval flags are retired; use local --yolo or server PLURNK_SERVICE_PROPOSALS/u);
        assert.equal(requests, before, "a refused flag opens no conversation");
    });
    for (const name of ["models", "workspace", "log", "read", "script", "mcp", "skills", "a2a", "members", "env", "schedule", "effort", "capabilities", "web", "completion"]) {
        await t.test(`${name} --help`, async () => {
            const result = await run([name, "--help"]);
            assert.equal(result.code, 0, result.stderr);
            assert.equal(result.stderr, "");
            assert.ok(result.stdout.startsWith(`usage: plurnk ${name} `), result.stdout);
            assert.doesNotMatch(result.stdout, new RegExp(`plurnk ${name === "models" ? "workspace" : "models"} `));
            assert.equal(requests, 0);
        });
    }
    for (const args of [["--bogus"], ["--json", "--bogus"], ["--workspace", "mcp", "--bogus"], ["--workspace"], ["--json", "--yolo=yes"]]) {
        await t.test(`invalid arguments produce usage diagnostics: ${args.join(" ")}`, async () => {
            const result = await run(args);
            assert.equal(result.code, 64, result.stderr);
            if (args.includes("--json")) {
                assert.equal(result.stderr, "");
                assert.equal(JSON.parse(result.stdout).problem.type, "https://problems.plurnk.xyz/client/usage/invalid-arguments");
            } else {
                assert.equal(result.stdout, "");
                assert.match(result.stderr, /--bogus|--workspace/u);
            }
            assert.doesNotMatch(result.stderr, /\n\s+at |ERR_PARSE_ARGS/u);
            assert.equal(requests, 0);
        });
    }
    for (const value of ["-1", "1.5", "invalid", "9007199254740992"]) {
        await t.test(`invalid history count ${value} is rejected before connecting`, async () => {
            const result = await run([`--history-entries=${value}`, "--json", "hello"]);
            assert.equal(result.code, 64);
            assert.equal(result.stderr, "");
            assert.equal(JSON.parse(result.stdout).problem.type, "https://problems.plurnk.xyz/client/flag/invalid");
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
    await t.test("[§cli-color-policy] built diagnostics honor flags and environment preferences in a pipe", async () => {
        const cases: [string[], NodeJS.ProcessEnv, boolean][] = [
            [[], { NO_COLOR: "" }, false],
            [[], { NO_COLOR: "", FORCE_COLOR: "1" }, true],
            [[], { NO_COLOR: "1", FORCE_COLOR: "1", CLICOLOR_FORCE: "1" }, false],
            [["--color=always"], { NO_COLOR: "1", TERM: "dumb" }, true],
            [["--color=never"], { FORCE_COLOR: "1" }, false],
            [[], { PLURNK_CLIENT_COLOR: "always", NO_COLOR: "1" }, true],
        ];
        for (const [args, env, colored] of cases) {
            const result = await run(args, "", env);
            assert.equal(result.code, 64, result.stderr);
            assert.match(result.stderr, /Provide a prompt or use an interactive terminal/);
            assert.equal(/\x1b\[/u.test(result.stderr), colored, JSON.stringify({ args, env }));
            assert.equal(result.stdout, "");
        }
        assert.equal(requests, 0);
    });
    await t.test("[§cli-color-policy] invalid modes fail before dialing, including JSON diagnostics", async () => {
        for (const args of [[], ["--json"]]) {
            for (const env of [{}, { PLURNK_CLIENT_COLOR: "invalid" }]) {
                const result = await run([...args, ...(env.PLURNK_CLIENT_COLOR ? [] : ["--color=invalid"])], "", env);
                assert.equal(result.code, 64, result.stderr);
                if (args.length > 0) {
                    assert.equal(result.stderr, "");
                    assert.equal(JSON.parse(result.stdout).problem.type, "https://problems.plurnk.xyz/client/flag/invalid");
                } else {
                    assert.equal(result.stdout, "");
                    assert.match(result.stderr, /must be always, auto, or never/);
                }
                assert.doesNotMatch(result.stdout + result.stderr, /\x1b\[/u);
            }
        }
        assert.equal(requests, 0);
    });
    await t.test("[§cli-color-policy] raw local surfaces ignore forced styling", async () => {
        for (const args of [["--help"], ["--version"], ["completion", "bash"], ["render", "--width=40"]]) {
            const result = await run([...args, "--color=always"], "# Heading\n\n**strong**", { PLURNK_CLIENT_COLOR: "always" });
            assert.equal(result.code, 0, result.stderr);
            assert.equal(result.stderr, "");
            assert.ok(result.stdout.length > 0);
            assert.doesNotMatch(result.stdout, /\x1b\[/u);
        }
        assert.equal(requests, 0);
    });
    await t.test("[§cli-color-policy] the flag overrides the same knob from the existing env cascade", async () => {
        const layer = join(home, "colors.env");
        await writeFile(layer, "PLURNK_CLIENT_COLOR=always\n");
        await writeFile(join(home, ".env"), "PLURNK_CLIENT_COLOR=never\n");
        const cases: [string[], NodeJS.ProcessEnv, boolean][] = [
            [[], {}, false],
            [["--env-file", layer], {}, true],
            [["--env-file", layer], { PLURNK_CLIENT_COLOR: "never" }, false],
            [["--color=always", "--env-file", layer], { PLURNK_CLIENT_COLOR: "never" }, true],
        ];
        for (const [args, env, colored] of cases) {
            const result = await run(args, "", env);
            assert.equal(result.code, 64, result.stderr);
            assert.match(result.stderr, /Provide a prompt or use an interactive terminal/);
            assert.equal(/\x1b\[/u.test(result.stderr), colored, JSON.stringify({ args, env }));
        }
        assert.equal(requests, 0);
    });
});
