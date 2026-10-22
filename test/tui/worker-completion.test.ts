import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { bootDaemon, completionsEndpoint, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

test("[§cli-workers-topology] /worker completes a worker the waterfall has shown, until the binding changes", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service, "the composed test requires the sibling service");
    let calls = 0;
    // The model addresses a worker the directory does not hold: only the waterfall can name it.
    const endpoint = await completionsEndpoint(() => calls++ === 0
        ? "````SEND (worker://helper)\nAre you there?\n````\n\n````SEND [200]\nAsked the helper.\n````"
        : "````SEND [200]\nAsked the helper.\n````");
    t.after(() => endpoint.close());
    const daemon = await bootDaemon(service, { extraEnv: {
        PLURNK_MODEL: "harvestfixture", PLURNK_MODEL_harvestfixture: "openai/harvest-fixture",
        OPENAI_BASE_URL: endpoint.url, OPENAI_API_KEY: "harvest-fixture", PLURNK_PROVIDERS_EFFORT: "off",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768", PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(() => daemon.cleanup());
    const tui = spawnTui(daemon.url, ["--workspace", "harvest", "--worker", "main", "--project-root", "", "--max-turns", "3"], {
        HOME: daemon.home, XDG_CONFIG_HOME: join(daemon.home, ".config"), PLURNK_MODEL: "",
    }, daemon.home);
    t.after(() => tui.kill());
    t.after(() => { if (!t.passed) t.diagnostic(tui.output().slice(-4_000)); });
    await tui.waitFor(/workspace: harvest/);

    let start = tui.output().length;
    tui.write("Ask the helper.\r");
    await tui.waitFor(/Asked the helper\./, 20_000, start);
    await tui.waitFor(/done · \d+ turns? ·/, 10_000, tui.output().lastIndexOf("Asked the helper."));

    start = tui.output().length;
    tui.write("/worker hel\t");
    await tui.waitFor(/\/worker helper/, 10_000, start);

    tui.write("\x15/worker other\r");
    await tui.waitFor(/worker: other \(new\)/, 10_000, start);

    // The new binding's waterfall has shown no helper, and the directory holds none.
    start = tui.output().length;
    tui.write("/worker hel\tX");
    await tui.waitFor(/\/worker helX/, 10_000, start);
    tui.write("\x15");
});
