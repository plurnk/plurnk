// Proves the explicit AG-UI URL overrides the assembled daemon host and port.

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

test("PLURNK_AGUI_URL reaches the in-process module despite an unusable host and port", async (t) => {
    if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
    const tui = spawnTui(daemon.url, [], {
        PLURNK_HOST: "127.0.0.1",
        PLURNK_PORT: "1",
        PLURNK_AGUI_URL: daemon.url,
    });
    try {
        await tui.waitFor(/plurnk.*\/help/);
        tui.write("/quit\r");
        await tui.waitFor(/resume this workspace:\s+plurnk --workspace /);
        assert.equal(await tui.exited, 0);
    } finally {
        tui.kill();
    }
});
