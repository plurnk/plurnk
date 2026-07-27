// Unit tests for src/subcommands.ts using a fake Rpc that captures calls and
// returns canned responses. Stdout is monkey-patched per test so assertions
// can inspect what each subcommand wrote as its "product."

import { test } from "node:test";
import assert from "node:assert/strict";

import { runModels, runWorkspaceList, runWorkspaceWorkers, runWorkspaceRename, runLogRead, runRead, parseCoord } from "./subcommands.ts";
import type { Caller } from "./subcommands.ts";

interface RecordedCall { method: string; params: unknown }

const fakeRpc = (responses: Record<string, unknown>): { rpc: Caller; calls: RecordedCall[] } => {
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
    } as Caller;
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

// ─── runWorkspaceRename ─────────────────────────────────────────────────

test("runWorkspaceRename: resolves by name, attaches, renames the attached workspace", async () => {
    const { rpc, calls } = fakeRpc({
        "workspace.list": { workspaces: [{ id: 7, name: "old", project_root: "/p" }] },
        "workspace.attach": { id: 7, name: "old", workerId: 8, workerName: "r" },
        "workspace.rename": { id: 7, name: "new" },
    });
    const code = await captureStdout(async () => assert.equal(await runWorkspaceRename(rpc, "old", "new", { json: false }), 0));
    const seq = calls.map((c) => c.method);
    assert.deepEqual(seq, ["workspace.list", "workspace.attach", "workspace.rename"]);
    assert.deepEqual(calls.find((c) => c.method === "workspace.rename")?.params, { name: "new" });
    assert.match(code, /renamed "old" → "new"/);
});

test("runWorkspaceRename: unknown workspace → exit 1, no rename attempted", async () => {
    const { rpc, calls } = fakeRpc({ "workspace.list": { workspaces: [] } });
    assert.equal(await runWorkspaceRename(rpc, "ghost", "x", { json: false }), 1);
    assert.equal(calls.some((c) => c.method === "workspace.rename"), false);
});

// ─── runModels ────────────────────────────────────────────────────────

test("[§cli-plurnk-models] runModels: table format with aliases", async () => {
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

// ─── runWorkspaceList ───────────────────────────────────────────────────

test("[§cli-plurnk-workspace-list] runWorkspaceList: table format with workspaces", async () => {
    const { rpc, calls } = fakeRpc({
        "workspace.list": {
            workspaces: [
                { id: 1, name: "alpha", project_root: "/tmp/work", created_at: "2026-05-26T12:00:00Z", cost_usd: 0 },
                { id: 2, name: "beta", project_root: null, created_at: "2026-05-26T13:00:00Z", cost_usd: 0.0125 },
            ],
        },
    });
    const out = await captureStdout(() => runWorkspaceList(rpc, { json: false }));
    assert.equal(calls[0].method, "workspace.list");
    assert.match(out, /alpha/);
    assert.match(out, /\/tmp\/work/);
    assert.match(out, /beta/);
    assert.match(out, /\(headless\)/); // null project_root rendered as "(headless)"
});

test("runWorkspaceList: --json passes workspaces through", async () => {
    const workspaces = [{ id: 1, name: "x", project_root: null, created_at: "now", cost_usd: 0 }];
    const { rpc } = fakeRpc({ "workspace.list": { workspaces } });
    const out = await captureStdout(() => runWorkspaceList(rpc, { json: true }));
    assert.deepEqual(JSON.parse(out.trim()), workspaces);
});

test("runWorkspaceList: empty list → friendly message in table mode", async () => {
    const { rpc } = fakeRpc({ "workspace.list": { workspaces: [] } });
    const out = await captureStdout(() => runWorkspaceList(rpc, { json: false }));
    assert.match(out, /no workspaces/);
});

// ─── runWorkspaceWorkers ───────────────────────────────────────────────────

test("[§cli-plurnk-workspace-workers-name] runWorkspaceWorkers: looks up workspace by name then calls workspace.workers with id", async () => {
    const { rpc, calls } = fakeRpc({
        "workspace.list": {
            workspaces: [
                { id: 1, name: "alpha", project_root: null, created_at: "t", cost_usd: 0 },
                { id: 2, name: "beta", project_root: null, created_at: "t", cost_usd: 0 },
            ],
        },
        "workspace.workers": {
            workers: [
                { id: 10, name: "run-1", created_at: "t1", cost_usd: 0 },
                { id: 11, name: "run-2", created_at: "t2", cost_usd: 0.5 },
            ],
        },
    });
    const out = await captureStdout(() => runWorkspaceWorkers(rpc, "beta", { json: false }));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "workspace.list");
    assert.equal(calls[1].method, "workspace.workers");
    assert.deepEqual(calls[1].params, { id: 2 });
    assert.match(out, /run-1/);
    assert.match(out, /run-2/);
});

test("runWorkspaceWorkers: --json emits workers array", async () => {
    const workers = [{ id: 10, name: "r", created_at: "t", cost_usd: 0 }];
    const { rpc } = fakeRpc({
        "workspace.list": { workspaces: [{ id: 1, name: "x", project_root: null, created_at: "t", cost_usd: 0 }] },
        "workspace.workers": { workers },
    });
    const out = await captureStdout(() => runWorkspaceWorkers(rpc, "x", { json: true }));
    assert.deepEqual(JSON.parse(out.trim()), workers);
});

test("runWorkspaceWorkers: unknown workspace name → exit 1, error on stderr", async () => {
    const { rpc } = fakeRpc({ "workspace.list": { workspaces: [] } });
    const errs: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: string | Uint8Array): boolean => {
        errs.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8"));
        return true;
    }) as typeof process.stderr.write;
    try {
        const code = await runWorkspaceWorkers(rpc, "nonexistent", { json: false });
        assert.equal(code, 1);
    } finally { process.stderr.write = original; }
    assert.match(errs.join(""), /no workspace named "nonexistent"/);
});

test("runWorkspaceWorkers: ambiguous name → exit 1", async () => {
    const { rpc } = fakeRpc({
        "workspace.list": {
            workspaces: [
                { id: 1, name: "dup", project_root: null, created_at: "t", cost_usd: 0 },
                { id: 2, name: "dup", project_root: null, created_at: "t", cost_usd: 0 },
            ],
        },
    });
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
        const code = await runWorkspaceWorkers(rpc, "dup", { json: false });
        assert.equal(code, 1);
    } finally { process.stderr.write = original; }
});

test("runWorkspaceWorkers: workspace has no workers → friendly message in table mode", async () => {
    const { rpc } = fakeRpc({
        "workspace.list": { workspaces: [{ id: 1, name: "x", project_root: null, created_at: "t", cost_usd: 0 }] },
        "workspace.workers": { workers: [] },
    });
    const out = await captureStdout(() => runWorkspaceWorkers(rpc, "x", { json: false }));
    assert.match(out, /no workers/);
});

// ─── runLogRead ───────────────────────────────────────────────────────

const entry = (id: number, op = "READ"): unknown => ({
    id, op, suffix: "", origin: "model", signal: null,
    scheme: "worker", pathname: `/x${id}`, hostname: null, fragment: null,
    status_rx: 200, tx: null, rx: null,
});

test("runLogRead: passes no filters when none set, renders trace lines", async () => {
    const { rpc, calls } = fakeRpc({
        "log.read": { status: 200, entries: [entry(1), entry(2)] },
    });
    const out = await captureStdout(() => runLogRead(rpc, { json: false, filters: {} }));
    assert.equal(calls[0].method, "log.read");
    assert.deepEqual(calls[0].params, {});
    assert.match(out, /worker:\/\/\/x1/);
    assert.match(out, /worker:\/\/\/x2/);
});

test("[§cli-plurnk-log-read] runLogRead: forwards filter flags as RPC params", async () => {
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

// ─── plurnk read <L/T/S> (clean log.read coordinate contract, svc#271) ────

test("parseCoord: accepts bare and zero-padded; rejects malformed", () => {
    assert.deepEqual(parseCoord("3/1/2"), [3, 1, 2]);
    assert.deepEqual(parseCoord("03/01/02"), [3, 1, 2]);
    assert.equal(parseCoord("3/1"), null);          // too few
    assert.equal(parseCoord("3/1/2/0"), null);      // too many
    assert.equal(parseCoord("a/1/2"), null);        // non-numeric
    assert.equal(parseCoord("3/-1/2"), null);       // negative
});

// log.read({loopSeq,turnSeq,sequence}) resolves the single FULL entry (tx+rx).
const fullEntry = (op: string, over: Record<string, unknown>): unknown => ({
    id: 1, op, origin: "model", scheme: null, pathname: null, status_rx: 200,
    loop_seq: 3, turn_seq: 1, sequence: 2, tx: null, rx: null, ...over,
});

test("runRead: hands the display coordinate to log.read — the daemon resolves it", async () => {
    const { rpc, calls } = fakeRpc({ "log.read": { status: 200, entries: [fullEntry("READ", { rx: { status: 200, content: "the read result" } })] } });
    const out = await captureStdout(() => runRead(rpc, "3/1/2", { json: true }));
    assert.deepEqual(calls[0], { method: "log.read", params: { loopSeq: 3, turnSeq: 1, sequence: 2 } });
    const doc = JSON.parse(out.trim());
    assert.equal(doc.coord, "3/1/2");
    assert.equal(doc.entry.op, "READ");
    assert.ok(typeof doc.schemaVersion === "number");
});

test("runRead: a SEND's tx body IS reachable by coordinate (the svc#271 fix); zero-pad normalizes", async () => {
    const { rpc, calls } = fakeRpc({ "log.read": { status: 200, entries: [fullEntry("SEND", { signal: 200, tx: { body: { raw: "Paris", json: null } } })] } });
    const out = await captureStdout(() => runRead(rpc, "03/01/02", { json: false }));
    assert.deepEqual(calls[0].params, { loopSeq: 3, turnSeq: 1, sequence: 2 });
    assert.match(out, /Paris/);   // the tx body — NOT a "{status:200}" receipt (the op.read regression)
});

test("runRead: no entry at the coordinate → exit 4 with a model-run hint", async () => {
    const { rpc } = fakeRpc({ "log.read": { status: 200, entries: [] } });
    const code = await runRead(rpc, "3/1/2", { json: false });
    assert.equal(code, 4);
});

test("runRead: malformed coordinate → exit 64, never hits the wire", async () => {
    const { rpc, calls } = fakeRpc({});
    const code = await runRead(rpc, "nope", { json: false });
    assert.equal(code, 64);
    assert.equal(calls.length, 0);
});
