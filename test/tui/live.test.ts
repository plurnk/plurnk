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
    // The readline referendum — the CLIENT contract: while a loop runs the prompt
    // becomes the steer row, and a line typed there goes out as loop.inject (not a
    // new loop.run) and is acknowledged, with the prompt surviving the trace burst.
    // (Whether the MODEL honors the injected content is the model's behavior.)
    test("mid-loop inject — steer prompt holds; the line goes out as loop.inject", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        if (!canLoop) { t.skip("no working model (no provider key in ~/.plurnk/.env)"); return; }
        const tui = spawnTui(daemon.url);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            // Multi-step so the loop is reliably still in-flight when we inject.
            tui.write("Run SIX separate python steps, ONE number per step, never batched — print(1), then print(2)…print(6) — waiting for each result before the next. Then summarize.\r");
            await tui.waitFor(/steer \(loop running/, 30_000);   // inFlight → steer prompt
            tui.write("btw keep the summary short\r");
            await tui.waitFor(/↳ injected/, 20_000);             // loop.inject path (NOT a new loop.run)
        } finally { tui.kill(); }
    });
});
