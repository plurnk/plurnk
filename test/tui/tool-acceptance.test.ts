import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { bootDaemon, completionsEndpoint, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

test("[§cli-tool-acceptance]: built TUI auto-accepts a configured runtime but explicit review still waits for the human", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service);
    let calls = 0;
    const endpoint = await completionsEndpoint(() => ++calls % 2 === 1
        ? "````sh\nprintf permitted > witness.txt\n````"
        : "````KILL\nApproval fixture finished.\n````");
    t.after(endpoint.close);
    const daemon = await bootDaemon(service, { extraEnv: {
        PLURNK_MODEL: "approvalfixture", PLURNK_MODEL_approvalfixture: "openai/approval-fixture",
        PLURNK_BASEURL_approvalfixture: endpoint.url, OPENAI_BASE_URL: endpoint.url, OPENAI_API_KEY: "fixture",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768", PLURNK_PROVIDERS_EFFORT: "off", PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(daemon.cleanup);
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    const tui = spawnTui(daemon.url, ["--workspace", "acceptance", "--worker", "main", "--no-git", "--max-turns", "4"], {
        HOME: daemon.home, XDG_CONFIG_HOME: join(daemon.home, ".config"), PLURNK_MODEL: "",
        PLURNK_CLIENT_YOLO: "0", PLURNK_CLIENT_ACCEPT_sh: "1",
    }, daemon.workspace);
    t.after(() => tui.kill());
    await tui.waitFor(/plurnk[\s\S]*\/help/);
    let since = tui.output().length;
    tui.write("Write the witness.\r");
    await tui.waitFor(/Approval fixture finished\./, 20_000, since);
    await tui.waitFor(/done · 3 turns ·/, 20_000, since);
    assert.doesNotMatch(tui.output().slice(since), /↑\/↓: choose.*Enter: confirm/);
    assert.equal(await readFile(join(daemon.workspace, "witness.txt"), "utf8"), "permitted");
    since = tui.output().length;
    tui.write("? Require review this time.\r");
    await tui.waitFor(/↑\/↓: choose.*Enter: confirm.*Esc: composer/, 20_000, since);
    assert.equal(calls, 3, "explicit review has not resumed the model");
    tui.write("\x1b");
    await tui.waitFor(/1 pending review.*\/review/, 10_000, since);
    tui.write("/stop\r");
    await tui.waitFor(/cancelled|final 499/, 10_000, since);
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);
});
