// Model-GATED pty tests. Boots a daemon; the loop-running test is currently
// BLOCKED on svc#265 (see below). When #265 lands, restore the loop PROBE here
// (loop.run → await loop/terminated, finalStatus===200, bounded) to gate the
// test on a reachable provider key (FIREWORKS_API_KEY in ~/.plurnk/.env) vs CI.

import { test, before, after, describe } from "node:test";
import { bootDaemon, locateDaemon, type Daemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

let daemon: Daemon | null = null;

before(async () => {
    const bin = await locateDaemon();
    if (bin === null) return;
    daemon = await bootDaemon(bin);
});
after(async () => { await daemon?.cleanup(); });

describe("TUI live (model-gated)", () => {
    // The readline referendum — the CLIENT contract: a line typed while a loop is
    // in flight is folded in via loop.inject (NOT a new loop.run) and acknowledged,
    // with the prompt surviving the trace burst. The prompt is identical to idle —
    // injection is seamless, the user never sees it. (Whether the MODEL honors the
    // injected content is the model's behavior, not the client's.)
    test("mid-loop inject — a line typed during a loop is folded in (loop.inject)", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const d = daemon;  // capture before t.skip re-widens the closure-mutated let
        // BLOCKED on svc#265: under the Model-3 async loop.run, a loop that errors
        // or wedges never broadcasts loop/terminated, so any non-trivial loop in
        // this env hangs after the turn-0 foist — there's no reliable in-flight
        // window to inject into. Re-enable (+ restore the loop probe in before())
        // once #265 guarantees a terminal event.
        t.skip("blocked on svc#265 (loop wedges silently — no reliable in-flight window)");
        return;
        const tui = spawnTui(d.url);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            // Anything multi-step keeps the loop alive a beat; we inject on the
            // FIRST trace (the prompt foist) — the widest in-flight window, since
            // a fast model can finish a short loop before the keystroke lands.
            tui.write("Run python in several separate steps: print 1, then 2, then 3, then 4. Wait for each result before the next. Then summarize.\r");
            await tui.waitFor(/plurnk:\/\/\/prompt\/\d+\/1/, 30_000);  // the foist → loop in-flight
            tui.write("btw keep the summary short\r");
            await tui.waitFor(/↳ added to the run/, 25_000);     // loop.inject path (NOT a new loop.run)
        } finally { tui.kill(); }
    });
});
