import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const marker = "PLURNK_TEST_IMPORTS=";
const traceProgram = `
import { registerHooks } from "node:module";
const urls = new Set();
registerHooks({ load(url, context, next) {
    urls.add(url);
    const fault = process.env.PLURNK_TEST_FAIL_IMPORT;
    if (fault && url.includes(fault)) throw new Error("test import failure: " + fault);
    return next(url, context);
} });
const [entry, mode, ...args] = process.argv.slice(1);
process.argv = [process.execPath, entry, ...args];
process.on("exit", () => process.stderr.write(${JSON.stringify(marker)} + JSON.stringify([...urls]) + "\\n"));
const module = await import(entry);
if (mode === "main") await module.main(process.argv);
`;

const trace = async (entry: string, mode = "import", args: string[] = [], stdin = "", fault = "") =>
    await new Promise<{ code: number | null; urls: string[]; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", traceProgram,
            new URL(`../../dist/${entry}.js`, import.meta.url).href, mode, ...args], {
            cwd: fileURLToPath(new URL("../../", import.meta.url)),
            env: { ...process.env, NO_COLOR: "1", PLURNK_TEST_FAIL_IMPORT: fault },
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (code) => {
            const line = stderr.split("\n").find((line) => line.startsWith(marker));
            if (line === undefined) { reject(new Error(`no import trace: ${stderr}`)); return; }
            resolve({ code, urls: JSON.parse(line.slice(marker.length)), stdout, stderr: stderr.replace(`${line}\n`, "") });
        });
        child.stdin.end(stdin);
    });

const rich = (urls: string[]) => urls.filter((url) => /node_modules\/(?:@earendil-works\/pi-tui|beautiful-mermaid|elkjs|marked)\//u.test(url));

for (const entry of ["dispatcher", "cli", "agui_cli", "subcommands", "render"]) {
    test(`[§cli-presentation-loading] built ${entry} has no graphical import graph`, async () => {
        const result = await trace(entry);
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(rich(result.urls), []);
    });
}

for (const args of [["--help"], ["--version"], ["render", "--help"]]) {
    test(`[§cli-presentation-loading] ${args.join(" ")} does not initialize rendering`, async () => {
        const result = await trace("dispatcher", "main", args);
        assert.equal(result.code, 0, result.stderr);
        assert.ok(result.stdout.length > 0);
        assert.deepEqual(rich(result.urls), []);
    });
}

test("[§cli-presentation-loading] the selected render filter loads diagrams but not pi-tui", async () => {
    const result = await trace("dispatcher", "main", ["render", "--width", "80"], "```mermaid\ngraph LR\nA[Start] --> B[Finish]\n```\n");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Start/);
    assert.match(result.stdout, /Finish/);
    assert.match(result.stdout, /┌/);
    assert.ok(result.urls.some((url) => url.includes("/beautiful-mermaid/")));
    assert.equal(result.urls.some((url) => url.includes("/pi-tui/")), false);
});

test("[§cli-presentation-loading] the TUI retains its complete presentation graph", async () => {
    const result = await trace("tui");
    assert.equal(result.code, 0, result.stderr);
    for (const name of ["pi-tui", "beautiful-mermaid", "marked"]) {
        assert.ok(result.urls.some((url) => url.includes(`/${name}/`)), name);
    }
});

test("[§cli-presentation-loading] renderer initialization failures remain errors", async () => {
    const result = await trace("dispatcher", "main", ["render"], "# Heading", "beautiful-mermaid");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /test import failure: beautiful-mermaid/);
    assert.equal(result.stdout, "");
});

test("[§cli-exit-codes] bad render arguments remain usage errors without loading the renderer", async () => {
    const result = await trace("dispatcher", "main", ["render", "--width", "0"]);
    assert.equal(result.code, 64);
    assert.match(result.stderr, /positive integer/);
    assert.equal(result.stdout, "");
    assert.deepEqual(rich(result.urls), []);
});
