// Unit tests for src/render.ts. Run with NO_COLOR=1 to keep assertions
// free of ANSI escape codes — the color rendering paths are simple
// enough that visual inspection during smoke covers them.

import { test } from "node:test";
import assert from "node:assert/strict";

// Set NO_COLOR before importing render.ts so its module-load-time check
// returns false and all color helpers emit empty strings.
process.env.NO_COLOR = "1";

const {
    sendSubGlyph,
    extractSendBody,
    renderLogEntry,
    renderSummary,
    isPromptEntry,
    OP_GLYPHS,
    ORIGIN_GLYPHS,
} = await import("./render.ts");
type LogEntryWire = Awaited<ReturnType<typeof import("./render.ts")["renderLogEntry"]>> extends string
    ? Parameters<typeof import("./render.ts")["renderLogEntry"]>[0]
    : never;

// Minimal entry factory — fills in plausible defaults; callers override what matters.
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

// ─── sendSubGlyph ─────────────────────────────────────────────────────

test("sendSubGlyph: 200 → ✅", () => assert.equal(sendSubGlyph(200), "✅"));
test("sendSubGlyph: 201 → ✅ (2xx range)", () => assert.equal(sendSubGlyph(201), "✅"));
test("sendSubGlyph: 102 → ⏳ (continuing)", () => assert.equal(sendSubGlyph(102), "⏳"));
test("sendSubGlyph: 499 → ✋ (cancel)", () => assert.equal(sendSubGlyph(499), "✋"));
test("sendSubGlyph: 410 → 🗑 (gone)", () => assert.equal(sendSubGlyph(410), "🗑"));
test("sendSubGlyph: 404 → ⚠️ (4xx fallback)", () => assert.equal(sendSubGlyph(404), "⚠️ "));
test("sendSubGlyph: 500 → 🔥 (5xx)", () => assert.equal(sendSubGlyph(500), "🔥"));
test("sendSubGlyph: 100 → '' (unknown range)", () => assert.equal(sendSubGlyph(100), ""));

// ─── extractSendBody ──────────────────────────────────────────────────

test("extractSendBody: null tx → empty", () => {
    assert.equal(extractSendBody(null, true), "");
    assert.equal(extractSendBody(undefined, false), "");
});

test("extractSendBody: null body → empty", () => {
    assert.equal(extractSendBody({ body: null }, true), "");
});

test("extractSendBody prettify=false: raw verbatim, json ignored", () => {
    const tx = { body: { raw: '{"k":"v"}', json: { k: "v" } } };
    assert.equal(extractSendBody(tx, false), '{"k":"v"}');
});

test("extractSendBody prettify=false: non-string raw → empty", () => {
    const tx = { body: { raw: 123, json: 123 } };
    assert.equal(extractSendBody(tx, false), "");
});

test("extractSendBody prettify=true: json wins, pretty-printed", () => {
    const tx = { body: { raw: '{"k":"v"}', json: { k: "v" } } };
    assert.equal(extractSendBody(tx, true), '{\n  "k": "v"\n}');
});

test("extractSendBody prettify=true: markdown body → ANSI transform applied", () => {
    // With NO_COLOR=1, ANSI codes collapse to empty. Just confirm the bullet
    // substitution fires (a non-color transform).
    const tx = { body: { raw: "- item one\n- item two", json: null } };
    const out = extractSendBody(tx, true);
    assert.match(out, /• item one/);
});

test("extractSendBody prettify=true: plain text → raw verbatim", () => {
    const tx = { body: { raw: "Hello, world.", json: null } };
    assert.equal(extractSendBody(tx, true), "Hello, world.");
});

// ─── renderLogEntry: target rendering ────────────────────────────────

test("renderLogEntry: directed op with full scheme → 'scheme://...'", () => {
    const line = renderLogEntry(entry({
        op: "EDIT",
        scheme: "slack",
        pathname: "/channel/general",
        status_rx: 201,
    }));
    assert.match(line, /slack:\/\/\/channel\/general/);
});

test("renderLogEntry: file:// (scheme=null, pathname set) → bare pathname, no synthesized prefix", () => {
    const line = renderLogEntry(entry({
        op: "EDIT",
        scheme: null,
        pathname: "/tmp/foo.txt",
        status_rx: 202,
    }));
    // Bare pathname; explicitly NOT 'file:///tmp/foo.txt' (no synthesis)
    assert.match(line, /\/tmp\/foo\.txt/);
    assert.doesNotMatch(line, /file:\/\//);
});

test("renderLogEntry: hostname + pathname assembles correctly", () => {
    const line = renderLogEntry(entry({
        op: "READ",
        scheme: "https",
        hostname: "example.com",
        pathname: "/path",
        status_rx: 200,
    }));
    assert.match(line, /https:\/\/example\.com\/path/);
});

test("renderLogEntry: fragment appended with '#'", () => {
    const line = renderLogEntry(entry({
        op: "READ",
        scheme: "known",
        pathname: "/doc",
        fragment: "section-2",
        status_rx: 200,
    }));
    assert.match(line, /known:\/\/\/doc#section-2/);
});

test("renderLogEntry: no path at all (both scheme + pathname null) for non-SEND op → no path text", () => {
    const line = renderLogEntry(entry({
        op: "SHOW",
        scheme: null,
        pathname: null,
        status_rx: 200,
    }));
    assert.doesNotMatch(line, /:\/\//);
});

// ─── renderLogEntry: broadcast SEND ──────────────────────────────────

test("renderLogEntry: broadcast SEND (scheme + pathname both null) → multi-line block", () => {
    const out = renderLogEntry(entry({
        op: "SEND",
        scheme: null,
        pathname: null,
        signal: 200,
        status_rx: 200,
        tx: { body: { raw: "Hello.", json: null } },
    }));
    // Block format: starts with \n, ends with \n, body lines indented 5 spaces
    assert.match(out, /^\n/);
    assert.match(out, /\n$/);
    assert.match(out, /Hello\./);
    assert.match(out, /🤖/);  // origin glyph for model
});

test("renderLogEntry: SEND directed at file:// is NOT broadcast → trace line", () => {
    const out = renderLogEntry(entry({
        op: "SEND",
        scheme: null,
        pathname: "/tmp/somewhere.txt",
        signal: 200,
        status_rx: 200,
        tx: { body: { raw: "Hello", json: null } },
    }));
    // Trace line: starts with 2-space indent, single line, no leading \n
    assert.doesNotMatch(out, /^\n/);
    assert.match(out, /\/tmp\/somewhere\.txt/);
});

test("renderLogEntry: broadcast SEND with empty body → header only, no body lines", () => {
    const out = renderLogEntry(entry({
        op: "SEND",
        scheme: null,
        pathname: null,
        signal: 200,
        status_rx: 200,
        tx: { body: { raw: "", json: null } },
    }));
    // Single header line; only the leading and trailing \n bracket it
    const trimmed = out.replace(/^\n|\n$/g, "");
    assert.ok(!trimmed.includes("\n"), `expected single line, got: ${JSON.stringify(out)}`);
});

// ─── renderLogEntry: user prompt entry (plurnk://prompt/*) ───────────

test("isPromptEntry: classifies plurnk://prompt/* EDITs (the TUI skips them live — the typed line is the record)", () => {
    assert.equal(isPromptEntry(entry({ op: "EDIT", scheme: "plurnk", pathname: "prompt/3/1" })), true);
    assert.equal(isPromptEntry(entry({ op: "EDIT", scheme: "plurnk", pathname: "manifest.json" })), false);
    assert.equal(isPromptEntry(entry({ op: "READ", scheme: "plurnk", pathname: "prompt/3/1" })), false);
    assert.equal(isPromptEntry(entry({ op: "EDIT", scheme: "known", pathname: "prompt/3/1" })), false);
});

test("renderLogEntry: prompt entry renders as a plain EDIT trace (no speech block — TUI skips it anyway)", () => {
    const out = renderLogEntry(entry({
        op: "EDIT", origin: "system", scheme: "plurnk", pathname: "prompt/3/1",
        status_rx: 201, tx: { body: "What is the capital of France?" },
    }));
    assert.doesNotMatch(out, /^\n/);
    assert.match(out, /✏️/);
});

test("renderLogEntry: non-prompt plurnk:// EDIT stays a trace line", () => {
    const out = renderLogEntry(entry({
        op: "EDIT",
        origin: "system",
        scheme: "plurnk",
        pathname: "manifest.json",
        status_rx: 201,
        tx: { body: "{}" },
    }));
    assert.doesNotMatch(out, /^\n/);
    assert.match(out, /✏️/);
});

// ─── Conversation stripes (color-enabled import) ─────────────────────
// The main import runs under NO_COLOR; stripes need a color-enabled
// instance. A query-suffixed dynamic import busts the ESM module cache
// (computed specifier so tsc doesn't try to resolve the query form).
const freshRender = async (tag: string): Promise<typeof import("./render.ts")> =>
    await import(`./render.ts?${tag}`) as typeof import("./render.ts");

test("stripes: model broadcast gets the full-width blue band", async () => {
    process.env.NO_COLOR = "0";
    const colored = await freshRender("stripes=1");
    process.env.NO_COLOR = "1";
    const out = colored.renderLogEntry(entry({
        op: "SEND", scheme: null, pathname: null, signal: 200, status_rx: 200,
        tx: { body: { raw: "Paris.", json: null } },
    }));
    assert.match(out, /\x1b\[48;5;17m/);   // model background
    assert.match(out, /\x1b\[K/);          // painted to the right edge
});

test("stripes: client-origin broadcast gets the green band; inner RESET re-arms it", async () => {
    process.env.NO_COLOR = "0";
    const colored = await freshRender("stripes=2");
    process.env.NO_COLOR = "1";
    const out = colored.renderLogEntry(entry({
        op: "SEND", origin: "client", scheme: null, pathname: null,
        signal: 200, status_rx: 200, tx: { body: { raw: "hi", json: null } },
    }));
    assert.match(out, /\x1b\[48;5;22m/);   // user background
    // Header carries a status color that RESETs mid-line — the band must
    // resume immediately after, not die at the first reset.
    assert.match(out, /\x1b\[0m\x1b\[48;5;22m/);
});

test("stripes: NO_COLOR build emits no background codes", () => {
    const out = renderLogEntry(entry({
        op: "SEND", scheme: null, pathname: null, signal: 200, status_rx: 200,
        tx: { body: { raw: "Paris.", json: null } },
    }));
    assert.doesNotMatch(out, /48;5/);
    assert.doesNotMatch(out, /\x1b\[K/);
});

// ─── renderLogEntry: trace line shape ─────────────────────────────────

test("renderLogEntry: trace line starts with 2-space indent", () => {
    const line = renderLogEntry(entry({ op: "READ", scheme: "known", pathname: "/x" }));
    assert.match(line, /^  /);
});

test("renderLogEntry: includes origin glyph for model", () => {
    const line = renderLogEntry(entry({ op: "READ", origin: "model" }));
    assert.ok(line.includes(ORIGIN_GLYPHS.model), `expected model glyph in ${line}`);
});

test("renderLogEntry: includes origin glyph for client", () => {
    const line = renderLogEntry(entry({ op: "READ", origin: "client" }));
    assert.ok(line.includes(ORIGIN_GLYPHS.client));
});

test("renderLogEntry: includes op glyph", () => {
    const line = renderLogEntry(entry({ op: "FIND" }));
    assert.ok(line.includes(OP_GLYPHS.FIND));
});

test("renderLogEntry: unknown op → '?' glyph", () => {
    const line = renderLogEntry(entry({ op: "WHATEVER" }));
    assert.match(line, /\?/);
});

// ─── renderSummary ────────────────────────────────────────────────────

test("renderSummary: success → 'done'", () => {
    const s = renderSummary(1, 500, 100, 200, false);
    assert.match(s, /done/);
    assert.match(s, /1 turn /);
});

test("renderSummary: maxTurns flag wins over finalStatus", () => {
    const s = renderSummary(50, 18200, 6841, 200, true);
    assert.match(s, /maxTurns/);
    assert.doesNotMatch(s, /done/);
});

test("renderSummary: non-200 final → 'final <N>'", () => {
    const s = renderSummary(3, 1000, 50, 499, false);
    assert.match(s, /final 499/);
});

test("renderSummary: positive tokens render", () => {
    const s = renderSummary(1, 500, 6841, 200, false);
    assert.match(s, /6841 tokens/);
});

test("renderSummary: zero tokens omit the segment (no data ≠ zero usage)", () => {
    const s = renderSummary(1, 500, 0, 200, false);
    assert.doesNotMatch(s, /tokens/);
});

test("renderSummary: wall time in seconds when ≥1000ms", () => {
    const s = renderSummary(1, 1234, 0, 200, false);
    assert.match(s, /1\.23s/);
});

test("renderSummary: wall time in ms when <1000", () => {
    const s = renderSummary(1, 250, 0, 200, false);
    assert.match(s, /250ms/);
});

test("renderSummary: pluralizes turns", () => {
    assert.match(renderSummary(2, 500, 0, 200, false), /2 turns/);
    assert.match(renderSummary(1, 500, 0, 200, false), /1 turn /);
});

test("renderSummary: real usage wins over content-token fallback", () => {
    const s = renderSummary(2, 500, 9999, 200, false, { promptTokens: 1200, completionTokens: 345, costPico: 420000000 });
    assert.match(s, /↑1200 ↓345/);
    assert.match(s, /\$0\.0004/);
    assert.doesNotMatch(s, /9999 tokens/);
});

test("renderSummary: usage without cost omits the cost segment", () => {
    const s = renderSummary(1, 100, 0, 200, false, { promptTokens: 10, completionTokens: 5 });
    assert.match(s, /↑10 ↓5/);
    assert.doesNotMatch(s, /\$/);
});
