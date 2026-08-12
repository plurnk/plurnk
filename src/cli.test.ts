// Unit tests for src/cli.ts pure helpers.

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatPlain, isTerminalBroadcast, buildJsonRecord, buildScriptJsonRecord, buildJsonError, JSON_SCHEMA_VERSION } from "./cli.ts";
import { clientFlagInvalid } from "./diagnostics.ts";
import type { LogEntryWire, LoopUsage } from "./render.ts";

const entry = (overrides: Partial<LogEntryWire> = {}): LogEntryWire => ({
    id: 1,
    op: "READ",
    suffix: "",
    origin: "model",
    worker_id: 39,
    signal: null,
    loop_seq: 1,
    turn_seq: 1,
    sequence: 1,
    scheme: null,
    pathname: null,
    hostname: null,
    fragment: null,
    status_rx: 200,
    tx: null,
    rx: null,
    tags: [],
    ...overrides,
});

// ─── formatPlain ──────────────────────────────────────────────────────

test("formatPlain: directed op with scheme → 'scheme://...'", () => {
    const s = formatPlain(entry({ op: "EDIT", scheme: "worker", pathname: "/x/y", status_rx: 201 }));
    assert.equal(s, "[201] model EDIT worker:///x/y");
});

test("formatPlain: file:// (scheme=null, pathname set) → bare pathname", () => {
    const s = formatPlain(entry({ op: "EDIT", scheme: null, pathname: "/tmp/foo.txt", status_rx: 202 }));
    assert.equal(s, "[202] model EDIT /tmp/foo.txt");
});

test("formatPlain: no target at all → no trailing path", () => {
    const s = formatPlain(entry({ op: "SHOW", scheme: null, pathname: null, status_rx: 200 }));
    assert.equal(s, "[200] model SHOW");
});

test("formatPlain: SEND with numeric signal → '[N]' sub", () => {
    const s = formatPlain(entry({ op: "SEND", signal: 200, scheme: null, pathname: null, status_rx: 200 }));
    assert.equal(s, "[200] model SEND [200]");
});

test("formatPlain: SEND without numeric signal → no sub", () => {
    const s = formatPlain(entry({ op: "SEND", signal: null, scheme: "slack", pathname: "/x", status_rx: 200 }));
    assert.equal(s, "[200] model SEND slack:///x");
});

test("formatPlain: hostname + pathname assemble correctly", () => {
    const s = formatPlain(entry({ op: "READ", scheme: "https", hostname: "example.com", pathname: "/p", status_rx: 200 }));
    assert.equal(s, "[200] model READ https://example.com/p");
});

test("formatPlain: fragment appended when present", () => {
    const s = formatPlain(entry({ op: "READ", scheme: "worker", pathname: "/d", fragment: "sect", status_rx: 200 }));
    assert.equal(s, "[200] model READ worker:///d#sect");
});

// ─── isTerminalBroadcast ──────────────────────────────────────────────

test("isTerminalBroadcast: SEND, no path, signal 200 → true", () => {
    assert.equal(isTerminalBroadcast(entry({ op: "SEND", scheme: null, pathname: null, signal: 200 })), true);
});

test("isTerminalBroadcast: SEND, no path, signal 499 → true", () => {
    assert.equal(isTerminalBroadcast(entry({ op: "SEND", scheme: null, pathname: null, signal: 499 })), true);
});

test("isTerminalBroadcast: SEND, no path, signal 102 → false (intermediate)", () => {
    assert.equal(isTerminalBroadcast(entry({ op: "SEND", scheme: null, pathname: null, signal: 102 })), false);
});

test("isTerminalBroadcast: SEND, no path, signal 400 → false", () => {
    assert.equal(isTerminalBroadcast(entry({ op: "SEND", scheme: null, pathname: null, signal: 400 })), false);
});

test("isTerminalBroadcast: SEND directed at file:// (pathname set) → false", () => {
    assert.equal(isTerminalBroadcast(entry({ op: "SEND", scheme: null, pathname: "/tmp/x", signal: 200 })), false);
});

test("isTerminalBroadcast: SEND directed via scheme → false", () => {
    assert.equal(isTerminalBroadcast(entry({ op: "SEND", scheme: "slack", pathname: "/x", signal: 200 })), false);
});

test("isTerminalBroadcast: non-SEND op → false even with matching signal", () => {
    assert.equal(isTerminalBroadcast(entry({ op: "EDIT", scheme: null, pathname: null, signal: 200 })), false);
});

test("isTerminalBroadcast: signal not a number → false", () => {
    assert.equal(isTerminalBroadcast(entry({ op: "SEND", scheme: null, pathname: null, signal: null })), false);
    assert.equal(isTerminalBroadcast(entry({ op: "SEND", scheme: null, pathname: null, signal: "200" as unknown as number })), false);
});

// ─── buildJsonRecord (the complete client-observed run record) ────────

const accountedUsage: LoopUsage = {
    accounting: {
        requests: [{
            provider: "provider:test",
            model: "test",
            outcome: "response",
            usage: { inputTokens: 456, outputTokens: 12, totalTokens: 468 },
            cost: {
                kind: "charged",
                amount: { amount: "0.007", currency: "USD" },
                source: "provider ledger",
            },
        }],
        usage: { inputTokens: 456, outputTokens: 12 },
        costUsd: "0.007",
    },
    contextTokens: null,
    promptBudget: null,
    meta: {},
};

const recordInput = (over: Partial<Parameters<typeof buildJsonRecord>[0]> = {}): Parameters<typeof buildJsonRecord>[0] => ({
    workspace: { id: 12, name: "sess" },
    prompt: "what is the capital of France?",
    response: "Paris",
    entries: [
        entry({ op: "READ", origin: "model", scheme: "file", pathname: "/atlas.md", status_rx: 200, loop_seq: 3, turn_seq: 1, sequence: 1, tags: ["init", "research"] }),
        entry({ op: "SEND", origin: "model", scheme: null, pathname: null, signal: 200, status_rx: 200, loop_seq: 3, turn_seq: 2, sequence: 1 }),
    ],
    notices: [{ source: "engine", kind: "note", level: "info", message: "ok" }],
    result: {
        loopId: 7,
        modelWorkerId: 39,
        turnIds: [1, 2],
        finalStatus: 200,
        hitMaxTurns: false,
        usage: accountedUsage,
    },
    wallMs: 1234, timedOut: false,
    ...over,
});

test("buildJsonRecord: response at top level + schemaVersion + usage", () => {
    const doc = buildJsonRecord(recordInput()) as Record<string, unknown>;
    assert.equal(doc.schemaVersion, JSON_SCHEMA_VERSION);
    assert.equal(doc.response, "Paris");          // the jq -r .response common case
    assert.equal(doc.finalStatus, 200);
    assert.equal(doc.loopId, 7);
    assert.equal(doc.workerId, 39);   // the conversation worker, from loop.run's modelWorkerId
    assert.equal(doc.turnCount, 2);
    assert.deepEqual(doc.workspace, { id: 12, name: "sess" });
    assert.deepEqual(doc.usage, accountedUsage, "JSON preserves the cardinal accounting envelope verbatim");
});

test("buildJsonRecord: usage carries contextTokens when present (svc#263 gauge numerator)", () => {
    const doc = buildJsonRecord(recordInput({
        result: {
            loopId: 7,
            turnIds: [1],
            finalStatus: 200,
            hitMaxTurns: false,
            usage: {
                accounting: {
                    requests: [],
                    usage: { inputTokens: 0, outputTokens: 0 },
                    costUsd: "0",
                },
                contextTokens: 7360,
                promptBudget: null,
                meta: {},
            },
        },
    })) as Record<string, unknown>;
    assert.deepEqual(doc.usage, {
        accounting: {
            requests: [],
            usage: { inputTokens: 0, outputTokens: 0 },
            costUsd: "0",
        },
        contextTokens: 7360,
        promptBudget: null,
        meta: {},
    });
});

test("buildJsonRecord: ops grouped by turn, each carrying its L/T/S coordinate + target", () => {
    const doc = buildJsonRecord(recordInput()) as { turns: Array<{ turn: number; ops: Array<Record<string, unknown>> }> };
    assert.equal(doc.turns.length, 2);
    assert.equal(doc.turns[0].turn, 1);
    assert.deepEqual(doc.turns[0].ops[0], {
        coord: "03/01/01", op: "READ", origin: "model", target: "file:///atlas.md", status: 200, signal: null, tags: ["init", "research"],
    });
    // the terminal SEND keeps its numeric signal
    assert.equal(doc.turns[1].ops[0].signal, 200);
    assert.equal(doc.turns[1].ops[0].target, null);
});

test("buildJsonRecord: ambient rows from another worker never enter this run's turns", () => {
    const own = entry({ worker_id: 39, op: "SEND", signal: 200, turn_seq: 2 });
    const child = entry({ worker_id: 40, op: "SEND", signal: 499, turn_seq: 9 });
    const doc = buildJsonRecord(recordInput({ entries: [own, child] })) as {
        workerId: number;
        turns: Array<{ turn: number; ops: Array<Record<string, unknown>> }>;
    };
    assert.equal(doc.workerId, 39);
    assert.deepEqual(doc.turns.map(({ turn }) => turn), [2]);
    assert.equal(doc.turns[0].ops[0].signal, 200);
});

test("buildJsonRecord: no usage → usage null; reason carried only when present", () => {
    const noUsage = buildJsonRecord(recordInput({ result: { loopId: 1, turnIds: [1], finalStatus: 499, hitMaxTurns: false, reason: "client_timeout" } })) as Record<string, unknown>;
    assert.equal(noUsage.usage, null);
    assert.equal(noUsage.reason, "client_timeout");
    assert.ok(!("reason" in (buildJsonRecord(recordInput()) as Record<string, unknown>)));
});

test("buildJsonRecord preserves the exact terminal Problem", () => {
    const problem = clientFlagInvalid("--project-root", "./relative", "must be absolute");
    const doc = buildJsonRecord(recordInput({
        result: {
            loopId: 7,
            turnIds: [1],
            finalStatus: problem.status,
            hitMaxTurns: false,
            problem,
        },
    })) as { problem: unknown };
    assert.equal(doc.problem, problem);
});

test("buildJsonRecord: round-trips through JSON.stringify as one valid document", () => {
    const s = JSON.stringify(buildJsonRecord(recordInput()));
    const parsed = JSON.parse(s);
    assert.equal(parsed.response, "Paris");
    assert.equal(parsed.notices[0].source, "engine");
});

// ─── buildScriptJsonRecord (`plurnk script foo.plk` record) ───────────

test("buildScriptJsonRecord: results + turn-grouped ops + Notices, no loop fields", () => {
    const doc = buildScriptJsonRecord({
        workspace: { id: 5, name: "scripted" },
        results: [{ status: 200 }, { status: 404 }],
        entries: [
            entry({ op: "EDIT", origin: "client", scheme: "file", pathname: "/a.md", status_rx: 200, loop_seq: 1, turn_seq: 1, sequence: 1 }),
            entry({ op: "READ", origin: "client", scheme: "file", pathname: "/gone.md", status_rx: 404, loop_seq: 1, turn_seq: 2, sequence: 1 }),
        ],
        notices: [{ source: "scheme", kind: "degraded", level: "warn", message: "no /gone.md" }],
        wallMs: 42,
    }) as Record<string, unknown>;
    assert.equal(doc.schemaVersion, JSON_SCHEMA_VERSION);
    assert.deepEqual(doc.workspace, { id: 5, name: "scripted" });
    assert.deepEqual(doc.results, [{ status: 200 }, { status: 404 }]);
    assert.equal(doc.wallMs, 42);
    // grouped by turn, sharing buildJsonRecord's op shape
    const turns = doc.turns as Array<{ turn: number; ops: Array<Record<string, unknown>> }>;
    assert.equal(turns.length, 2);
    assert.deepEqual(turns[0].ops[0], { coord: "01/01/01", op: "EDIT", origin: "client", target: "file:///a.md", status: 200, signal: null, tags: [] });
    // no loop-only fields leak in (it's a straight-line script, no model)
    assert.ok(!("response" in doc) && !("loopId" in doc) && !("usage" in doc));
});

test("buildScriptJsonRecord: round-trips through JSON.stringify", () => {
    const s = JSON.stringify(buildScriptJsonRecord({
        workspace: { id: 1, name: "s" }, results: [{ status: 200 }], entries: [], notices: [], wallMs: 1,
    }));
    assert.deepEqual(JSON.parse(s).results, [{ status: 200 }]);
});

// ─── buildJsonError (json mode fails as valid JSON too) ───────────────

test("buildJsonError embeds the exact RFC 9457 Problem", () => {
    const problem = {
        type: "https://problems.plurnk.dev/client/rpc/error",
        title: "Error",
        status: 502,
        detail: "loop.run rejected",
        method: "loop.run",
    };
    const e = buildJsonError(problem) as { schemaVersion: number; problem: Record<string, unknown> };
    assert.equal(e.schemaVersion, JSON_SCHEMA_VERSION);
    assert.deepEqual(e.problem, problem);
    assert.equal(e.problem.method, "loop.run");
    assert.equal("error" in e, false);
    JSON.parse(JSON.stringify(e)); // must be valid JSON
});

// ─── exitCodeForLoop (benchmark surface) ──────────────────────────────

const { exitCodeForLoop } = await import("./cli.ts");

test("[§cli-exit-codes] exitCodeForLoop: 200 → 0", () => {
    assert.equal(exitCodeForLoop(200, false), 0);
});

test("exitCodeForLoop: maxTurns → 2 even at 200", () => {
    assert.equal(exitCodeForLoop(200, true), 0);
    assert.equal(exitCodeForLoop(102, true), 2);
});

test("exitCodeForLoop: 499 → 3 (cancellation)", () => {
    assert.equal(exitCodeForLoop(499, false), 3);
});

test("exitCodeForLoop: 4xx/5xx → 4 (failure ≠ cancel)", () => {
    assert.equal(exitCodeForLoop(500, false), 4);
    assert.equal(exitCodeForLoop(413, false), 4);
});

// ─── TUI verb helpers (converged language surface) ────────────────────

const { parseSlash, makeCompleter, VERBS } = await import("./tui.ts");

test("parseSlash: verb + args", () => {
    assert.deepEqual(parseSlash("/model gemma"), { verb: "model", rest: "gemma" });
    assert.deepEqual(parseSlash("/help"), { verb: "help", rest: "" });
    assert.deepEqual(parseSlash("/"), { verb: "", rest: "" });
});

// makeCompleter is readline's async form (line, callback); promisify for tests.
const complete = (getAliases: () => string[], line: string): Promise<[string[], string]> =>
    new Promise((res) => makeCompleter(getAliases, process.cwd())(line, (_e, r) => res(r)));

test("completer: verb fragments complete", async () => {
    const [hits] = await complete(() => [], "/mo");
    assert.deepEqual(hits, ["/models", "/model"]);
});

test("completer: bare slash offers every verb", async () => {
    const [hits] = await complete(() => [], "/");
    assert.equal(hits.length, VERBS.length);
});

test("completer: /model completes aliases", async () => {
    const [hits, frag] = await complete(() => ["gemma", "gpt-mini", "grok"], "/model g");
    assert.deepEqual(hits, ["gemma", "gpt-mini", "grok"]);
    assert.equal(frag, "g");
});

test("completer: /child completes inherit and aliases", async () => {
    const [hits, frag] = await complete(() => ["gemma", "gpt-mini"], "/child i");
    assert.deepEqual(hits, ["inherit"]);
    assert.equal(frag, "i");
});

test("completer: plain text completes nothing", async () => {
    const [hits] = await complete(() => ["gemma"], "what is france");
    assert.equal(hits.length, 0);
});
