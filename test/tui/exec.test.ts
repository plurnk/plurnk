import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { bootDaemon, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

test("[§cli-stream-event-and-stream-concluded] a refused human execution renders its operation and Problem without waiting for a stream", { timeout: 30_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service);
    const daemon = await bootDaemon(service);
    t.after(daemon.cleanup);
    const tui = spawnTui(daemon.url, ["--workspace", "exec-refused", "--capabilities", '{"deny":[{"runtime":"sh"}]}'], {
        HOME: daemon.home, XDG_CONFIG_HOME: join(daemon.home, ".config"), PLURNK_MODEL: "",
    }, daemon.workspace);
    t.after(() => tui.kill());
    await tui.waitFor(/plurnk[\s\S]*\/help/);
    const since = tui.output().length;
    tui.write("! echo denied\r");
    const output = await tui.waitFor(/sh — Capability denied/, 10_000, since);
    assert.match(output.slice(since), /echo denied/);
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);
});
