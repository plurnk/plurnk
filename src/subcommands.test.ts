// Unit tests for src/subcommands.ts using a fake Rpc that captures calls and
// returns canned responses. Stdout is monkey-patched per test so assertions
// can inspect what each subcommand wrote as its "product."

import { test } from "node:test";
import assert from "node:assert/strict";

import { runModels, runSessionList, runLogRead } from "./subcommands.ts";
import type Rpc from "./rpc.ts";

interface RecordedCall { method: string; params: unknown }

const fakeRpc = (responses: Record<string, unknown>): { rpc: Rpc; calls: RecordedCall[] } => {
    const calls: RecordedCall[] = [];
    const rpc = {
        call: async (method: string, params?: object): Promise<unknown> => {
            calls.push({ method, params });
            if (method in responses) return responses[method];
            throw new Error(`fakeRpc: unmocked method '${method}'`);
        },
        connect: async (): Promise<void> => {},
        close: async (): Promise<void> => {},
        onNotification: (): void => {},
    } as unknown as Rpc;
    return { rpc, calls };
};

// Capture process.stdout.write for the duration of `fn`; return what was written.
const captureStdout = async (fn: () => Promise<unknown>): Promise<string> => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
        return true;
    }) as typeof process.stdout.write;
    try { await fn(); }
    finally { process.stdout.write = original; }
    return chunks.join("");
};

// ─── runModels ────────────────────────────────────────────────────────

test("runModels: table format with aliases", async () => {
    const { rpc, calls } = fakeRpc({
        "providers.list": {
            aliases: [
                { alias: "gemma", provider: "openai", model: "macher.gguf", active: true },
                { alias: "opus", provider: "openrouter", model: "claude-opus", active: false },
            ],
        },
    });
    const out = await captureStdout(() => runModels(rpc, { json: false }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "providers.list");
    assert.match(out, /alias/);
    assert.match(out, /provider/);
    assert.match(out, /gemma/);
    assert.match(out, /opus/);
    assert.match(out, /macher\.gguf/);
    // Active marker '*' on gemma
    assert.match(out, /gemma.*\*/);
});

test("runModels: --json emits compact JSON array", async () => {
    const { rpc } = fakeRpc({
        "providers.list": { aliases: [{ alias: "g", provider: "p", model: "m", active: true }] },
    });
    const out = await captureStdout(() => runModels(rpc, { json: true }));
    const parsed = JSON.parse(out.trim()) as unknown[];
    assert.deepEqual(parsed, [{ alias: "g", provider: "p", model: "m", active: true }]);
});

test("runModels: empty list → friendly message in table mode", async () => {
    const { rpc } = fakeRpc({ "providers.list": { aliases: [] } });
    const out = await captureStdout(() => runModels(rpc, { json: false }));
    assert.match(out, /no model aliases configured/);
});

test("runModels: empty list → '[]' in json mode", async () => {
    const { rpc } = fakeRpc({ "providers.list": { aliases: [] } });
    const out = await captureStdout(() => runModels(rpc, { json: true }));
    assert.equal(out.trim(), "[]");
});

// ─── runSessionList ───────────────────────────────────────────────────

test("runSessionList: table format with sessions", async () => {
    const { rpc, calls } = fakeRpc({
        "session.list": {
            sessions: [
                { id: 1, name: "alpha", project_root: "/tmp/work", created_at: "2026-05-26T12:00:00Z", cost_pico: 0 },
                { id: 2, name: "beta", project_root: null, created_at: "2026-05-26T13:00:00Z", cost_pico: 12_500_000_000 },
            ],
        },
    });
    const out = await captureStdout(() => runSessionList(rpc, { json: false }));
    assert.equal(calls[0].method, "session.list");
    assert.match(out, /alpha/);
    assert.match(out, /\/tmp\/work/);
    assert.match(out, /beta/);
    assert.match(out, /\(headless\)/); // null project_root rendered as "(headless)"
});

test("runSessionList: --json passes sessions through", async () => {
    const sessions = [{ id: 1, name: "x", project_root: null, created_at: "now", cost_pico: 0 }];
    const { rpc } = fakeRpc({ "session.list": { sessions } });
    const out = await captureStdout(() => runSessionList(rpc, { json: true }));
    assert.deepEqual(JSON.parse(out.trim()), sessions);
});

test("runSessionList: empty list → friendly message in table mode", async () => {
    const { rpc } = fakeRpc({ "session.list": { sessions: [] } });
    const out = await captureStdout(() => runSessionList(rpc, { json: false }));
    assert.match(out, /no sessions/);
});

// ─── runLogRead ───────────────────────────────────────────────────────

const entry = (id: number, op = "READ"): unknown => ({
    id, op, suffix: "", origin: "model", signal: null,
    scheme: "known", pathname: `/x${id}`, hostname: null, fragment: null,
    status_rx: 200, tx: null, rx: null,
});

test("runLogRead: passes no filters when none set, renders trace lines", async () => {
    const { rpc, calls } = fakeRpc({
        "log.read": { status: 200, entries: [entry(1), entry(2)] },
    });
    const out = await captureStdout(() => runLogRead(rpc, { json: false, filters: {} }));
    assert.equal(calls[0].method, "log.read");
    assert.deepEqual(calls[0].params, {});
    assert.match(out, /known:\/\/\/x1/);
    assert.match(out, /known:\/\/\/x2/);
});

test("runLogRead: forwards filter flags as RPC params", async () => {
    const { rpc, calls } = fakeRpc({ "log.read": { status: 200, entries: [] } });
    await captureStdout(() => runLogRead(rpc, {
        json: false,
        filters: { loopId: 5, turnId: 2, sinceId: 100, limit: 50 },
    }));
    assert.deepEqual(calls[0].params, { loopId: 5, turnId: 2, sinceId: 100, limit: 50 });
});

test("runLogRead: --json emits raw entries array", async () => {
    const entries = [entry(1)];
    const { rpc } = fakeRpc({ "log.read": { status: 200, entries } });
    const out = await captureStdout(() => runLogRead(rpc, { json: true, filters: {} }));
    assert.deepEqual(JSON.parse(out.trim()), entries);
});

test("runLogRead: empty → friendly message in table mode", async () => {
    const { rpc } = fakeRpc({ "log.read": { status: 200, entries: [] } });
    const out = await captureStdout(() => runLogRead(rpc, { json: false, filters: {} }));
    assert.match(out, /no entries match/);
});

test("runLogRead: only sends defined filters (no undefined keys)", async () => {
    const { rpc, calls } = fakeRpc({ "log.read": { status: 200, entries: [] } });
    await captureStdout(() => runLogRead(rpc, { json: false, filters: { limit: 10 } }));
    assert.deepEqual(calls[0].params, { limit: 10 });
});
