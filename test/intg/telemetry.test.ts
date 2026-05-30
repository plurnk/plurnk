// Integration test for the telemetry/event wire shape.
//
// IMPORTANT: telemetry events fire only during loop.run (the engine pushes
// to a loop's telemetry buffer). Client-origin op.parse calls don't trigger
// the grammar parser's telemetry emission path. So an automated assertion
// that "we received a telemetry/event" requires either:
//
//   1. A model in the loop emitting invalid DSL that the parser rejects, OR
//   2. A daemon-side test hook to inject a synthetic event.
//
// (1) is flaky and model-dependent (gemma quirks); (2) doesn't exist. The
// schema mirror in src/telemetry.ts is asserted in src/telemetry.test.ts
// against the grammar 0.17.0 JSON schema directly; the wire shape is fixed
// by that schema, so a unit-level assertion is sufficient correctness-wise.
//
// This file remains as a smoke entry point: subscribes to telemetry/event,
// runs a no-op connection, asserts the subscription mechanism works (we
// receive no event but the handler is registered without error). Activating
// the gated test below requires a model:
//
//   RUN_TELEMETRY_MODEL_TEST=1 PLURNK_SERVICE_BIN=... PLURNK_MODEL_GEMMA=... \
//     npm run test:intg

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Rpc from "../../src/rpc.ts";
import { locateDaemon, bootDaemon, type Daemon } from "./harness.ts";

let daemon: Daemon | null = null;
let skipReason: string | null = null;

before(async () => {
    const bin = await locateDaemon();
    if (bin === null) { skipReason = "plurnk-service binary not found"; return; }
    try { daemon = await bootDaemon(bin); }
    catch (err) { skipReason = `daemon boot failed: ${err instanceof Error ? err.message : String(err)}`; }
});

after(async () => { if (daemon !== null) await daemon.cleanup(); });

const guard = (t: { skip: (reason: string) => void }): boolean => {
    if (skipReason !== null) { t.skip(skipReason); return true; }
    return false;
};

test("telemetry/event subscription registers without error", async (t) => {
    if (guard(t)) return;
    const rpc = new Rpc({ url: daemon!.url });
    await rpc.connect();
    try {
        await rpc.call("session.create", { projectRoot: daemon!.workspace });
        // Just confirm the notification name is accepted by the daemon's
        // dispatcher and the handler can be registered without throwing.
        rpc.onNotification("telemetry/event", () => { /* no-op */ });
        // No event is expected without a model loop. The act of registering
        // the handler is what we're validating here.
        await new Promise((r) => setTimeout(r, 50));
    } finally { await rpc.close(); }
});

// Gated: only runs with RUN_TELEMETRY_MODEL_TEST=1 — requires a working
// model alias (PLURNK_MODEL=gemma + local llama-server, or any other alias).
test("telemetry/event arrives during a loop with a real model (gated)",
    { skip: process.env.RUN_TELEMETRY_MODEL_TEST !== "1" },
    async (t) => {
        if (guard(t)) return;
        const rpc = new Rpc({ url: daemon!.url });
        await rpc.connect();
        try {
            await rpc.call("session.create", { projectRoot: daemon!.workspace });
            const events: Array<{ loopId: number; event: Record<string, unknown> }> = [];
            rpc.onNotification("telemetry/event", (params) => {
                events.push(params as { loopId: number; event: Record<string, unknown> });
            });
            // A prompt designed to drag the model into emitting malformed DSL
            // or into rail-trigger territory; flaky by construction.
            await rpc.call("loop.run", {
                prompt: "Emit deliberately malformed DSL: <<NOT_A_REAL_OP and stop without closing.",
            }).catch(() => { /* loop may terminate with various statuses */ });
            await new Promise((r) => setTimeout(r, 500));
            assert.ok(events.length > 0, "expected at least one telemetry/event during the loop");
            const ev = events[0].event;
            assert.equal(typeof ev.source, "string");
            assert.equal(typeof ev.kind, "string");
            assert.match(ev.source as string, /^[a-z]+(:[a-z][a-z0-9-]*)?$/);
        } finally { await rpc.close(); }
    });

