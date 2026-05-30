// Integration tests for the RPC surface the client calls. Boots a real
// plurnk-service subprocess and exercises each RPC; verifies that the
// shapes match what cli/dispatcher/subcommands expect.
//
// Skip behavior: when the daemon binary cannot be located OR fails to boot,
// every test in this file calls t.skip(reason) — so npm run test:intg stays
// green on machines without a plurnk-service checkout.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import Rpc from "../../src/rpc.ts";
import { locateDaemon, bootDaemon, type Daemon } from "./harness.ts";

let daemon: Daemon | null = null;
let rpc: Rpc | null = null;
let skipReason: string | null = null;

before(async () => {
    const bin = await locateDaemon();
    if (bin === null) { skipReason = "plurnk-service binary not found (set PLURNK_SERVICE_BIN or check out sibling)"; return; }
    try {
        daemon = await bootDaemon(bin);
        rpc = new Rpc({ url: daemon.url });
        await rpc.connect();
    } catch (err) {
        skipReason = `daemon boot failed: ${err instanceof Error ? err.message : String(err)}`;
    }
});

after(async () => {
    if (rpc !== null) await rpc.close();
    if (daemon !== null) await daemon.cleanup();
});

// Each test guards with skip-on-no-daemon.
const guard = (t: { skip: (reason: string) => void }): boolean => {
    if (skipReason !== null) { t.skip(skipReason); return true; }
    return false;
};

// ─── session.* ────────────────────────────────────────────────────────

test("session.create returns {id, name} with new session", async (t) => {
    if (guard(t)) return;
    const result = await rpc!.call("session.create", { projectRoot: daemon!.workspace }) as { id: number; name: string };
    assert.equal(typeof result.id, "number");
    assert.equal(typeof result.name, "string");
    assert.ok(result.name.length > 0);
});

test("session.list returns sessions with expected SessionRow shape", async (t) => {
    if (guard(t)) return;
    const { sessions } = await rpc!.call("session.list") as { sessions: Array<{ id: number; name: string; project_root: string | null; created_at: string; cost_pico: number }> };
    assert.ok(Array.isArray(sessions));
    assert.ok(sessions.length > 0, "expected at least the session we just created");
    const s = sessions[0];
    assert.equal(typeof s.id, "number");
    assert.equal(typeof s.name, "string");
    assert.ok(s.project_root === null || typeof s.project_root === "string");
    assert.equal(typeof s.created_at, "string");
    assert.equal(typeof s.cost_pico, "number");
});

test("session.attach({id}) with valid id returns envelope", async (t) => {
    if (guard(t)) return;
    // Need a fresh connection for attach (one session per connection).
    const conn = new Rpc({ url: daemon!.url });
    await conn.connect();
    try {
        const { sessions } = await conn.call("session.list") as { sessions: Array<{ id: number; name: string }> };
        const attached = await conn.call("session.attach", { id: sessions[0].id, runName: "intg-run-1" }) as { id: number; name: string };
        assert.equal(typeof attached.id, "number");
        assert.equal(typeof attached.name, "string");
    } finally { await conn.close(); }
});

test("session.attach with bogus id throws", async (t) => {
    if (guard(t)) return;
    const conn = new Rpc({ url: daemon!.url });
    await conn.connect();
    try {
        await assert.rejects(conn.call("session.attach", { id: 99999 }), /not found|does not exist/i);
    } finally { await conn.close(); }
});

test("session.runs({id}) returns runs array with RunRow shape", async (t) => {
    if (guard(t)) return;
    const { sessions } = await rpc!.call("session.list") as { sessions: Array<{ id: number }> };
    const { runs } = await rpc!.call("session.runs", { id: sessions[0].id }) as { runs: Array<{ id: number; name: string; created_at: string; cost_pico: number }> };
    assert.ok(Array.isArray(runs));
    if (runs.length > 0) {
        const r = runs[0];
        assert.equal(typeof r.id, "number");
        assert.equal(typeof r.name, "string");
        assert.equal(typeof r.created_at, "string");
        assert.equal(typeof r.cost_pico, "number");
    }
});

// ─── providers.list ───────────────────────────────────────────────────

test("providers.list returns aliases array with ProviderAlias shape", async (t) => {
    if (guard(t)) return;
    const { aliases } = await rpc!.call("providers.list") as { aliases: Array<{ alias: string; provider: string; model: string; active: boolean }> };
    assert.ok(Array.isArray(aliases));
    // Daemon's .env defines at least gemma; verify shape if any present.
    if (aliases.length > 0) {
        const a = aliases[0];
        assert.equal(typeof a.alias, "string");
        assert.equal(typeof a.provider, "string");
        assert.equal(typeof a.model, "string");
        assert.equal(typeof a.active, "boolean");
    }
});

// ─── loop.run / loop.resolve error paths ─────────────────────────────

test("loop.run with unknown alias surfaces clear daemon error", async (t) => {
    if (guard(t)) return;
    // Need a connection with an attached session + run for loop.run.
    const conn = new Rpc({ url: daemon!.url });
    await conn.connect();
    try {
        await conn.call("session.create", { projectRoot: daemon!.workspace });
        await assert.rejects(
            conn.call("loop.run", { prompt: "hi", alias: "totally-not-a-real-alias" }),
            /unknown alias/i,
        );
    } finally { await conn.close(); }
});

test("loop.resolve with no pending proposal returns 404 result", async (t) => {
    if (guard(t)) return;
    const conn = new Rpc({ url: daemon!.url });
    await conn.connect();
    try {
        await conn.call("session.create", { projectRoot: daemon!.workspace });
        const r = await conn.call("loop.resolve", { logEntryId: 99999, decision: "accept" }) as { status: number; error?: string };
        assert.equal(r.status, 404);
        assert.ok(typeof r.error === "string");
    } finally { await conn.close(); }
});

// ─── log.read ─────────────────────────────────────────────────────────

test("log.read returns {status, entries} shape on attached session", async (t) => {
    if (guard(t)) return;
    const conn = new Rpc({ url: daemon!.url });
    await conn.connect();
    try {
        await conn.call("session.create", { projectRoot: daemon!.workspace });
        const r = await conn.call("log.read", {}) as { status: number; entries: unknown[] };
        assert.equal(r.status, 200);
        assert.ok(Array.isArray(r.entries));
    } finally { await conn.close(); }
});

test("log.read respects --limit filter", async (t) => {
    if (guard(t)) return;
    const conn = new Rpc({ url: daemon!.url });
    await conn.connect();
    try {
        await conn.call("session.create", { projectRoot: daemon!.workspace });
        const r = await conn.call("log.read", { limit: 0 }) as { status: number; entries: unknown[] };
        assert.equal(r.entries.length, 0);
    } finally { await conn.close(); }
});

// ─── log/entry top-level URL fields (the v0.2.0 rename regression test) ──

test("log/entry payload uses unprefixed scheme/pathname/hostname/fragment", async (t) => {
    if (guard(t)) return;
    // Use a fresh connection: create session, dispatch a known:// EDIT via
    // op.parse (client-origin, no model needed), wait for the notification,
    // assert the field names that the client renders against.
    const conn = new Rpc({ url: daemon!.url });
    await conn.connect();
    try {
        await conn.call("session.create", { projectRoot: daemon!.workspace });
        const got: unknown[] = [];
        conn.onNotification("log/entry", (params) => { got.push(params); });
        await conn.call("op.parse", { text: "<<EDIT(known://intg-test/foo):hello world:EDIT" });
        // Give the notification a tick to land.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        assert.ok(got.length > 0, "expected at least one log/entry notification");
        const params = got[0] as { entry: Record<string, unknown> };
        const entry = params.entry;
        // The client reads these by their unprefixed names — fail loud if
        // the daemon ever sends target_scheme/target_pathname again.
        assert.ok("scheme" in entry, "entry must have 'scheme' (unprefixed)");
        assert.ok("pathname" in entry, "entry must have 'pathname' (unprefixed)");
        assert.ok("hostname" in entry, "entry must have 'hostname' (unprefixed)");
        assert.ok("fragment" in entry, "entry must have 'fragment' (unprefixed)");
        assert.ok(!("target_scheme" in entry), "wire shape regression: target_scheme returned");
        assert.ok(!("target_pathname" in entry), "wire shape regression: target_pathname returned");
    } finally { await conn.close(); }
});
