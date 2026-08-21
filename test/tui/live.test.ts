// Explicit real-model pty tier. The deterministic TUI gate loads no operator
// configuration and never performs inference; `npm run test:tui:live` opts into
// the operator config and requires an explicitly selected PLURNK_MODEL.

import { test, before, after, describe } from "node:test";
import { bootDaemon, locateDaemon, type Daemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

let daemon: Daemon | null = null;
const liveEnabled = process.env.PLURNK_CLIENT_LIVE === "1";
const liveModel = process.env.PLURNK_MODEL;

before(async () => {
    if (!liveEnabled) return;
    if (liveModel === undefined || liveModel.length === 0) {
        throw new Error("test:tui:live requires an explicit PLURNK_MODEL selector");
    }
    const bin = await locateDaemon();
    if (bin === null) return;
    daemon = await bootDaemon(bin, {
        inheritOperatorConfig: true,
        extraEnv: { PLURNK_MODEL: liveModel },
    });
});
after(async () => { await daemon?.cleanup(); });

describe("TUI live (model-gated)", () => {
    // The readline referendum — the CLIENT contract: a line typed while a loop is
    // in flight is folded in via loop.inject (NOT a new loop.run) and acknowledged,
    // with the prompt surviving the trace burst. The prompt is identical to idle —
    // injection is seamless, the user never sees it. (Whether the MODEL honors the
    // injected content is the model's behavior, not the client's.)
    // 10-minute test budget + 9-minute waits below: dramatically generous so a
    // failure is unambiguously a real hang (svc#265 is fixed — errored loops now
    // broadcast loop/terminated), never "the model was slow." Only daemon-gated.
    test("[§cli-tui-flow] mid-loop inject — a line typed during a loop is folded in (loop.inject)", { timeout: 600_000 }, async (t) => {
        if (!liveEnabled) { t.skip("real-model tier requires npm run test:tui:live"); return; }
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            // Anything multi-step keeps the loop alive a beat. Inject as soon as
            // the TUI displays its deterministic in-flight status; durable prompt
            // rows are deliberately suppressed because readline already shows them.
            tui.write("Run python in several separate steps: print 1, then 2, then 3, then 4. Wait for each result before the next. Then summarize.\r");
            await tui.waitFor(/⏳/, 540_000);
            tui.write("btw keep the summary short\r");
            await tui.waitFor(/↳ added to the run/, 540_000);     // loop.inject path (NOT a new loop.run)
        } finally { tui.kill(); }
    });
});
