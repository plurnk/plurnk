import { test } from "node:test";
import assert from "node:assert/strict";
import { bootDaemon, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

// The status line's place row, the last line of the screen that names the bound workspace.
const placeRow = (screen: string): string => screen.split("\n").findLast((line) => line.includes("[disconnect/~main")) ?? "";

test("[§cli-status-disconnected] 🔌 leads the status line once the daemon stopping ends the session's observation", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service, "the composed client test requires the sibling service");
    const daemon = await bootDaemon(service, { readyTimeoutMs: 30_000 });
    t.after(() => daemon.cleanup());
    const tui = spawnTui(daemon.url, ["--workspace", "disconnect", "--worker", "main", "--project-root", ""],
        { HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config` }, daemon.workspace);
    t.after(() => tui.kill());
    await tui.waitFor(/plurnk[\s\S]*\/help/);
    const observing = await tui.waitForScreen(/\[disconnect\/~main/u);
    assert.doesNotMatch(placeRow(observing), /🔌/u, "observing: no plug");

    process.kill(daemon.pid, "SIGTERM");
    const lost = await tui.waitForScreen(/\[disconnect\/~main[^\n]*🔌/u, 20_000);
    assert.match(placeRow(lost), /🔌/u, "the observation the daemon's stop ended leaves the session disconnected");
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);
});
