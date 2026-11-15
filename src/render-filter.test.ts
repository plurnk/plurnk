// Local `plurnk render` filter tests ({§cli-markdown-projection}, {§cli-rendering}, {§cli-color-policy}).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { renderMarkdown } from "./render-filter.ts";

const binPath = resolve(import.meta.dirname, "../bin/plurnk.js");

const runRenderCli = async (
    args: readonly string[],
    source: string = "",
    env: NodeJS.ProcessEnv = {},
): Promise<{
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
}> =>
    await new Promise((resolveRun, reject) => {
        const mergedEnv: NodeJS.ProcessEnv = {
            ...process.env,
            NO_COLOR: "",
            FORCE_COLOR: "1",
            PLURNK_ACP_URL: "http://127.0.0.1:1/acp",
            ...env,
        };
        if ("PLURNK_CLIENT_MERMAID_TIMEOUT_MS" in env && env.PLURNK_CLIENT_MERMAID_TIMEOUT_MS === undefined) {
            delete mergedEnv.PLURNK_CLIENT_MERMAID_TIMEOUT_MS;
        }
        const child = spawn(process.execPath, ["--max-old-space-size=256", binPath, ...args], {
            env: mergedEnv,
            timeout: 8000,
            killSignal: "SIGKILL",
            stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (code) => resolveRun({ code, stdout, stderr }));
        child.stdin.end(source);
    });

describe("renderMarkdown", () => {
    it("{§cli-markdown-projection} delegates headings, inline emphasis, math, lists, blockquotes, and code to pi-tui", async () => {
        const out = await renderMarkdown(
            [
                "# Hello",
                "",
                "This is **bold**, *italic*, and $\\rightarrow$.",
                "",
                "- one",
                "- two",
                "",
                "> A quote",
                "",
                "```text",
                "$\\rightarrow$ **not bold**",
                "```",
            ].join("\n"),
            60,
        );
        assert.doesNotMatch(out, /\x1b/u);
        assert.match(out, /^Hello$/mu);
        assert.match(out, /This is bold, italic, and →\./u);
        assert.match(out, /^- one\n- two$/mu);
        assert.match(out, /^│ A quote$/mu);
        assert.match(out, /```text\n  \$\\rightarrow\$ \*\*not bold\*\*\n```/u);
    });

    it("{§cli-markdown-projection} renders pipe tables as aligned box-drawn Unicode", async () => {
        const out = await renderMarkdown("| A | B |\n|---|---|\n| 1 | 2 |", 60);
        assert.match(out, /┌───┬───┐/u);
        assert.match(out, /│ A │ B │/u);
        assert.match(out, /│ 1 │ 2 │/u);
    });

    it("{§cli-markdown-projection} renders Mermaid diagrams and transposes wide vertical flowcharts", async () => {
        const out = await renderMarkdown(
            [
                "```mermaid",
                "graph TD",
                "    root[Root] --> a[First detailed topic with a complete label]",
                "    root --> b[Second detailed topic with a complete label]",
                "    root --> c[Third detailed topic with a complete label]",
                "    root --> d[Fourth detailed topic with a complete label]",
                "```",
            ].join("\n"),
            80,
        );
        assert.doesNotMatch(out, /💻 mermaid|graph TD|\x1b/u);
        assert.match(out, /┌/u);
        assert.match(out, /►/u);
        for (const label of ["First", "Second", "Third", "Fourth"]) {
            assert.ok(out.includes(`${label} detailed topic with a complete label`));
        }
        assert.ok(out.trimEnd().split("\n").every((line) => line.length <= 80));
    });

    it("{§cli-markdown-projection} handles empty input without trailing output", async () => {
        assert.equal(await renderMarkdown("", 60), "");
    });

    it("{§cli-markdown-projection} {§cli-rendering} {§cli-color-policy} CLI `plurnk render` runs daemon-free, ANSI-free, and honors --mermaid-timeout-ms", async () => {
        const help = await runRenderCli(["render", "--help"]);
        assert.equal(help.code, 0);
        assert.equal(help.stderr, "");
        assert.match(help.stdout, /^usage: plurnk render \[--width <columns>\] \[--mermaid-timeout-ms <n>\]\n/u);
        assert.doesNotMatch(help.stdout, /Connects to plurnk-service/u);

        const source = "```mermaid\ngraph TD\nA-->B\n```";
        const invalid = await runRenderCli(["render"], source, {
            PLURNK_CLIENT_MERMAID_TIMEOUT_MS: "invalid",
        });
        assert.equal(invalid.code, 0, invalid.stderr);
        assert.match(invalid.stdout, /💻 mermaid — diagram failed to render: PLURNK_CLIENT_MERMAID_TIMEOUT_MS/u);
        assert.doesNotMatch(invalid.stdout, /\x1b/u, "FORCE_COLOR=1 never leaks ANSI into plurnk render");

        const overridden = await runRenderCli(["render", "--mermaid-timeout-ms=1000"], source, {
            PLURNK_CLIENT_MERMAID_TIMEOUT_MS: "invalid",
        });
        assert.equal(overridden.code, 0, overridden.stderr);
        assert.equal(overridden.stderr, "");
        assert.match(overridden.stdout, /┌/u);
        assert.doesNotMatch(overridden.stdout, /diagram failed to render/u);

        const fanIn = await readFile(new URL("../test/fixtures/mermaid-fan-in.md", import.meta.url), "utf8");
        const bounded = await runRenderCli(["render", "--width", "135", "--mermaid-timeout-ms=250"], `${fanIn}\nStill responsive.`, {
            PLURNK_CLIENT_MERMAID_TIMEOUT_MS: undefined,
        });
        assert.equal(bounded.code, 0, bounded.stderr);
        assert.equal(bounded.stderr, "");
        assert.match(bounded.stdout, /^💻 mermaid — diagram failed to render$/mu);
        assert.match(bounded.stdout, /│     MODEL <--> MODELS/u);
        assert.match(bounded.stdout, /Still responsive\./u);
        assert.doesNotMatch(bounded.stdout, /\x1b/u);
    });
});
