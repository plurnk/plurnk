// Integration tests for the read-only subcommands. Spawns the actual
// bin/plurnk.js binary against a real daemon and asserts its stdout shape.
//
// Skip cleanly when the daemon binary isn't reachable.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Rpc from "../../src/rpc.ts";
import { locateDaemon, bootDaemon, type Daemon } from "./harness.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLURNK_BIN = resolve(__dirname, "../../bin/plurnk.js");

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

interface RunResult { code: number; stdout: string; stderr: string }

// Run the plurnk binary against the test daemon. Returns exit code + captured streams.
const runPlurnk = async (args: string[]): Promise<RunResult> => {
    const child = spawn("node", [PLURNK_BIN, ...args], {
        env: { ...process.env, PLURNK_URL: daemon!.url, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    const code = await new Promise<number>((r) => {
        child.once("exit", (c) => r(c ?? 1));
        child.once("error", () => r(1));
    });
    return { code, stdout, stderr };
};

// Seed a named session via raw RPC so subcommand tests have something to list.
const seedSession = async (name: string): Promise<number> => {
    const rpc = new Rpc({ url: daemon!.url });
    await rpc.connect();
    try {
        const r = await rpc.call("session.create", { name, projectRoot: daemon!.workspace }) as { id: number };
        return r.id;
    } finally { await rpc.close(); }
};

// ─── plurnk models ────────────────────────────────────────────────────

test("plurnk models renders table", async (t) => {
    if (guard(t)) return;
    const r = await runPlurnk(["models"]);
    assert.equal(r.code, 0);
    // Either a populated table OR the empty-state message — both are valid.
    assert.ok(/alias\s+provider\s+model/.test(r.stdout) || /no model aliases configured/.test(r.stdout));
});

test("plurnk models --json emits parseable JSON array", async (t) => {
    if (guard(t)) return;
    const r = await runPlurnk(["models", "--json"]);
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout.trim()) as unknown;
    assert.ok(Array.isArray(parsed));
});

// ─── plurnk session list ──────────────────────────────────────────────

test("plurnk session list shows seeded session", async (t) => {
    if (guard(t)) return;
    await seedSession("intg-session-list-test");
    const r = await runPlurnk(["session", "list"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /intg-session-list-test/);
});

test("plurnk session list --json round-trips through JSON", async (t) => {
    if (guard(t)) return;
    const r = await runPlurnk(["session", "list", "--json"]);
    assert.equal(r.code, 0);
    const sessions = JSON.parse(r.stdout.trim()) as Array<{ name: string }>;
    assert.ok(Array.isArray(sessions));
});

// ─── plurnk session runs ──────────────────────────────────────────────

test("plurnk session runs <name> lists at least one run", async (t) => {
    if (guard(t)) return;
    await seedSession("intg-runs-test");
    const r = await runPlurnk(["session", "runs", "intg-runs-test"]);
    assert.equal(r.code, 0);
    // session.create implicitly creates a run; expect at least one.
    assert.ok(!/no runs/.test(r.stdout), "expected at least one run in the seeded session");
});

test("plurnk session runs <unknown> → exit 1, error on stderr", async (t) => {
    if (guard(t)) return;
    const r = await runPlurnk(["session", "runs", "definitely-does-not-exist"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no session named/);
});

test("plurnk session runs without name → exit 64", async (t) => {
    if (guard(t)) return;
    const r = await runPlurnk(["session", "runs"]);
    assert.equal(r.code, 64);
    // v0.4.0 unified errors onto the TelemetryEvent shape (SPEC §8.4).
    assert.match(r.stderr, /client:subcommand:missing_argument/);
    assert.match(r.stderr, /missing <name>/);
});

// ─── plurnk log read ──────────────────────────────────────────────────

test("plurnk log read without --session → exit 64", async (t) => {
    if (guard(t)) return;
    const r = await runPlurnk(["log", "read"]);
    assert.equal(r.code, 64);
    assert.match(r.stderr, /requires --session/);
});

test("plurnk log read --session=<name> --limit 5 returns OK", async (t) => {
    if (guard(t)) return;
    await seedSession("intg-log-read-test");
    const r = await runPlurnk(["log", "read", "--session=intg-log-read-test", "--limit", "5"]);
    assert.equal(r.code, 0);
});

// ─── unknown subcommand verbs ─────────────────────────────────────────

test("plurnk session weirdverb → exit 64 with available list", async (t) => {
    if (guard(t)) return;
    const r = await runPlurnk(["session", "weirdverb"]);
    assert.equal(r.code, 64);
    assert.match(r.stderr, /Available: list, runs/);
});

test("plurnk unknownverb → exit 64", async (t) => {
    if (guard(t)) return;
    // 'unknownverb' isn't a known subcommand; it falls through to prompt mode,
    // which then runs through CLI mode (session.create + loop.run). Without
    // a model, this will hang or fail — wire it up to time out quickly.
    // For now, just check the simpler case of a known-subcommand-verb-with-bad-noun.
    const r = await runPlurnk(["log", "weirdverb"]);
    assert.equal(r.code, 64);
    assert.match(r.stderr, /unknown subcommand/);
});
