// [§cli-color-scheme] — the built TUI learns a colour terminal's ground before it paints anything.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootDaemon, locateDaemon, type Daemon } from "../intg/harness.ts";
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
