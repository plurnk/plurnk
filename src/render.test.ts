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
    loop_seq: 1,
    turn_seq: 1,
    sequence: 1,
    ...overrides,
});

// ─── sendSubGlyph ─────────────────────────────────────────────────────

test("sendSubGlyph: 200 → ✅", () => assert.equal(sendSubGlyph(200), "✅"));
test("sendSubGlyph: 201 → ✅ (2xx range)", () => assert.equal(sendSubGlyph(201), "✅"));
test("sendSubGlyph: 102 → ⏳ (continuing)", () => assert.equal(sendSubGlyph(102), "⏳"));
test("sendSubGlyph: 499 → ✋ (cancel)", () => assert.equal(sendSubGlyph(499), "✋"));
test("sendSubGlyph: 410 → 💥 (gone/deleted)", () => assert.equal(sendSubGlyph(410), "💥"));
test("sendSubGlyph: 404 → ❌ (single failure glyph, nvim-converged)", () => assert.equal(sendSubGlyph(404), "❌"));
test("sendSubGlyph: 500 → ❌ (single failure glyph)", () => assert.equal(sendSubGlyph(500), "❌"));
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

test("renderLogEntry: broadcast SEND (scheme + pathname both null) → single striped line, NO surrounding blanks", () => {
    const out = renderLogEntry(entry({
        op: "SEND",
        scheme: null,
        pathname: null,
        signal: 200,
        status_rx: 200,
        tx: { body: { raw: "Hello.", json: null } },
    }));
    // The stripe background is the standout — no blank-line wrapping.
    assert.doesNotMatch(out, /^\n/);
    assert.doesNotMatch(out, /\n$/);
    assert.ok(!out.includes("\n"), `short broadcast inlines to one line, got: ${JSON.stringify(out)}`);
    assert.match(out, /Hello\./);
    assert.match(out, /🤖/);  // origin glyph for model
});

test("renderLogEntry: multi-line broadcast SEND → striped block, body indented, still no surrounding blanks", () => {
    const out = renderLogEntry(entry({
        op: "SEND",
        scheme: null,
        pathname: null,
        signal: 200,
        status_rx: 200,
        tx: { body: { raw: "line one\nline two", json: null } },
    }));
    assert.doesNotMatch(out, /^\n/);
    assert.doesNotMatch(out, /\n$/);
    assert.match(out, /line one/);
    assert.match(out, /line two/);
});

test("renderLogEntry: intermediate 102 broadcast → single striped line, no blanks (the per-turn ping)", () => {
    const out = renderLogEntry(entry({
        op: "SEND",
        scheme: null,
        pathname: null,
        signal: 102,
        status_rx: 102,
        tx: { body: { raw: "still working…", json: null } },
    }));
    assert.doesNotMatch(out, /^\n/);
    assert.doesNotMatch(out, /\n$/);
    assert.ok(!out.includes("\n"), `102 ping is one line, got: ${JSON.stringify(out)}`);
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
    // Single header line, no surrounding blanks.
    assert.doesNotMatch(out, /^\n/);
    assert.doesNotMatch(out, /\n$/);
    assert.ok(!out.includes("\n"), `expected single line, got: ${JSON.stringify(out)}`);
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
        op: "EDIT", origin: "plurnk", scheme: "plurnk", pathname: "prompt/3/1",
        status_rx: 201, tx: { body: "What is the capital of France?" },
    }));
    assert.doesNotMatch(out, /^\n/);
    assert.match(out, /📝/);
});

test("renderLogEntry: non-prompt plurnk:// EDIT stays a trace line", () => {
    const out = renderLogEntry(entry({
        op: "EDIT",
        origin: "plurnk",
        scheme: "plurnk",
        pathname: "manifest.json",
        status_rx: 201,
        tx: { body: "{}" },
    }));
    assert.doesNotMatch(out, /^\n/);
    assert.match(out, /📝/);
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

const usage = (p: number, c: number, cost = 0) => ({ promptTokens: p, completionTokens: c, costPico: cost });

test("renderSummary: success → 'done'", () => {
    const s = renderSummary(1, 500, 200, false, usage(10, 5));
    assert.match(s, /done/);
    assert.match(s, /1 turn /);
});

test("renderSummary: maxTurns flag wins over finalStatus", () => {
    const s = renderSummary(50, 18200, 200, true, usage(100, 50));
    assert.match(s, /maxTurns/);
    assert.doesNotMatch(s, /done/);
});

test("renderSummary: non-200 final → 'final <N>'", () => {
    const s = renderSummary(3, 1000, 499, false, usage(10, 5));
    assert.match(s, /final 499/);
});

test("renderSummary: real usage renders ↑prompt ↓completion + cost", () => {
    const s = renderSummary(2, 500, 200, false, usage(1200, 345, 420000000));
    assert.match(s, /↑1200 ↓345/);
    assert.match(s, /\$0\.0004/);
});

test("renderSummary: usage without cost omits the cost segment", () => {
    const s = renderSummary(1, 100, 200, false, usage(10, 5));
    assert.match(s, /↑10 ↓5/);
    assert.doesNotMatch(s, /\$/);
});

test("renderSummary: no usage (non-model op) omits the token part", () => {
    const s = renderSummary(0, 50, 201, false);
    assert.doesNotMatch(s, /↑|tokens/);
});

test("renderSummary: wall time in seconds when ≥1000ms", () => {
    assert.match(renderSummary(1, 1234, 200, false, usage(1, 1)), /1\.23s/);
});

test("renderSummary: wall time in ms when <1000", () => {
    assert.match(renderSummary(1, 250, 200, false, usage(1, 1)), /250ms/);
});

test("renderSummary: pluralizes turns", () => {
    assert.match(renderSummary(2, 500, 200, false, usage(1, 1)), /2 turns/);
    assert.match(renderSummary(1, 500, 200, false, usage(1, 1)), /1 turn /);
});

// ─── Inline broadcasts + universal status glyph (v0.10.0) ─────────────

test("broadcast: short single-line body inlines after the header", () => {
    const out = renderLogEntry(entry({
        op: "SEND", scheme: null, pathname: null, signal: 200, status_rx: 200,
        tx: { body: { raw: "Paris.", json: null } },
    }));
    const inner = out.replace(/^\n|\n$/g, "");
    assert.ok(!inner.includes("\n"), `expected one line, got: ${JSON.stringify(out)}`);
    assert.match(inner, /Paris\.$/);
});

test("broadcast: multi-line body starts on the second line", () => {
    const out = renderLogEntry(entry({
        op: "SEND", scheme: null, pathname: null, signal: 200, status_rx: 200,
        tx: { body: { raw: "line one\nline two", json: null } },
    }));
    const lines = out.replace(/^\n|\n$/g, "").split("\n");
    assert.equal(lines.length, 3);
    assert.doesNotMatch(lines[0], /line one/);
    assert.match(lines[1], /^     line one/);
});

test("broadcast: long single-line body breaks to the second line", () => {
    const long = "x".repeat(81);
    const out = renderLogEntry(entry({
        op: "SEND", scheme: null, pathname: null, signal: 200, status_rx: 200,
        tx: { body: { raw: long, json: null } },
    }));
    assert.equal(out.replace(/^\n|\n$/g, "").split("\n").length, 2);
});

test("universal status glyph: every trace line carries one", () => {
    assert.match(renderLogEntry(entry({ op: "EDIT", scheme: "unknown", pathname: "/x", status_rx: 201, tx: { body: "p" } })), /✅/);
    assert.match(renderLogEntry(entry({ op: "EXEC", scheme: "exec", pathname: "search/1", status_rx: 501, tx: { body: "q" } })), /❌/);
    assert.match(renderLogEntry(entry({ op: "READ", scheme: "known", pathname: "/y", status_rx: 404, rx: {}, tx: {} })), /❌/);
});

// ─── Coordinate prefix (plurnk-service#208) ───────────────────────────

test("coordinate: zero-padded L/T/S prefix when the wire carries seqs", () => {
    const out = renderLogEntry(entry({
        op: "READ", scheme: "known", pathname: "/x", status_rx: 200,
        loop_seq: 1, turn_seq: 2, sequence: 3, rx: {}, tx: {},
    }));
    assert.match(out, /01\/02\/03 /);
});

test("coordinate: grows past two digits without truncation", () => {
    const out = renderLogEntry(entry({
        op: "READ", scheme: "known", pathname: "/x", status_rx: 200,
        loop_seq: 7, turn_seq: 104, sequence: 12, rx: {}, tx: {},
    }));
    assert.match(out, /07\/104\/12 /);
});

test("coordinate: rendered from the wire ordinals, never DB ids", () => {
    // loop_id/turn_id are the DB keys; the prefix uses ONLY loop_seq/turn_seq.
    const out = renderLogEntry(entry({
        op: "READ", scheme: "known", pathname: "/x", status_rx: 200,
        loop_seq: 1, turn_seq: 2, sequence: 3, rx: {}, tx: {},
        // @ts-expect-error — DB ids are not part of LogEntryWire; ensure
        // they can't leak into the coordinate even if present on the row.
        loop_id: 38, turn_id: 412,
    }));
    assert.match(out, /01\/02\/03 /);
    assert.doesNotMatch(out, /38\/412/);
});

test("coordinate: broadcasts carry it on the header line", () => {
    const out = renderLogEntry(entry({
        op: "SEND", scheme: null, pathname: null, signal: 200, status_rx: 200,
        loop_seq: 1, turn_seq: 4, sequence: 1, tx: { body: { raw: "Paris", json: null } },
    }));
    assert.match(out, /01\/04\/01 /);
});

// ─── buildExtra: per-op branch coverage ──────────────────────────────

test("renderLogEntry: FIND shows the result count", () => {
    const out = renderLogEntry(entry({ op: "FIND", scheme: "known", pathname: "/**", status_rx: 200, tx: {}, rx: { results: "a\nb\nc" } }));
    assert.match(out, /→ 3 results/);
    assert.match(out, /🔍/);
});

test("renderLogEntry: FIND with one result is singular", () => {
    const out = renderLogEntry(entry({ op: "FIND", scheme: "known", pathname: "/**", status_rx: 200, tx: {}, rx: { results: "only" } }));
    assert.match(out, /→ 1 result\b/);
});

test("renderLogEntry: COPY shows the destination", () => {
    const out = renderLogEntry(entry({ op: "COPY", scheme: "known", pathname: "/a", status_rx: 200, tx: { body: { raw: "known://b" } } }));
    assert.match(out, /→ known:\/\/b/);
    assert.match(out, /📋/);
});

test("renderLogEntry: COPY/MOVE with null body reads (deleted)", () => {
    const out = renderLogEntry(entry({ op: "MOVE", scheme: "known", pathname: "/a", status_rx: 200, tx: { body: null } }));
    assert.match(out, /\(deleted\)/);
    assert.match(out, /📦/);
});

test("renderLogEntry: EXEC shows the command body", () => {
    const out = renderLogEntry(entry({ op: "EXEC", scheme: "exec", pathname: "/1/1/1", status_rx: 200, tx: { body: "ls -la" } }));
    assert.match(out, /"ls -la"/);
    assert.match(out, /🔧/);
});

// ─── colorForStatus: each status class is exercised ──────────────────

test("renderLogEntry: status classes render without throwing (color branches)", () => {
    for (const status of [102, 301, 404, 500]) {
        const out = renderLogEntry(entry({ op: "READ", scheme: "known", pathname: "/x", status_rx: status, rx: {} }));
        assert.match(out, new RegExp(String(status)), `status ${status} appears`);
    }
});

// ─── renderMarkdown: construct branches (via prettify) ───────────────

test("extractSendBody prettify: markdown header → bold, no leading #", () => {
    const out = extractSendBody({ body: { raw: "# Title", json: null } }, true);
    assert.match(out, /Title/);
    assert.doesNotMatch(out, /# Title/);
});

test("extractSendBody prettify: bold, inline code, and bullets transform", () => {
    assert.match(extractSendBody({ body: { raw: "**strong**", json: null } }, true), /strong/);
    assert.match(extractSendBody({ body: { raw: "`code`", json: null } }, true), /code/);
    assert.match(extractSendBody({ body: { raw: "- one\n- two", json: null } }, true), /• one/);
});

test("extractSendBody prettify: plain text (no markdown markers) passes through", () => {
    assert.equal(extractSendBody({ body: { raw: "just words", json: null } }, true), "just words");
});

// ─── renderSummary: usage token part ─────────────────────────────────

test("renderSummary: usage renders ↑prompt ↓completion and cost", () => {
    const out = renderSummary(3, 850, 200, false, { promptTokens: 100, completionTokens: 50, costPico: 500_000_000_000 });
    assert.match(out, /↑100 ↓50/);
    assert.match(out, /\$0\.5000/);
});

test("renderSummary: zero cost omits the $ part", () => {
    const out = renderSummary(1, 100, 200, false, { promptTokens: 10, completionTokens: 5, costPico: 0 });
    assert.match(out, /↑10 ↓5/);
    assert.doesNotMatch(out, /\$/);
});
