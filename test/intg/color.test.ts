import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import pty from "node-pty";
import { bootDaemon, completionsEndpoint, locateDaemon } from "./harness.ts";

const BIN = resolve(import.meta.dirname, "../../bin/plurnk.js");
const ANSWER = "**An unchanged answer.**";
const ANSI = /\x1b\[[\d;]*m/u;

test("[§cli-color-policy] built client separates terminal presentation from raw product output", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    if (service === null) { t.skip("no plurnk-service binary reachable"); return; }
    const endpoint = await completionsEndpoint(() => `\`\`\`\`KILL\n${ANSWER}\n\`\`\`\``);
    t.after(() => endpoint.close());
    const daemon = await bootDaemon(service, {
        readyTimeoutMs: 30_000,
        extraEnv: {
            PLURNK_MODEL: "colortest", PLURNK_MODEL_colortest: "openai/color-test",
            PLURNK_BASEURL_colortest: endpoint.url, OPENAI_BASE_URL: endpoint.url,
            OPENAI_API_KEY: "color-test", PLURNK_PROVIDERS_EFFORT: "off",
            PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768", PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
        },
    });
    t.after(() => daemon.cleanup());
    const env = Object.fromEntries(Object.entries({
        ...process.env, HOME: daemon.home, XDG_CONFIG_HOME: join(daemon.home, ".config"),
        PLURNK_AGUI_URL: daemon.url, PLURNK_CLIENT_COLOR: "auto", PLURNK_CLIENT_JSON: "0",
        NO_COLOR: "", FORCE_COLOR: "", CLICOLOR_FORCE: "", CLICOLOR: "", TERM: "xterm-256color",
    }).filter(([, value]) => value !== undefined)) as Record<string, string>;
    const run = (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolveRun, reject) => {
        const child = spawn(process.execPath, [BIN, ...args], {
            cwd: daemon.workspace, env, stdio: ["ignore", "pipe", "pipe"], timeout: 20_000,
        });
        let out = "";
        let err = "";
        child.stdout.setEncoding("utf8").on("data", (data: string) => { out += data; });
        child.stderr.setEncoding("utf8").on("data", (data: string) => { err += data; });
        child.once("error", reject);
        child.once("close", (code) => resolveRun({ code, out, err }));
    });
    const prompt = ["--workspace=color-test", "--project-root=", "--max-turns=2", "--timeout=15", "Answer briefly."];
    const text = await run(["--color=always", ...prompt]);
    assert.equal(text.code, 0, text.err);
    assert.equal(text.out, `${ANSWER}\n`);
    assert.match(text.err, ANSI, "human stderr can be forced without styling the answer");
    const json = await run(["--color=always", "--json", ...prompt]);
    assert.equal(json.code, 0, json.err);
    assert.equal(json.err, "");
    assert.equal(JSON.parse(json.out).response, ANSWER);
    assert.doesNotMatch(json.out, /\\u001b|\x1b/u);
    for (const mode of ["always", "auto", "never"]) {
        const table = await run(["workspace", "list", `--color=${mode}`]);
        assert.equal(table.code, 0, table.err);
        assert.match(table.out, /color-test/);
        assert.equal(ANSI.test(table.out), mode === "always", mode);
    }

    // The shell only redirects descriptors; the built client sees real, independently typed sinks.
    const redirected = async (fd: "1" | "2", args: string[]) => {
        const file = join(daemon.workspace, `fd${fd}.txt`);
        const command = fd === "1" ? 'exec "$@" </dev/null >"$capture"' : 'exec "$@" </dev/null 2>"$capture"';
        const term = pty.spawn("/bin/sh", ["-c", command, "color-test", process.execPath, BIN, ...args], {
            name: "xterm-256color", cols: 100, rows: 30, cwd: daemon.workspace, env: { ...env, capture: file },
        });
        let output = "";
        term.onData((data) => { output += data; });
        const code = await new Promise<number>((resolveExit, reject) => {
            const timer = setTimeout(() => {
                term.kill();
                reject(new Error(`color client timed out: ${output}`));
            }, 20_000);
            term.onExit(({ exitCode }) => { clearTimeout(timer); resolveExit(exitCode); });
        });
        return { code, terminal: output, file: await readFile(file, "utf8") };
    };
    for (const fd of ["1", "2"] as const) {
        const diagnostic = await redirected(fd, []);
        assert.equal(diagnostic.code, 64);
        assert.match(fd === "1" ? diagnostic.terminal : diagnostic.file, /Provide a prompt/);
        assert.equal(ANSI.test(diagnostic.terminal), fd === "1", "stderr follows its own terminal, not stdout");
        assert.doesNotMatch(diagnostic.file, ANSI);
        const table = await redirected(fd, ["workspace", "list"]);
        assert.equal(table.code, 0, table.terminal + table.file);
        assert.match(fd === "1" ? table.file : table.terminal, /color-test/);
        assert.equal(ANSI.test(table.terminal), fd === "2", "stdout follows its own terminal, not stderr");
        assert.doesNotMatch(table.file, ANSI);
        const answer = await redirected(fd, prompt);
        assert.equal(answer.code, 0, answer.terminal + answer.file);
        assert.equal(ANSI.test(answer.terminal), fd === "1", "CLI trace uses stderr independently of the answer sink");
        assert.doesNotMatch(answer.file, ANSI);
        assert.match(fd === "1" ? answer.file : answer.terminal, /\*\*An unchanged answer\.\*\*/);
    }
});
