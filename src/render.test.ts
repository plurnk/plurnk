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
    contextGauge,
    progressLabel,
    isEntryMaterialization,
    isPromptEntry,
    entryTarget,
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

test("sendSubGlyph: routine 2xx badges nothing — blank width-2 slot (not ✅)", () => {
    assert.equal(sendSubGlyph(200), "  ");
    assert.equal(sendSubGlyph(201), "  ");
    assert.equal(sendSubGlyph(204), "  ");
});
test("sendSubGlyph: 102 → ⏳ (continuing)", () => assert.equal(sendSubGlyph(102), "⏳"));
test("sendSubGlyph: 202 → 💤 (parked/waiting — NOT the generic 2xx ✅)", () => assert.equal(sendSubGlyph(202), "💤"));
test("sendSubGlyph: 300 → 🤔 (needs a decision)", () => assert.equal(sendSubGlyph(300), "🤔"));
test("sendSubGlyph: 499 → ✋ (failed/aborted)", () => assert.equal(sendSubGlyph(499), "✋"));
test("sendSubGlyph: 410 → 💥 (directed SEND, gone)", () => assert.equal(sendSubGlyph(410), "💥"));
test("sendSubGlyph: 404 → ❌ (single failure glyph, nvim-converged)", () => assert.equal(sendSubGlyph(404), "❌"));
test("sendSubGlyph: 500 → ❌ (single failure glyph)", () => assert.equal(sendSubGlyph(500), "❌"));
test("sendSubGlyph: unknown range → reserved blank slot (width-2, keeps alignment)", () => assert.equal(sendSubGlyph(100), "  "));

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
        scheme: "worker",
        pathname: "/doc",
        fragment: "section-2",
        status_rx: 200,
    }));
    assert.match(line, /worker:\/\/\/doc#section-2/);
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

test("renderLogEntry: broadcast SEND (scheme + pathname both null) → single bold line, NO surrounding blanks", () => {
    const out = renderLogEntry(entry({
        op: "SEND",
        scheme: null,
        pathname: null,
        signal: 200,
        status_rx: 200,
        tx: { body: { raw: "Hello.", json: null } },
    }));
    // The bold body is the standout — no blank-line wrapping.
    assert.doesNotMatch(out, /^\n/);
    assert.doesNotMatch(out, /\n$/);
    assert.ok(!out.includes("\n"), `short broadcast inlines to one line, got: ${JSON.stringify(out)}`);
    assert.match(out, /Hello\./);
    assert.match(out, /💡/);  // the answer state IS the identity (operator ruling)
});

test("renderLogEntry: multi-line broadcast SEND → bold block, body indented, still no surrounding blanks", () => {
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

test("renderLogEntry: intermediate 102 broadcast → single plain line, no blanks (the per-turn ping)", () => {
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

test("renderLogEntry: PLAN → 🧠 glyph + the plan text (not a bare ?)", () => {
    const out = renderLogEntry(entry({ op: "PLAN", origin: "model", scheme: null, pathname: null, signal: null, status_rx: 200, tx: { body: "Acknowledge user prompt." } as unknown as { body: { raw: string; json: null } } }));
    assert.match(out, /🧠/);
    assert.match(out, /Acknowledge user prompt\./);
});

test("renderLogEntry: PLAN collapses newlines in the plan body", () => {
    const out = renderLogEntry(entry({ op: "PLAN", origin: "model", scheme: null, pathname: null, signal: null, status_rx: 200, tx: { body: "Step one.\nStep two." } as unknown as { body: { raw: string; json: null } } }));
    assert.match(out, /Step one\. Step two\./);
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

test("[§cli-what-is-not-rendered] isPromptEntry: classifies prompt:///loop/N EDITs (the TUI skips them live — the typed line is the record; svc#527)", () => {
    assert.equal(isPromptEntry(entry({ op: "EDIT", scheme: "prompt", pathname: "/1/1" })), true);
    assert.equal(isPromptEntry(entry({ op: "EDIT", scheme: "prompt", pathname: "/3/2" })), true, "the real foist shape prompt:///<loop>/<turn> — numeric coordinate, verified on the wire as /L/T");
    assert.equal(isPromptEntry(entry({ op: "READ", scheme: "prompt", pathname: "/1/1" })), false, "a prompt READ is not the foisted write — only the EDIT is skipped");
    assert.equal(isPromptEntry(entry({ op: "EDIT", scheme: "worker", pathname: "/notes.md" })), false, "a worker:/// entry is not a prompt");
    assert.equal(isPromptEntry(entry({ op: "EDIT", scheme: "worker", pathname: "loop/2" })), false, "a worker:/// entry is NOT a prompt");
    assert.equal(isPromptEntry(entry({ op: "EDIT", scheme: "plurnk", pathname: "prompt/3/1" })), false, "the retired plurnk:// scheme no longer classifies");
});

test("[§cli-what-is-rendered] entryTarget round-trips all four authority faces raw — the <<LOOK re-address source, no synthesis (svc#527)", () => {
    // core sends the addressable form as-typed on `hostname`; entryTarget renders it verbatim
    // so <<LOOK can re-address it. commons=empty, self=~, named, kernel=plurnk — each a valid
    // worker:// address; the face is the raw URI, legible AND round-trippable (one source).
    assert.equal(entryTarget(entry({ scheme: "worker", hostname: null, pathname: "/plan.md" })), "worker:///plan.md", "empty authority = commons, verbatim");
    assert.equal(entryTarget(entry({ scheme: "worker", hostname: "~", pathname: "/plan.md" })), "worker://~/plan.md", "~ = self, kept literal (owner ruling)");
    assert.equal(entryTarget(entry({ scheme: "worker", hostname: "extract-host", pathname: "/plan.md" })), "worker://extract-host/plan.md", "named worker verbatim");
    assert.equal(entryTarget(entry({ scheme: "worker", hostname: "plurnk", pathname: "/docs/x.md" })), "worker://plurnk/docs/x.md", "plurnk = kernel, bare (owner ruling)");
    assert.equal(entryTarget(entry({ scheme: "prompt", hostname: null, pathname: "/loop/2" })), "prompt:///loop/2", "prompt self-only, no authority slot");
});

test("renderLogEntry: prompt entry renders as a plain EDIT trace (no speech block — TUI skips it anyway)", () => {
    const out = renderLogEntry(entry({
        op: "EDIT", origin: "plurnk", scheme: "prompt", pathname: "/1/1",
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

// ─── Conversation bold (color-enabled import) ────────────────────────
// The model's ANSWER (terminal SEND) renders BOLD; no background band
// (background-color-erase isn't universal → jagged stripes). The main
// import runs under NO_COLOR; bold needs a color-enabled instance. A
// query-suffixed dynamic import busts the ESM module cache (computed
// specifier so tsc doesn't try to resolve the query form).
const freshRender = async (tag: string): Promise<typeof import("./render.ts")> =>
    await import(`./render.ts?${tag}`) as typeof import("./render.ts");

const sendEntry = { op: "SEND", scheme: null, pathname: null, signal: 200, status_rx: 200, tx: { body: { raw: "Paris.", json: null } } };

test("bold: the model's terminal SEND (200) renders bold, with NO background band", async () => {
    process.env.NO_COLOR = "0";
    const colored = await freshRender("bold=1");
    process.env.NO_COLOR = "1";
    const out = colored.renderLogEntry(entry(sendEntry));
    assert.match(out, /\x1b\[1m/);          // bold
    assert.doesNotMatch(out, /48;[25]/);    // no background band of any kind
    assert.doesNotMatch(out, /\x1b\[K/);    // no edge-paint
});

test("bold: a cancelled terminal SEND (499) is also bold (it's a terminal answer)", async () => {
    process.env.NO_COLOR = "0";
    const colored = await freshRender("bold=499");
    process.env.NO_COLOR = "1";
    const out = colored.renderLogEntry(entry({ ...sendEntry, signal: 499, status_rx: 499 }));
    assert.match(out, /\x1b\[1m/);
});

test("bold: an intermediate 102 ping is NOT bold (only the terminal answer pops)", async () => {
    process.env.NO_COLOR = "0";
    const colored = await freshRender("bold=102");
    process.env.NO_COLOR = "1";
    const out = colored.renderLogEntry(entry({ ...sendEntry, signal: 102, status_rx: 102, tx: { body: { raw: "working…", json: null } } }));
    assert.doesNotMatch(out, /\x1b\[1m/);   // plain
});

test("bold: inner RESET re-arms bold so a markdown span can't cut it mid-line", async () => {
    process.env.NO_COLOR = "0";
    const colored = await freshRender("bold=rearm");
    process.env.NO_COLOR = "1";
    // The markdown **bold** span emits its own RESET; the line-bold must resume
    // immediately after, not die at the first reset.
    const out = colored.renderLogEntry(entry({ ...sendEntry, tx: { body: { raw: "**strong** then more", json: null } } }));
    assert.match(out, /\x1b\[0m\x1b\[1m/);
});

test("bold: a client-origin broadcast is NOT bold (only the MODEL's answer)", async () => {
    process.env.NO_COLOR = "0";
    const colored = await freshRender("bold=client");
    process.env.NO_COLOR = "1";
    const out = colored.renderLogEntry(entry({
        op: "SEND", origin: "client", scheme: null, pathname: null,
        signal: 200, status_rx: 200, tx: { body: { raw: "hi", json: null } },
    }));
    assert.doesNotMatch(out, /\x1b\[1m/);
});

test("bold: NO_COLOR build emits no bold (or background) codes", () => {
    const out = renderLogEntry(entry({
        op: "SEND", scheme: null, pathname: null, signal: 200, status_rx: 200,
        tx: { body: { raw: "Paris.", json: null } },
    }));
    assert.doesNotMatch(out, /\x1b\[1m/);  // no bold
    assert.doesNotMatch(out, /48;[25]/);   // no background band
    assert.doesNotMatch(out, /\x1b\[K/);
});

// ─── renderLogEntry: trace line shape ─────────────────────────────────

test("renderLogEntry: trace line starts with 2-space indent", () => {
    const line = renderLogEntry(entry({ op: "READ", scheme: "worker", pathname: "/x" }));
    assert.match(line, /^  /);
});

test("renderLogEntry: a SEND shows the ACTOR glyph (who's speaking), not the op 💬", () => {
    const client = renderLogEntry(entry({ op: "SEND", origin: "client", scheme: null, pathname: null, signal: 201, status_rx: 201, tx: { body: { raw: "hi" } } }));
    assert.ok(client.includes(ORIGIN_GLYPHS.client), `expected 🐹 in ${client}`);
    assert.ok(!client.includes(OP_GLYPHS.SEND), "the 💬 op glyph is dropped — the actor conveys speaking");
});

test("renderLogEntry: an operation shows its OP glyph, no origin column", () => {
    const line = renderLogEntry(entry({ op: "READ", origin: "model", scheme: "worker", pathname: "/x", status_rx: 200 }));
    assert.ok(line.includes(OP_GLYPHS.READ), `expected 📖 in ${line}`);
    assert.ok(!line.includes(ORIGIN_GLYPHS.model), "op rows drop the origin — the op glyph is self-evidently the agent working");
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

test("renderSummary: differentiated terminal codes get distinct labels (#70)", () => {
    assert.match(renderSummary(3, 1000, 499, false, usage(10, 5)), /cancelled/);
    assert.match(renderSummary(3, 1000, 413, false, usage(10, 5)), /budget overflow/);
    assert.match(renderSummary(3, 1000, 429, false, usage(10, 5)), /turn ceiling/);
    assert.match(renderSummary(3, 1000, 500, false, usage(10, 5)), /strike-out/);
    assert.match(renderSummary(3, 1000, 508, false, usage(10, 5)), /loop detected/);
});

test("renderSummary: an unmapped non-200 still falls back to 'final <N>'", () => {
    assert.match(renderSummary(3, 1000, 418, false, usage(10, 5)), /final 418/);
});

test("renderSummary: real usage renders ↑prompt ↓completion + loop cost", () => {
    const s = renderSummary(2, 500, 200, false, usage(1200, 345, 420000000));
    assert.match(s, /↑1200 ↓345/);
    assert.match(s, /loop \$0\.0004/);
});

// ─── contextGauge (svc#263) ──────────────────────────────────────────

test("[§cli-summary-line-per-looprun] contextGauge: occupancy + window → 'ctx N%/Mk'", () => {
    assert.equal(contextGauge(7360, 49152), " · ctx 15%/49k");
});

test("contextGauge: sub-1000 window stays bare (no k)", () => {
    assert.equal(contextGauge(120, 512), " · ctx 23%/512");
});

test("contextGauge: null/absent promptBudget → omitted (never guessed)", () => {
    assert.equal(contextGauge(7360, null), "");
    assert.equal(contextGauge(7360, undefined), "");
    assert.equal(contextGauge(7360, 0), "");
});

test("contextGauge: absent contextTokens → omitted", () => {
    assert.equal(contextGauge(undefined, 49152), "");
});

test("renderSummary: contextTokens + promptBudget → gauge appended", () => {
    const s = renderSummary(1, 500, 200, false, { ...usage(7360, 27), contextTokens: 7360 }, 49152);
    assert.match(s, /ctx 15%\/49k/);
});

test("renderSummary: no promptBudget → no gauge even with contextTokens", () => {
    const s = renderSummary(1, 500, 200, false, { ...usage(7360, 27), contextTokens: 7360 });
    assert.doesNotMatch(s, /ctx /);
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

test("renderSummary: loop / workspace / remaining — each only when available (svc#254/#252)", () => {
    const all = renderSummary(1, 100, 200, false, { promptTokens: 10, completionTokens: 5, costPico: 420000000, sessionCostPico: 12_560_000_000_000, balancePico: 198_530_000_000_000 });
    assert.match(all, /loop \$0\.0004/);
    assert.match(all, /workspace \$12\.56/);     // daemon's authoritative total
    assert.match(all, /remaining \$198\.53/);  // account balance
    // Neither pushed → only the loop cost shows; workspace/remaining stay dark.
    const loopOnly = renderSummary(1, 100, 200, false, usage(10, 5, 420000000));
    assert.match(loopOnly, /loop \$/);
    assert.doesNotMatch(loopOnly, /workspace|remaining/);
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

test("[§cli-broadcast-send-rendering] broadcast: short single-line body inlines after the header", () => {
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

test("status glyph: routine 2xx badges NOTHING (no ✅); only notable statuses glyph", () => {
    assert.doesNotMatch(renderLogEntry(entry({ op: "EDIT", scheme: "unknown", pathname: "/x", status_rx: 201, tx: { body: "p" } })), /✅/);
    assert.match(renderLogEntry(entry({ op: "EXEC", scheme: "exec", pathname: "search/1", status_rx: 501, tx: { body: "q" } })), /❌/);
    assert.match(renderLogEntry(entry({ op: "READ", scheme: "worker", pathname: "/y", status_rx: 404, rx: {}, tx: {} })), /❌/);
});

// ─── Coordinate prefix (plurnk-service#208) ───────────────────────────

test("[§cli-log-entry-line-format] coordinate: zero-padded L/T/S prefix when the wire carries seqs", () => {
    const out = renderLogEntry(entry({
        op: "READ", scheme: "worker", pathname: "/x", status_rx: 200,
        loop_seq: 1, turn_seq: 2, sequence: 3, rx: {}, tx: {},
    }));
    assert.match(out, /01\/02\/03 /);
});

test("coordinate: grows past two digits without truncation", () => {
    const out = renderLogEntry(entry({
        op: "READ", scheme: "worker", pathname: "/x", status_rx: 200,
        loop_seq: 7, turn_seq: 104, sequence: 12, rx: {}, tx: {},
    }));
    assert.match(out, /07\/104\/12 /);
});

test("active-prompt progress occupies the coordinate's eight visible cells", () => {
    assert.equal(progressLabel(42), "     42% ");
    assert.equal(progressLabel(100), "    100% ");
});

test("entry materialization narration is recognized from hydrated or JSON attrs", () => {
    const base = { origin: "plurnk", op: "EDIT" } as Partial<LogEntryWire>;
    assert.equal(isEntryMaterialization(entry({ ...base, attrs: { kind: "entry_materialized" } })), true);
    assert.equal(isEntryMaterialization(entry({ ...base, attrs: JSON.stringify({ kind: "entry_materialized" }) })), true);
    assert.equal(isEntryMaterialization(entry({ ...base, attrs: "{bad json" })), false);
    assert.equal(isEntryMaterialization(entry({ ...base, origin: "model", attrs: { kind: "entry_materialized" } })), false);
});

test("coordinate: rendered from the wire ordinals, never DB ids", () => {
    // loop_id/turn_id are the DB keys; the prefix uses ONLY loop_seq/turn_seq.
    const out = renderLogEntry(entry({
        op: "READ", scheme: "worker", pathname: "/x", status_rx: 200,
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
    const out = renderLogEntry(entry({ op: "FIND", scheme: "worker", pathname: "/**", status_rx: 200, tx: {}, rx: { results: "a\nb\nc" } }));
    assert.match(out, /→ 3 results/);
    assert.match(out, /🔍/);
});

test("renderLogEntry: FIND with one result is singular", () => {
    const out = renderLogEntry(entry({ op: "FIND", scheme: "worker", pathname: "/**", status_rx: 200, tx: {}, rx: { results: "only" } }));
    assert.match(out, /→ 1 result\b/);
});

test("renderLogEntry: FIND counts an ARRAY rx.results (uniform matcher, #129)", () => {
    const items = Array.from({ length: 33 }, (_, i) => ({ pathname: `/f${i}` }));
    const out = renderLogEntry(entry({ op: "FIND", scheme: "file", pathname: "/**", status_rx: 200, tx: {}, rx: { results: items } }));
    assert.match(out, /→ 33 results/);
});

test("renderLogEntry: FIND with missing/empty rx → 0 results", () => {
    const out = renderLogEntry(entry({ op: "FIND", scheme: "file", pathname: "/**", status_rx: 200, tx: {}, rx: {} }));
    assert.match(out, /→ 0 results/);
});

test("renderLogEntry: COPY shows the destination", () => {
    const out = renderLogEntry(entry({ op: "COPY", scheme: "worker", pathname: "/a", status_rx: 200, tx: { body: { raw: "worker://b" } } }));
    assert.match(out, /→ worker:\/\/b/);
    assert.match(out, /📋/);
});

test("renderLogEntry: COPY/MOVE with null body reads (deleted)", () => {
    const out = renderLogEntry(entry({ op: "MOVE", scheme: "worker", pathname: "/a", status_rx: 200, tx: { body: null } }));
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
    for (const status of [102, 202, 301, 404, 500]) {
        const out = renderLogEntry(entry({ op: "READ", scheme: "worker", pathname: "/x", status_rx: status, rx: {} }));
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

test("[§cli-summary-line-per-looprun] contextGauge: renders the daemon's per-loop window (a switched model reports its own; the client never re-derives it)", () => {
    // The denominator is usage.promptBudget from THIS loop — the daemon owns it under the
    // agnostic ruler. Whatever window the loop ran with is what the gauge shows.
    assert.equal(contextGauge(18000, 36000), " · ctx 50%/36k");
    assert.equal(contextGauge(18000, 128000), " · ctx 14%/128k");
    assert.equal(contextGauge(18000, null), "", "a loop the daemon can't window omits the gauge, never lies with a stale one");
});

test("[§cli-summary-line-per-looprun] renderSummary: the ctx window is the loop's OWN usage.promptBudget — realignment to the daemon's per-loop figure (n/2 refactor)", () => {
    const usage = { promptTokens: 1, completionTokens: 1, costPico: 0, contextTokens: 12000, promptBudget: 48000 };
    // The TUI now passes usage.promptBudget as the denominator; the gauge reflects that loop's window.
    const line = renderSummary(2, 1000, 200, false, usage, usage.promptBudget);
    assert.match(line, /ctx 25%\/48k/, "the window came from the loop's usage, not a client-side alias lookup");
    // A loop whose window the daemon can't report → no gauge (never a stale number).
    assert.doesNotMatch(renderSummary(2, 1000, 200, false, { ...usage, promptBudget: null }, null), /ctx /);
});
