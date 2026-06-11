// Unit tests for src/cli.ts pure helpers.

import { test } from "node:test";
import assert from "node:assert/strict";

import { formatPlain, isTerminalBroadcast, formatJsonReply } from "./cli.ts";
import type { LogEntryWire } from "./render.ts";

const entry = (overrides: Partial<LogEntryWire> = {}): LogEntryWire => ({
    id: 1,
    op: "READ",
    suffix: "",
    origin: "model",
    signal: null,
    scheme: null,
    pathname: null,
    hostname: null,
    fragment: null,
    status_rx: 200,
    tx: null,
    rx: null,
    ...overrides,
});

// ─── formatPlain ──────────────────────────────────────────────────────

test("formatPlain: directed op with scheme → 'scheme://...'", () => {
    const s = formatPlain(entry({ op: "EDIT", scheme: "known", pathname: "/x/y", status_rx: 201 }));
    assert.equal(s, "[201] model EDIT known:///x/y");
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
    assert.equal(s, "[200] model SEND[200]");
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
    const s = formatPlain(entry({ op: "READ", scheme: "known", pathname: "/d", fragment: "sect", status_rx: 200 }));
    assert.equal(s, "[200] model READ known:///d#sect");
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

// ─── formatJsonReply ──────────────────────────────────────────────────

test("formatJsonReply: null tx → empty", () => {
    assert.equal(formatJsonReply(null), "");
});

test("formatJsonReply: tx with null body → empty", () => {
    assert.equal(formatJsonReply({ body: null }), "");
});

test("formatJsonReply: json present → compact JSON.stringify (no double-wrap)", () => {
    assert.equal(formatJsonReply({ body: { raw: '{"k":"v"}', json: { k: "v" } } }), '{"k":"v"}');
});

test("formatJsonReply: json is the literal value null → falls through to raw stringify", () => {
    // json===null means parse failed; we should treat as non-JSON.
    assert.equal(formatJsonReply({ body: { raw: "plain text", json: null } }), '"plain text"');
});

test("formatJsonReply: raw non-JSON string → JSON-string-literal wrap", () => {
    assert.equal(formatJsonReply({ body: { raw: "Paris", json: null } }), '"Paris"');
});

test("formatJsonReply: escapes embedded quotes when wrapping raw", () => {
    assert.equal(formatJsonReply({ body: { raw: 'she said "hi"', json: null } }), '"she said \\"hi\\""');
});

test("formatJsonReply: raw not a string → empty", () => {
    assert.equal(formatJsonReply({ body: { raw: 42, json: null } }), "");
});

// ─── exitCodeForLoop / formatResultLine (benchmark surface) ───────────

const { exitCodeForLoop, formatResultLine } = await import("./cli.ts");

test("exitCodeForLoop: 200 → 0", () => {
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

test("formatResultLine: greppable prefix + compact JSON + omitted reason", () => {
    const line = formatResultLine({
        loopId: 7, finalStatus: 200, turns: 3, wallMs: 1234,
        tokens: 456, hitMaxTurns: false, timedOut: false,
    });
    assert.match(line, /^result: \{/);
    const parsed = JSON.parse(line.slice("result: ".length));
    assert.equal(parsed.loopId, 7);
    assert.equal(parsed.tokens, 456);
    assert.equal(parsed.timedOut, false);
    assert.ok(!("reason" in parsed));
});

test("formatResultLine: reason carried when present", () => {
    const line = formatResultLine({
        loopId: 1, finalStatus: 499, turns: 1, wallMs: 10,
        tokens: 0, hitMaxTurns: false, timedOut: true, reason: "client_timeout",
    });
    assert.match(line, /"timedOut":true/);
    assert.match(line, /"reason":"client_timeout"/);
});

// ─── TUI verb helpers (converged language surface) ────────────────────

const { parseSlash, makeCompleter, VERBS } = await import("./tui.ts");

test("parseSlash: verb + args", () => {
    assert.deepEqual(parseSlash("/model gemma"), { verb: "model", rest: "gemma" });
    assert.deepEqual(parseSlash("/help"), { verb: "help", rest: "" });
    assert.deepEqual(parseSlash("/"), { verb: "", rest: "" });
});

test("completer: verb fragments complete", () => {
    const complete = makeCompleter(() => []);
    const [hits] = complete("/mo");
    assert.deepEqual(hits, ["/models", "/model"]);
});

test("completer: bare slash offers every verb", () => {
    const complete = makeCompleter(() => []);
    const [hits] = complete("/");
    assert.equal(hits.length, VERBS.length);
});

test("completer: /model completes aliases", () => {
    const complete = makeCompleter(() => ["gemma", "gpt-mini", "grok"]);
    const [hits, frag] = complete("/model g");
    assert.deepEqual(hits, ["gemma", "gpt-mini", "grok"]);
    assert.equal(frag, "g");
});

test("completer: plain text completes nothing", () => {
    const complete = makeCompleter(() => ["gemma"]);
    const [hits] = complete("what is france");
    assert.equal(hits.length, 0);
});
