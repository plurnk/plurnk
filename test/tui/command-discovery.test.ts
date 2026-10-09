import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { actionViaAgui } from "../../src/agui.ts";
import { bootDaemon, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

for (const enabled of [false, true]) {
    test(`[§cli-interactive-command-discovery] built TUI projects MCP discovery ${enabled ? "present" : "absent"} in help and completion`, { timeout: 30_000 }, async (t) => {
        const service = await locateDaemon();
        assert.ok(service);
        const daemon = await bootDaemon(service, { extraEnv: { PLURNK_MCP_REGISTRY_URL: enabled ? "http://127.0.0.1:9" : "" } });
        t.after(daemon.cleanup);
        const advertised = await actionViaAgui<{ actions: Record<string, unknown> }>({ aguiUrl: daemon.url }, { threadId: "discovery", kind: "discover" });
        assert.equal(Object.hasOwn(advertised.actions, "workspace.mcp.discover"), enabled);
        const tui = spawnTui(daemon.url, ["--workspace", "discovery"], {
            HOME: daemon.home, XDG_CONFIG_HOME: join(daemon.home, ".config"), PLURNK_MODEL: "",
        }, daemon.workspace);
        t.after(() => tui.kill());
        await tui.waitFor(/plurnk[\s\S]*\/help/);
        let since = tui.output().length;
        tui.write("/help mcp\r");
        const help = await tui.waitFor(/\/mcp oauth <alias>/, 10_000, since);
        assert.equal(/\/mcp discover <query>/.test(help.slice(since)), enabled);
        since = tui.output().length;
        tui.write(enabled ? "/mcp disc\t" : "/mcp d\t");
        await tui.waitFor(enabled ? /\/mcp discover/ : /\/mcp disable/, 10_000, since);
        tui.write("\x15/quit\r");
        assert.equal(await tui.exited, 0);
    });
}
