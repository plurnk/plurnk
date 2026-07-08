// TUI-over-bridge coverage (plurnk-agui#1 Phase C). Right now it proves the
// harness ENABLER — bootBridge stands up a real plurnk-agui bridge against a real
// daemon — so the REPL-migration wiring can be TDD'd here rather than only
// hand-smoked. Once runTui routes through the transport, this grows to drive a
// bridge-mode TUI (spawnTui with PLURNK_AGUI_URL) and assert the waterfall.
//
// Double-gated: skips without a plurnk-service binary OR a plurnk-agui checkout.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { bootDaemon, locateDaemon, type Daemon } from "../intg/harness.ts";
import { bootBridge, spawnTui } from "./harness.ts";

let daemon: Daemon | null = null;
let bridge: { url: string; kill: () => void } | null = null;

before(async () => {
    const bin = await locateDaemon();
    if (bin === null) return;
    daemon = await bootDaemon(bin);
    bridge = await bootBridge(daemon.url);
});

after(async () => {
    bridge?.kill();
    await daemon?.cleanup();
});

test("bootBridge: a real bridge serves against the daemon (the pty enabler for TUI-over-bridge)", async (t) => {
    if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
    if (bridge === null) { t.skip("no plurnk-agui sibling checkout"); return; }
    // GET / isn't a route (POST / runs) — a 404 with the usage error proves the
    // bridge is up, routing, and reachable at the banner URL.
    const res = await fetch(`${bridge.url}/`, { method: "GET" });
    assert.equal(res.status, 404, "bridge serving: GET / → 404");
    const body = await res.json() as { error?: string };
    assert.match(body.error ?? "", /POST/, "the router's usage hint");
});

test("TUI over the bridge: a prompt runs through the portal and renders in the waterfall", async (t) => {
    if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
    if (bridge === null) { t.skip("no plurnk-agui sibling checkout"); return; }
    // PLURNK_AGUI_URL set + no prompt → the dispatcher's TUI-bridge branch: no WS
    // connect, BridgeTransport drives the run. (PLURNK_WS is set but unused.)
    const tui = spawnTui(daemon.url, [], { PLURNK_AGUI_URL: bridge.url });
    try {
        await tui.waitFor(/\/help/, 15_000);
        tui.write("Say hi in one short sentence.\r");
        // The run streams through the bridge → plurnk.row → the waterfall, and on
        // terminate the loop summary renders its token tally (↑prompt ↓completion) —
        // NOT in the prompt, so matching it proves the full round-trip through the
        // portal (terminated + summary), not an echo of the typed line.
        await tui.waitFor(/↑\d+ ↓\d+/, 90_000);
        tui.write("/quit\r");
        assert.equal(await tui.exited, 0);
    } finally { tui.kill(); }
});
