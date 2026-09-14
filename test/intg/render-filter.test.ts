import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const runClient = async (args: string[], source: string = ""): Promise<{
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
}> => await new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [
        resolve(import.meta.dirname, "../../bin/plurnk.js"),
        ...args,
    ], {
        env: {
            ...process.env,
            NO_COLOR: "",
            PLURNK_AGUI_URL: "http://127.0.0.1:1",
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
    child.stdin.end(source);
});

const runFilter = async (source: string, width: number) =>
    await runClient(["render", "--width", String(width)], source);

test("[§cli-render-filter] filter help is an exact side-effect-free capability probe", async () => {
    const result = await runClient(["render", "--help"]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^usage: plurnk render \[--width <columns>\]\n/);
    assert.doesNotMatch(result.stdout, /Connects to the plurnk-service daemon/);
});

test("[§cli-render-filter] installed command renders stdin without daemon or startup narration", async () => {
    const result = await runFilter([
        "- [x] One checkbox",
        "- [ ] Another checkbox",
        "",
        "```json",
        "{\"healthy\":true}",
        "```",
    ].join("\n"), 48);

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "", "local projection emits no daemon banner or connection failure");
    assert.match(result.stdout, /^\* \[x\] One checkbox$/m);
    assert.doesNotMatch(result.stdout, /\[x\] \[x\]/);
    assert.match(result.stdout, /^💻 json$/m);
    assert.doesNotMatch(result.stdout, /\x1b\[/, "filter output is plain Unicode even when NO_COLOR is empty");
});

test("[§cli-render-filter] built filter reorients a wide vertical diagram for terminal and editor consumers", async () => {
    const result = await runFilter([
        "```mermaid",
        "graph TD",
        "    root[Root] --> a[First detailed topic with a complete label]",
        "    root --> b[Second detailed topic with a complete label]",
        "    root --> c[Third detailed topic with a complete label]",
        "    root --> d[Fourth detailed topic with a complete label]",
        "```",
    ].join("\n"), 80);

    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /mermaid source|graph TD|\x1b\[/);
    assert.match(result.stdout, /┌/);
    assert.match(result.stdout, /►/);
    for (const label of ["First", "Second", "Third", "Fourth"]) {
        assert.ok(result.stdout.includes(`${label} detailed topic with a complete label`));
    }
    assert.ok(result.stdout.split("\n").every((line) => line.length <= 80));
});
