// [§cli-color-scheme] — the built TUI learns a colour terminal's ground before it paints anything.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootDaemon, completionsEndpoint, locateDaemon, type Daemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

let daemon: Daemon | null = null;

before(async () => {
    const bin = await locateDaemon();
    if (bin === null) return;
    daemon = await bootDaemon(bin);
});

after(async () => { await daemon?.cleanup(); });

// The harness daemon has no model, so startup paints the No-model warning in the warning accent.
const startupWarning = async (background: string): Promise<string> => {
    const tui = spawnTui(daemon!.url, ["--yolo"], { NO_COLOR: undefined, COLORFGBG: undefined, PLURNK_CLIENT_COLOR: "always" });
    try {
        await tui.waitFor(/\x1b\]11;\?/u);
        tui.write(`\x1b]11;rgb:${background}\x07\x1b[?62;22c`);
        const output = await tui.waitFor(/No model selected\./u);
        tui.write("/quit\r");
        assert.equal(await tui.exited, 0, "the answer left the composer empty, so /quit ran alone");
        return output;
    } finally {
        tui.kill();
    }
};

test("[§cli-color-scheme] a light terminal's startup warning takes the light ground's orange", async (t) => {
    if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
    const output = await startupWarning("ffff/ffff/ffff");
    assert.match(output, /\x1b\[38;5;130m│/u);
    assert.doesNotMatch(output, /38;5;172/u);
});

test("[§cli-color-scheme] a dark terminal's startup warning keeps the dark ground's orange", async (t) => {
    if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
    const output = await startupWarning("0000/0000/0000");
    assert.match(output, /\x1b\[38;5;172m│/u);
    assert.doesNotMatch(output, /38;5;130/u);
});

test("[§cli-color-scheme] the built TUI shares a readable muted foreground across prompt, status, summary and inline code", async (t) => {
    const service = await locateDaemon();
    assert.ok(service);
    const endpoint = await completionsEndpoint(() => "````SEND [200]\n## Sample\n\nPlain `inline` text.\n````");
    t.after(endpoint.close);
    const modelDaemon = await bootDaemon(service, { extraEnv: {
        PLURNK_MODEL: "colorfixture", PLURNK_MODEL_colorfixture: "openai/color-fixture",
        OPENAI_BASE_URL: endpoint.url, OPENAI_API_KEY: "fixture",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768", PLURNK_PROVIDERS_EFFORT: "off", PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(modelDaemon.cleanup);
    for (const [scheme, background, index] of [["light", "fdfd/f6f6/e3e3", 60], ["dark", "0000/2b2b/3636", 145], ["never", "", null]] as const) {
        await t.test(scheme, async (t) => {
            const tui = spawnTui(modelDaemon.url, ["--workspace", `color-${scheme}`, "--project-root", "", "--max-turns", "2"], {
                HOME: modelDaemon.home, XDG_CONFIG_HOME: `${modelDaemon.home}/.config`, PLURNK_MODEL: "",
                NO_COLOR: undefined, COLORFGBG: undefined, PLURNK_CLIENT_COLOR: scheme === "never" ? "never" : "always",
            }, modelDaemon.workspace);
            t.after(() => tui.kill());
            if (scheme !== "never") {
                await tui.waitFor(/\x1b\]11;\?/u);
                tui.write(`\x1b]11;rgb:${background}\x07\x1b[?62;22c`);
            }
            await tui.waitFor(/plurnk.*\/help/s);
            tui.write("Reply with the sample.\r");
            const output = await tui.waitFor(/done · 2 turns ·/);
            if (index === null) {
                assert.match(output, /Plain inline text\./);
                assert.doesNotMatch(output, /\x1b\[38;/);
            } else {
                const foreground = `\x1b[38;5;${index}m`;
                assert.ok(output.includes(`${foreground}─`), "prompt borders");
                assert.ok(output.includes(`${foreground}[color-${scheme}/`), "statusline");
                assert.ok(output.includes(`${foreground}  done · 2 turns ·`), "completion summary");
                assert.ok(output.includes(`Plain ${foreground}inline\x1b[0m text.`), "inline code leaves ordinary response text uncoloured");
            }
            assert.doesNotMatch(output, /\x1b\[2m/, "no terminal-dependent faint text");
            tui.write("/quit\r");
            assert.equal(await tui.exited, 0);
        });
    }
});
