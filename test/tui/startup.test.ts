import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnTui } from "./harness.ts";

for (const workspace of [undefined, "startup-worker"]) {
    test(`[§cli-problem-control-flow] TUI connection refusal is a diagnostic before binding ${workspace ?? "a new workspace"}`, { timeout: 10_000 }, async (t) => {
        const home = await mkdtemp(join(tmpdir(), "plurnk-tui-startup-"));
        t.after(() => rm(home, { recursive: true, force: true }));
        const server = createServer();
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        assert.ok(address !== null && typeof address === "object");
        await new Promise<void>((resolve) => server.close(() => resolve()));
        const tui = spawnTui(`http://127.0.0.1:${address.port}`, workspace === undefined ? [] : ["--workspace", workspace], {
            HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PLURNK_CLIENT_WORKSPACE: undefined, PLURNK_CLIENT_WORKER: undefined,
        }, home);
        t.after(() => tui.kill());
        assert.equal(await tui.exited, 1);
        assert.match(tui.output(), /Caution client:connection:refused/);
        assert.match(tui.output(), /No daemon is running/);
        assert.match(tui.output(), /npx @plurnk\/plurnk-service/);
        assert.doesNotMatch(tui.output(), /\n\s+at |TypeError:|node_modules\//);
    });
}
