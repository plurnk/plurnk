// Model-GATED pty tests. Boot a daemon and PROBE whether it can run a loop —
// it can iff a provider key is reachable (FIREWORKS_API_KEY in ~/.plurnk/.env,
// the shared config home). Present → run; absent (e.g. CI) → skip. No manual URL.

import { test, before, after, describe } from "node:test";
import { bootDaemon, locateDaemon, type Daemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";
import Rpc from "../../src/rpc.ts";

let daemon: Daemon | null = null;
let canLoop = false;

// Can this daemon actually run a model loop? (key present vs not)
const probeLoop = async (url: string): Promise<boolean> => {
    const rpc = new Rpc({ url });
    try {
        await rpc.connect();
        await rpc.call("session.create", { projectRoot: process.cwd() });
        const r = await rpc.call("loop.run", { prompt: "Reply with only: ok", maxTurns: 2 }) as { finalStatus: number };
        await rpc.close();
        return r.finalStatus === 200;
    } catch { try { await rpc.close(); } catch { /* already closed */ } return false; }
};

before(async () => {
    const bin = await locateDaemon();
    if (bin === null) return;
    daemon = await bootDaemon(bin);
    canLoop = await probeLoop(daemon.url);
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
        if (!canLoop) { t.skip("no working model (no provider key in ~/.plurnk/.env)"); return; }
        const tui = spawnTui(daemon.url);
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
