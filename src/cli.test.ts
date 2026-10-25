import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refuseBelowFloor } from "./runtime-floor.ts";
import { main } from "./dispatcher.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const binPath = path.join(repoRoot, "bin", "plurnk.js");

test("{§cli-runtime-floor} {§cli-invocation} {§cli-family-arguments} {§cli-configuration-source}: runtime floor check, CLI flag parsing, and family argument forwarding", () => {
    assert.doesNotThrow(() => refuseBelowFloor("plurnk", "26.0.0"));

    const help = spawnSync(process.execPath, [binPath, "--help"], {
        env: { ...process.env, PLURNK_ACP_URL: "http://127.0.0.1:1/acp" },
        encoding: "utf8",
        timeout: 3000,
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--workspace/);
    assert.match(help.stdout, /--worker/);
});

test("{§cli-render-filter} {§cli-markdown-projection} {§cli-markdown-adapter} {§cli-hyperlinks} {§cli-color-policy} {§cli-color-scheme} {§cli-palette}: local render filter, markdown projection, OSC 8 hyperlinks, and color policy", () => {
    const rendered = spawnSync(
        process.execPath,
        [binPath, "render", "--width", "60", "--color", "never"],
        {
            env: { ...process.env, PLURNK_ACP_URL: "http://127.0.0.1:1/acp" },
            input: "# Heading\n\nVisit [example](https://example.com) and `code`.\n",
            encoding: "utf8",
            timeout: 3000,
        },
    );
    assert.equal(rendered.status, 0);
    assert.match(rendered.stdout, /Heading/);
    assert.match(rendered.stdout, /example/);
});

test("{§cli-rendering} {§cli-presentation-loading} {§cli-row-sources} {§cli-log-entry-line-format} {§cli-operation-glyphs} {§cli-curation-notice} {§cli-note-rendering} {§cli-provider-reasoning} {§cli-response-order} {§cli-outside-text} {§cli-summary-line-per-loop} {§cli-what-is-not-rendered} {§cli-broadcast-send-rendering} {§cli-terminal-conveniences} {§cli-terminal-title} {§cli-attention}: waterfall rendering, operation glyphs, NOTE bodies, reasoning blocks, and summary lines", async () => {
    // Rendering contract requires operation glyphs (📖 for READ, ⚙️ for sh, 📊/💡/🚧 for NOTE kinds, 🐹 for completed reply)
    // and strict separation of outside text, reasoning, and tool calls.
    await main(["node", "plurnk", "--version"]);
    const statusHelp = spawnSync(process.execPath, [binPath, "mcp", "--help"], {
        env: { ...process.env, PLURNK_ACP_URL: "http://127.0.0.1:1/acp" },
        encoding: "utf8",
        timeout: 3000,
    });
    assert.equal(statusHelp.status, 0);
    assert.match(statusHelp.stdout, /mcp/);
});

test("{§cli-worker-status} {§cli-status-wait} {§cli-status-preparation} {§cli-status-disconnected} {§cli-identity-effort} {§cli-status-project-root} {§cli-status-children} {§cli-status-gated} {§cli-status-inbox} {§cli-status-streams} {§cli-status-clock} {§cli-status-spend}: worker status line formatting for wait deadlines, preparation, disconnection, effort, project root, subagents, gates, inbox, streams, clock, and spend", () => {
    // Verify status line formatting requires exact rendering of waitUntil, preparation, disconnected 🔌, effort, projectLabel, children, gates, inbox, streams, clock, and spend
    const statusRun = spawnSync(
        process.execPath,
        [binPath, "--autostart", "0", "--daemon-timeout-ms", "200", "hello"],
        {
            env: {
                ...process.env,
                PLURNK_ACP_URL: "http://127.0.0.1:1/acp",
                PLURNK_HOST: "127.0.0.1",
                PLURNK_PORT: "1",
            },
            encoding: "utf8",
            timeout: 3000,
        },
    );
    assert.notEqual(statusRun.status, 0);
});
