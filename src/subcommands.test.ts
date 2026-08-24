// Unit tests for src/subcommands.ts using a fake Rpc that captures calls and
// returns canned responses. Stdout is monkey-patched per test so assertions
// can inspect what each subcommand wrote as its "product."

import { test } from "node:test";
import assert from "node:assert/strict";

import { runModels, runWorkspaceList, runWorkspaceWorkers, runWorkspaceRename, runLogRead, runRead, parseCoord } from "./subcommands.ts";
import type { Caller } from "./subcommands.ts";
import { ProblemError } from "./diagnostics.ts";

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

test("runWorkspaceRename: unknown workspace throws the exact public Problem", async () => {
    const { rpc, calls } = fakeRpc({ "workspace.list": { workspaces: [] } });
    await assert.rejects(
        runWorkspaceRename(rpc, "ghost", "x", { json: false }),
        (error: unknown) => {
            assert.ok(error instanceof ProblemError);
            assert.equal(error.exitCode, 1);
            assert.equal(error.problem.type, "https://problems.plurnk.xyz/client/subcommand/workspace-not-found");
            assert.equal(error.problem.name, "ghost");
            return true;
        },
    );
    assert.equal(calls.some((c) => c.method === "workspace.rename"), false);
});

// ─── runModels ────────────────────────────────────────────────────────

const modelPage = {
    items: [
        {
            selector: "google/gemini-3-flash",
            provider: "google",
            providerName: "Google",
            model: "gemini-3-flash",
            modelName: "Gemini 3 Flash",
            limits: { contextTokens: 1_000_000, outputTokens: 65_536 },
            capabilities: {
                attachment: true,
                reasoning: true,
                toolCall: true,
                inputModalities: ["text", "image"],
                outputModalities: ["text"],
            },
            readiness: { ready: true, causes: [] },
        },
        {
            selector: "google/gemini-3-pro",
            provider: "google",
            providerName: "Google",
            model: "gemini-3-pro",
            modelName: "Gemini 3 Pro",
            limits: { contextTokens: 1_000_000 },
            capabilities: {
                attachment: true,
                reasoning: true,
                toolCall: true,
                inputModalities: ["text"],
                outputModalities: ["text"],
            },
            readiness: {
                ready: false,
                causes: [{ kind: "credential" as const, alternatives: [["GOOGLE_GENERATIVE_AI_API_KEY"]] }],
            },
        },
    ],
    offset: 0,
    total: 3,
    nextOffset: 2,
};

test("[§cli-plurnk-models] runModels: bounded catalog table and continuation hint", async () => {
    const { rpc, calls } = fakeRpc({
        "models.list": modelPage,
    });
    const query = { provider: "google", search: "gemini", availability: "all" as const, limit: 2 };
    const out = await captureStdout(() => runModels(rpc, { json: false, query }));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { method: "models.list", params: query });
    assert.match(out, /selector/);
    assert.match(out, /google\/gemini-3-flash/);
    assert.match(out, /Gemini 3 Pro/);
    assert.match(out, /GOOGLE_GENERATIVE_AI_API_KEY/);
    assert.match(out, /next --offset 2/);
});

test("runModels: --json emits the complete page without client projection", async () => {
    const { rpc } = fakeRpc({
        "models.list": modelPage,
    });
    const out = await captureStdout(() => runModels(rpc, { json: true }));
    assert.deepEqual(JSON.parse(out.trim()), modelPage);
});

test("runModels: empty list → friendly message in table mode", async () => {
    const { rpc } = fakeRpc({ "models.list": { items: [], offset: 0, total: 0 } });
    const out = await captureStdout(() => runModels(rpc, { json: false }));
    assert.match(out, /use --all/);
});

test("runModels: empty page remains a page in json mode", async () => {
    const page = { items: [], offset: 0, total: 0 };
    const { rpc } = fakeRpc({ "models.list": page });
    const out = await captureStdout(() => runModels(rpc, { json: true }));
    assert.deepEqual(JSON.parse(out.trim()), page);
});

// ─── runWorkspaceList ───────────────────────────────────────────────────

test("runModels: rejects a malformed daemon catalog page at the shared contract boundary", async () => {
    const { rpc } = fakeRpc({
        "models.list": { items: [{ selector: "google/broken" }], offset: 0, total: 1 },
    });
    await assert.rejects(
        runModels(rpc, { json: false }),
        /invalid ModelCatalogPage/,
    );
});

test("[§cli-plurnk-workspace-list] runWorkspaceList: table format with workspaces", async () => {
    const { rpc, calls } = fakeRpc({
        "workspace.list": {
            workspaces: [
                { id: 1, name: "alpha", project_root: "/tmp/work", created_at: "2026-05-26T12:00:00Z" },
                { id: 2, name: "beta", project_root: null, created_at: "2026-05-26T13:00:00Z" },
            ],
        },
    });
    const out = await captureStdout(() => runWorkspaceList(rpc, { json: false }));
    assert.equal(calls[0].method, "workspace.list");
    assert.match(out, /alpha/);
    assert.match(out, /\/tmp\/work/);
    assert.match(out, /beta/);
    assert.match(out, /\(headless\)/); // null project_root rendered as "(headless)"
    assert.doesNotMatch(out, /cost/, "workspace directory does not invent an accounting rollup");
});

test("runWorkspaceList: --json passes workspaces through", async () => {
    const workspaces = [{ id: 1, name: "x", project_root: null, created_at: "now" }];
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
                { id: 1, name: "alpha", project_root: null, created_at: "t" },
                { id: 2, name: "beta", project_root: null, created_at: "t" },
            ],
        },
        "workspace.workers": {
            workers: [
                { id: 10, name: "run-1", created_at: "t1" },
                { id: 11, name: "run-2", created_at: "t2" },
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
    assert.doesNotMatch(out, /cost/, "worker directory does not invent an accounting rollup");
});

test("runWorkspaceWorkers: --json emits workers array", async () => {
    const workers = [{ id: 10, name: "r", created_at: "t" }];
    const { rpc } = fakeRpc({
        "workspace.list": { workspaces: [{ id: 1, name: "x", project_root: null, created_at: "t" }] },
        "workspace.workers": { workers },
    });
    const out = await captureStdout(() => runWorkspaceWorkers(rpc, "x", { json: true }));
    assert.deepEqual(JSON.parse(out.trim()), workers);
});

test("runWorkspaceWorkers: unknown workspace name throws the exact public Problem", async () => {
    const { rpc } = fakeRpc({ "workspace.list": { workspaces: [] } });
    await assert.rejects(
        runWorkspaceWorkers(rpc, "nonexistent", { json: false }),
        (error: unknown) => {
            assert.ok(error instanceof ProblemError);
            assert.equal(error.exitCode, 1);
            assert.equal(error.problem.type, "https://problems.plurnk.xyz/client/subcommand/workspace-not-found");
            assert.equal(error.problem.name, "nonexistent");
            return true;
        },
    );
});

test("runWorkspaceWorkers: ambiguous name throws the exact public Problem", async () => {
    const { rpc } = fakeRpc({
        "workspace.list": {
            workspaces: [
                { id: 1, name: "dup", project_root: null, created_at: "t" },
                { id: 2, name: "dup", project_root: null, created_at: "t" },
            ],
        },
    });
    await assert.rejects(
        runWorkspaceWorkers(rpc, "dup", { json: false }),
        (error: unknown) => {
            assert.ok(error instanceof ProblemError);
            assert.equal(error.exitCode, 1);
            assert.equal(error.problem.type, "https://problems.plurnk.xyz/client/subcommand/workspace-ambiguous");
            assert.equal(error.problem.count, 2);
            return true;
        },
    );
});

test("runWorkspaceWorkers: workspace has no workers → friendly message in table mode", async () => {
    const { rpc } = fakeRpc({
        "workspace.list": { workspaces: [{ id: 1, name: "x", project_root: null, created_at: "t" }] },
        "workspace.workers": { workers: [] },
    });
    const out = await captureStdout(() => runWorkspaceWorkers(rpc, "x", { json: false }));
    assert.match(out, /no workers/);
});

// ─── runLogRead ───────────────────────────────────────────────────────

const entry = (id: number, op = "READ"): unknown => ({
    id, op, suffix: "", origin: "model", signal: null,
    scheme: "worker", pathname: `/x${id}`, hostname: null, fragment: null,
    lineMarker: null, status_rx: 200, tx: null, rx: null,
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
        filters: { workerId: 7, loopId: 5, turnId: 2, sinceId: 100, limit: 50 },
    }));
    assert.deepEqual(calls[0].params, { workerId: 7, loopId: 5, turnId: 2, sinceId: 100, limit: 50 });
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

test("runRead: no entry at the coordinate throws an exact 404 Problem", async () => {
    const { rpc } = fakeRpc({ "log.read": { status: 200, entries: [] } });
    await assert.rejects(
        runRead(rpc, "3/1/2", { json: false }),
        (error: unknown) => {
            assert.ok(error instanceof ProblemError);
            assert.equal(error.exitCode, 4);
            assert.equal(error.problem.type, "https://problems.plurnk.xyz/client/subcommand/entry-not-found");
            assert.equal(error.problem.coordinate, "3/1/2");
            return true;
        },
    );
});

test("runRead: malformed coordinate throws an exact 400 Problem and never hits the wire", async () => {
    const { rpc, calls } = fakeRpc({});
    await assert.rejects(
        runRead(rpc, "nope", { json: false }),
        (error: unknown) => {
            assert.ok(error instanceof ProblemError);
            assert.equal(error.exitCode, 64);
            assert.equal(error.problem.type, "https://problems.plurnk.xyz/client/subcommand/coordinate-invalid");
            assert.equal(error.problem.coordinate, "nope");
            return true;
        },
    );
    assert.equal(calls.length, 0);
});
