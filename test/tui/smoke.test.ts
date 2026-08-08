// Proves the PTY harness actually drives keystrokes and captures output —
// the prerequisite for any TUI coverage claim (live e2e checklist item #1).
// Daemon-gated, NOT model-gated: /help and /quit never call loop.run, so this
// runs reliably wherever the service binary is reachable.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { bootDaemon, locateDaemon, type Daemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

let daemon: Daemon | null = null;

before(async () => {
    const bin = await locateDaemon();
    if (bin === null) return;            // no service checkout → suite skips per-test
    daemon = await bootDaemon(bin);
});

after(async () => { await daemon?.cleanup(); });

describe("TUI pty harness", () => {
    test("[§cli-tui-mode] banner renders, a verb dispatches, /quit exits clean", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url);
        try {
            // 1. The startup header proves the TUI connected and is at the prompt.
            await tui.waitFor(/plurnk.*\/help/);
            // 2. A verb keystroke round-trips: /help prints the verb table.
            tui.write("/help\r");
            const afterHelp = await tui.waitFor(/\/models .*\/workspaces/);
            assert.match(afterHelp, /\/yolo/, "help lists the verb surface");
            // 3. /quit closes the REPL with a clean exit code + the resume hint.
            tui.write("/quit\r");
            await tui.waitFor(/resume this workspace:\s+plurnk --workspace /);
            assert.equal(await tui.exited, 0, "/quit exits 0");
            assert.match(tui.output(), /resume this workspace:\s+plurnk --workspace /, "quit prints the resume one-liner");
        } finally {
            tui.kill();
        }
    });

    test("an Alt-shortcut dispatches a verb (Alt-m → /models)", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write("\x1bm");                 // ESC m = Alt-m → /models
            await tui.waitFor(/alias|model|\(no models/i, 8_000);
            tui.write("/quit\r");
            assert.equal(await tui.exited, 0);
        } finally {
            tui.kill();
        }
    });
});
