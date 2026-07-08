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
import { bootBridge } from "./harness.ts";

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
