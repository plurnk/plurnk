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
    renderReasoning,
    renderReasoningFrame,
    renderSummary,
    curationGauge,
    contextGauge,
    progressLabel,
    coordLabel,
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
    lineMarker: null,
    status_rx: 200,
    tx: null,
    rx: null,
    tags: [],
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
    // With NO_COLOR=1, ANSI codes collapse to empty. The mature renderer owns
    // the terminal list marker and indentation.
    const tx = { body: { raw: "- item one\n- item two", json: null } };
    const out = extractSendBody(tx, true);
    assert.match(out, /\* item one/);
});

test("extractSendBody prettify=true: plain text → raw verbatim", () => {
    const tx = { body: { raw: "Hello, world.", json: null } };
    assert.equal(extractSendBody(tx, true), "Hello, world.");
});

test("renderReasoning: distinct, compact block with no coordinate or status code", () => {
    assert.equal(renderReasoning("first line\nsecond line"), "  💭 first line\n     second line");
});

test("[§cli-provider-reasoning] renderReasoningFrame commits complete rows and retains only the live tail", () => {
    assert.deepEqual(renderReasoningFrame("first\nsecond", 80), {
        committed: ["  💭 first"],
        tail: "     second",
    });
    assert.deepEqual(renderReasoningFrame("abcdefghijklmnop", 20), {
        committed: ["  💭 abcdefghijklm"],
        tail: "     nop",
    });
});

test("renderReasoningFrame preserves explicit blank lines without inventing an empty tail", () => {
    assert.deepEqual(renderReasoningFrame("first\n\n", 80), {
        committed: ["  💭 first", "     "],
        tail: null,
    });
    assert.deepEqual(renderReasoningFrame("", 80), { committed: [], tail: null });
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

test("renderLogEntry: a durable annotation renders as sanitized plain text", () => {
    const line = renderLogEntry(entry({
        op: "EXEC",
        tx: { annotation: "Lists **issues**\u001b[31m", body: "{}" },
    }));
    assert.match(line, /— Lists \*\*issues\*\*/);
    assert.doesNotMatch(line, /\u001b\[31m/);
});

test("renderLogEntry: a broadcast SEND retains its annotation on the header", () => {
    const out = renderLogEntry(entry({
        op: "SEND",
        signal: 200,
        tx: { annotation: "Answer ready", body: { raw: "Paris", json: null } },
    }));
    assert.match(out, /200 — Answer ready Paris/);
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
    assert.match(out, /💡/);  // the answer state is the identity
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

test("[§cli-markdown-projection] broadcast GFM uses the current screen width after its body indent", () => {
    const body = [
        "| Layer | Role |",
        "| --- | --- |",
        "| Entry | A complete description that must wrap without losing any words. |",
        "| Wire | short |",
    ].join("\n");
    const value = entry({
        op: "SEND",
        scheme: null,
        pathname: null,
        signal: 200,
        status_rx: 200,
        tx: { body: { raw: body, json: null } },
    });
    const narrow = renderLogEntry(value, 48);
    const wide = renderLogEntry(value, 96);
    assert.ok(narrow.split("\n").every((line) => line.length <= 48));
    assert.ok(wide.split("\n").every((line) => line.length <= 96));
    assert.ok(narrow.split("\n").length > wide.split("\n").length, "a narrower live viewport produces more wrapped rows");
    assert.doesNotMatch(narrow, /…/);
    assert.match(narrow, /losing any/);
    assert.match(narrow, /words\./);
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

test("[§cli-plan-rendering] PLAN renders one ordered status-glyph line per entry", () => {
    const out = renderLogEntry(entry({
        op: "PLAN",
        origin: "model",
        scheme: null,
        pathname: null,
        signal: null,
        status_rx: 200,
        tx: {
            body: {
                entries: [
                    { content: "Contract settled.", priority: "medium", status: "completed" },
                    { content: "Memory: One baseline owns the schema.", priority: "medium", status: "completed" },
                    { content: "Update\nclients.", priority: "high", status: "in_progress" },
                    { content: "Run drills.", priority: "low", status: "pending" },
                ],
            },
        } as unknown as { body: { raw: string; json: null } },
    }));
    assert.deepEqual(out.split("\n"), [
        "  ✅ Contract settled.",
        "  💾 One baseline owns the schema.",
        "  🚧 [high] Update clients.",
        "  ⬜ [low] Run drills.",
    ], "a routine PLAN carries neither coordinates nor a status code (plurnk#21)");
    assert.doesNotMatch(out, /🧠/);
});

test("renderLogEntry: an empty PLAN remains a visible durable row", () => {
    const out = renderLogEntry(entry({
        op: "PLAN",
        tx: { body: { entries: [] } } as unknown as { body: { raw: string; json: null } },
    }));
    assert.equal(out, "  📭 no entries", "an empty PLAN stays visible, without coordinate or routine code");
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

// ─── user prompt entries ─────────────────────────────────────────────

test("[§cli-what-is-not-rendered] isPromptEntry classifies only the service's actionless prompt row", () => {
    assert.equal(isPromptEntry(entry({ op: "prompt", scheme: "prompt", pathname: "/1/1" })), true);
    assert.equal(isPromptEntry(entry({ op: "prompt", scheme: "prompt", pathname: "/3/2" })), true);
    assert.equal(isPromptEntry(entry({ op: "EDIT", scheme: "prompt", pathname: "/1/1" })), false, "the obsolete synthetic EDIT shape is not tolerated");
    assert.equal(isPromptEntry(entry({ op: "READ", scheme: "prompt", pathname: "/1/1" })), false);
    assert.equal(isPromptEntry(entry({ op: "prompt", scheme: "worker", pathname: "/notes.md" })), false);
});

test("[§cli-log-entry-line-format] entryTarget round-trips all four authority faces raw — the LOOK re-address source, no synthesis", () => {
    // core sends the addressable form as-typed on `hostname`; entryTarget renders it verbatim
    // so LOOK can re-address it. commons=empty, self=~, named, kernel=plurnk — each a valid
    // worker:// address; the face is the raw URI, legible AND round-trippable (one source).
    assert.equal(entryTarget(entry({ scheme: "worker", hostname: null, pathname: "/plan.md" })), "worker:///plan.md", "empty authority = commons, verbatim");
    assert.equal(entryTarget(entry({ scheme: "worker", hostname: "~", pathname: "/plan.md" })), "worker://~/plan.md", "~ = self, kept literal");
    assert.equal(entryTarget(entry({ scheme: "worker", hostname: "extract-host", pathname: "/plan.md" })), "worker://extract-host/plan.md", "named worker verbatim");
    assert.equal(entryTarget(entry({ scheme: "worker", hostname: "plurnk", pathname: "/docs/x.md" })), "worker://plurnk/docs/x.md", "plurnk = kernel, bare");
    assert.equal(entryTarget(entry({ scheme: "prompt", hostname: null, pathname: "/loop/2" })), "prompt:///loop/2", "prompt self-only, no authority slot");
});

test("[§cli-log-entry-line-format] renderLogEntry preserves the operation scope", () => {
    const out = renderLogEntry(entry({
        scheme: null,
        pathname: "evaluator/functions.go",
        lineMarker: { marks: ["@Xb59M", "@KPohD"] },
    }));
    assert.match(out, /evaluator\/functions\.go <@Xb59M,@KPohD>/);
});

test("renderLogEntry does not reinterpret an actionless prompt as EDIT", () => {
    const out = renderLogEntry(entry({
        op: "prompt", origin: "plurnk", scheme: "prompt", pathname: "/1/1",
        status_rx: 200, rx: { content: "What is the capital of France?" },
    }));
    assert.doesNotMatch(out, /^\n/);
    assert.doesNotMatch(out, /📝/);
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
    delete process.env.NO_COLOR; // any non-empty value disables (no-color.org, plurnk#29)
    const colored = await freshRender("bold=1");
    process.env.NO_COLOR = "1";
    const out = colored.renderLogEntry(entry(sendEntry));
    assert.match(out, /\x1b\[1m/);          // bold
    assert.doesNotMatch(out, /48;[25]/);    // no background band of any kind
    assert.doesNotMatch(out, /\x1b\[K/);    // no edge-paint
});

test("bold: a cancelled terminal SEND (499) is also bold (it's a terminal answer)", async () => {
    delete process.env.NO_COLOR; // any non-empty value disables (no-color.org, plurnk#29)
    const colored = await freshRender("bold=499");
    process.env.NO_COLOR = "1";
    const out = colored.renderLogEntry(entry({ ...sendEntry, signal: 499, status_rx: 499 }));
    assert.match(out, /\x1b\[1m/);
});

test("bold: an intermediate 102 ping is NOT bold (only the terminal answer pops)", async () => {
    delete process.env.NO_COLOR; // any non-empty value disables (no-color.org, plurnk#29)
    const colored = await freshRender("bold=102");
    process.env.NO_COLOR = "1";
    const out = colored.renderLogEntry(entry({ ...sendEntry, signal: 102, status_rx: 102, tx: { body: { raw: "working…", json: null } } }));
    assert.doesNotMatch(out, /\x1b\[1m/);   // plain
});

test("bold: inner RESET re-arms bold so a markdown span can't cut it mid-line", async () => {
    delete process.env.NO_COLOR; // any non-empty value disables (no-color.org, plurnk#29)
    const colored = await freshRender("bold=rearm");
    process.env.NO_COLOR = "1";
    // The markdown **bold** span emits its own RESET; the line-bold must resume
    // immediately after, not die at the first reset.
    const out = colored.renderLogEntry(entry({ ...sendEntry, tx: { body: { raw: "**strong** then more", json: null } } }));
    assert.match(out, /\x1b\[0m\x1b\[1m/);
});

test("bold: a client-origin broadcast is NOT bold (only the MODEL's answer)", async () => {
    delete process.env.NO_COLOR; // any non-empty value disables (no-color.org, plurnk#29)
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

test("renderLogEntry: BARE has an isolated-inference glyph", () => {
    const line = renderLogEntry(entry({ op: "BARE" }));
    assert.ok(line.includes(OP_GLYPHS.BARE));
    assert.doesNotMatch(line, /\?/);
});

test("renderLogEntry: unknown op → '?' glyph", () => {
    const line = renderLogEntry(entry({ op: "WHATEVER" }));
    assert.match(line, /\?/);
});

// ─── renderSummary ────────────────────────────────────────────────────

const usage = (inputTokens: number, outputTokens: number, costUsd = "0") => ({
    accounting: {
        requests: [{ provider: "provider:test", model: "test", outcome: "response" }],
        usage: { inputTokens, outputTokens },
        costUsd,
    },
    curationWeight: null,
    curationBudget: null,
    contextTokens: null,
    contextCapacity: null,
    meta: {},
});
const terminalResult = (status: number, type?: string) => status >= 400 ? {
    status,
    problem: {
        type: type ?? `https://problems.plurnk.xyz/test/status-${status}`,
        title: `Status ${status}`,
        status,
        detail: `Terminal status ${status}`,
    },
} : { status };

test("renderSummary: success → 'done'", () => {
    const s = renderSummary(1, 500, terminalResult(200), false, usage(10, 5));
    assert.match(s, /done/);
    assert.match(s, /1 turn /);
});

test("renderSummary: maxTurns flag wins over finalStatus", () => {
    const s = renderSummary(50, 18200, terminalResult(200), true, usage(100, 50));
    assert.match(s, /maxTurns/);
    assert.doesNotMatch(s, /done/);
});

test("renderSummary: differentiated terminal codes get distinct labels (#70)", () => {
    assert.match(renderSummary(3, 1000, terminalResult(499), false, usage(10, 5)), /cancelled/);
    assert.match(renderSummary(3, 1000, terminalResult(413), false, usage(10, 5)), /budget overflow/);
    assert.match(renderSummary(3, 1000, terminalResult(429), false, usage(10, 5)), /turn ceiling/);
    assert.match(renderSummary(3, 1000, terminalResult(500, "https://problems.plurnk.xyz/engine/rails/strike-threshold"), false, usage(10, 5)), /strike-out/);
    assert.match(renderSummary(3, 1000, terminalResult(508), false, usage(10, 5)), /loop detected/);
});

test("renderSummary: status 500 is a strike-out only for the rail Problem (#7)", () => {
    const invalidEmission = {
        status: 500,
        problem: {
            type: "https://problems.plurnk.xyz/engine/generation/invalid-emission-exhausted",
            title: "Invalid emission exhausted",
            status: 500,
            detail: "No valid PLAN...SEND turn was received after 3 emission attempts.",
        },
    };
    const line = renderSummary(0, 83, invalidEmission, false, usage(10, 5));
    assert.match(line, /invalid emission/);
    assert.doesNotMatch(line, /strike-out/);
});

test("renderSummary: an unmapped non-200 still falls back to 'final <N>'", () => {
    assert.match(renderSummary(3, 1000, terminalResult(418), false, usage(10, 5)), /final 418/);
});

test("renderSummary: real usage renders conventional input/output + exact loop cost", () => {
    const s = renderSummary(2, 500, terminalResult(200), false, usage(1200, 345, "0.00042"));
    assert.match(s, /↑1200 ↓345/);
    assert.match(s, /loop \$0\.00042/);
});

// ─── dimensionally independent terminal gauges ───────────────────────

test("[§cli-summary-line-per-looprun] curationGauge: weight + budget → 'cur N%/Mk'", () => {
    assert.equal(curationGauge(12000, 48000), " · cur 25%/48k");
});

test("[§cli-summary-line-per-looprun] contextGauge: occupancy + window → 'ctx N%/Mk'", () => {
    assert.equal(contextGauge(7360, 49152), " · ctx 15%/49k");
});

test("contextGauge: sub-1000 window stays bare (no k)", () => {
    assert.equal(contextGauge(120, 512), " · ctx 23%/512");
});

test("contextGauge: null/absent contextCapacity → omitted (never guessed)", () => {
    assert.equal(contextGauge(7360, null), "");
    assert.equal(contextGauge(7360, undefined), "");
    assert.equal(contextGauge(7360, 0), "");
});

test("contextGauge: absent contextTokens → omitted", () => {
    assert.equal(contextGauge(undefined, 49152), "");
});

test("renderSummary: curation and context gauges remain distinct", () => {
    const s = renderSummary(1, 500, terminalResult(200), false, {
        ...usage(7360, 27),
        curationWeight: 12000,
        curationBudget: 48000,
        contextTokens: 7360,
        contextCapacity: 49152,
    });
    assert.match(s, /cur 25%\/48k/);
    assert.match(s, /ctx 15%\/49k/);
});

test("renderSummary: no contextCapacity → no context gauge even with contextTokens", () => {
    const s = renderSummary(1, 500, terminalResult(200), false, { ...usage(7360, 27), contextTokens: 7360 });
    assert.doesNotMatch(s, /ctx /);
});

test("renderSummary: usage without cost omits the cost segment", () => {
    const s = renderSummary(1, 100, terminalResult(200), false, usage(10, 5));
    assert.match(s, /↑10 ↓5/);
    assert.doesNotMatch(s, /\$/);
});

test("renderSummary: no usage (non-model op) omits the token part", () => {
    const s = renderSummary(0, 50, terminalResult(201), false);
    assert.doesNotMatch(s, /↑|tokens/);
});

test("renderSummary renders the loop's exact USD decimal without unit conversion", () => {
    const summary = renderSummary(1, 100, terminalResult(200), false, usage(10, 5, "0.0042"));
    assert.match(summary, /loop \$0\.0042/);
});

test("renderSummary: wall time in seconds when ≥1000ms", () => {
    assert.match(renderSummary(1, 1234, terminalResult(200), false, usage(1, 1)), /1\.23s/);
});

test("renderSummary: wall time in ms when <1000", () => {
    assert.match(renderSummary(1, 250, terminalResult(200), false, usage(1, 1)), /250ms/);
});

test("renderSummary: pluralizes turns", () => {
    assert.match(renderSummary(2, 500, terminalResult(200), false, usage(1, 1)), /2 turns/);
    assert.match(renderSummary(1, 500, terminalResult(200), false, usage(1, 1)), /1 turn /);
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

// ─── Coordinate-free human waterfall (plurnk#21) ──────────────────────

test("[§cli-log-entry-line-format] the human waterfall carries no log coordinates", () => {
    const out = renderLogEntry(entry({
        op: "READ", scheme: "worker", pathname: "/x", status_rx: 200,
        loop_seq: 1, turn_seq: 2, sequence: 3, rx: {}, tx: {},
    }));
    assert.doesNotMatch(out, /01\/02\/03/, "the 01/02/03 gutter is gone from human rows");
    assert.doesNotMatch(out, /(?:^|\s)200(?:\s|$)/, "a routine non-SEND success shows no status code");
    assert.match(out, /worker:\/\/\/x/);
});

test("coordLabel survives for machine-adjacent surfaces and grows past two digits", () => {
    assert.match(coordLabel(7, 104, 12), /07\/104\/12 /);
});

test("active-prompt progress gauge is four visible cells and appears only while active", () => {
    assert.equal(progressLabel(42), " 42% ");
    assert.equal(progressLabel(100), "100% ");
});

test("entry materialization narration is recognized from hydrated or JSON attrs", () => {
    const base = { origin: "plurnk", op: "EDIT" } as Partial<LogEntryWire>;
    assert.equal(isEntryMaterialization(entry({ ...base, attrs: { kind: "entry_materialized" } })), true);
    assert.equal(isEntryMaterialization(entry({ ...base, attrs: JSON.stringify({ kind: "entry_materialized" }) })), true);
    assert.equal(isEntryMaterialization(entry({ ...base, attrs: "{bad json" })), false);
    assert.equal(isEntryMaterialization(entry({ ...base, origin: "model", attrs: { kind: "entry_materialized" } })), false);
});

test("coordinates never leak into rows, from ordinals or DB ids", () => {
    const out = renderLogEntry(entry({
        op: "READ", scheme: "worker", pathname: "/x", status_rx: 200,
        loop_seq: 1, turn_seq: 2, sequence: 3, rx: {}, tx: {},
        // @ts-expect-error — DB ids are not part of LogEntryWire.
        loop_id: 38, turn_id: 412,
    }));
    assert.doesNotMatch(out, /01\/02\/03/);
    assert.doesNotMatch(out, /38\/412/);
});

test("broadcasts carry no coordinate but keep their SEND code", () => {
    const out = renderLogEntry(entry({
        op: "SEND", scheme: null, pathname: null, signal: 200, status_rx: 200,
        loop_seq: 1, turn_seq: 4, sequence: 1, tx: { body: { raw: "Paris", json: null } },
    }));
    assert.doesNotMatch(out, /01\/04\/01/);
    assert.match(out, /200/, "SEND codes stay — the conversation's protocol truth");
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

test("renderLogEntry: only errors carry a code on non-SEND rows (color branches render without throwing)", () => {
    for (const status of [404, 500]) {
        const out = renderLogEntry(entry({ op: "READ", scheme: "worker", pathname: "/x", status_rx: status, rx: {} }));
        assert.match(out, new RegExp(String(status)), `error ${status} keeps its code`);
    }
    for (const status of [102, 202, 301]) {
        const out = renderLogEntry(entry({ op: "READ", scheme: "worker", pathname: "/x", status_rx: status, rx: {} }));
        assert.doesNotMatch(out, new RegExp(`(?:^|\\s)${status}(?:\\s|$)`), `routine ${status} shows no code`);
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
    assert.match(extractSendBody({ body: { raw: "- one\n- two", json: null } }, true), /\* one/);
});

test("extractSendBody prettify: plain text (no markdown markers) passes through", () => {
    assert.equal(extractSendBody({ body: { raw: "just words", json: null } }, true), "just words");
});

test("extractSendBody prettify: conventional inline right arrow renders as its terminal glyph", () => {
    const raw = "loading $\\rightarrow$ running";
    assert.equal(extractSendBody({ body: { raw, json: null } }, true), "loading → running");
    assert.equal(extractSendBody({ body: { raw, json: null } }, false), raw, "CLI output remains verbatim");
});

// ─── renderSummary: usage token part ─────────────────────────────────

test("renderSummary: usage renders input/output and exact cost", () => {
    const out = renderSummary(3, 850, terminalResult(200), false, usage(100, 50, "0.5"));
    assert.match(out, /↑100 ↓50/);
    assert.match(out, /\$0\.5/);
});

test("renderSummary: zero cost omits the $ part", () => {
    const out = renderSummary(1, 100, terminalResult(200), false, usage(10, 5));
    assert.match(out, /↑10 ↓5/);
    assert.doesNotMatch(out, /\$/);
});

test("renderSummary: unavailable money is omitted, never a gross $unknown", () => {
    const out = renderSummary(1, 100, terminalResult(200), false, {
        accounting: {
            requests: [{ provider: "provider:test", model: "test", outcome: "response", cost: { kind: "unknown" } }],
            usage: { inputTokens: 10, outputTokens: 5 },
            costUsd: null,
        },
        curationWeight: null,
        curationBudget: null,
        contextTokens: null,
        contextCapacity: null,
        meta: {},
    });
    assert.match(out, /↑10 ↓5/, "physical evidence still renders");
    assert.doesNotMatch(out, /\$/, "no cost segment at all when the price is not available");
});

test("[§cli-summary-line-per-looprun] contextGauge renders the daemon's request-matched physical capacity", () => {
    assert.equal(contextGauge(18000, 36000), " · ctx 50%/36k");
    assert.equal(contextGauge(18000, 128000), " · ctx 14%/128k");
    assert.equal(contextGauge(18000, null), "", "a loop the daemon can't window omits the gauge, never lies with a stale one");
});

test("[§cli-summary-line-per-looprun] renderSummary takes both gauge denominators from the terminal envelope", () => {
    const loopUsage = {
        ...usage(1, 1),
        curationWeight: 18000,
        curationBudget: 36000,
        contextTokens: 12000,
        contextCapacity: 48000,
    };
    const line = renderSummary(2, 1000, terminalResult(200), false, loopUsage);
    assert.match(line, /cur 50%\/36k/);
    assert.match(line, /ctx 25%\/48k/, "the window came from the loop's usage, not a client-side alias lookup");
    // A loop whose window the daemon can't report → no gauge (never a stale number).
    assert.doesNotMatch(renderSummary(2, 1000, terminalResult(200), false, { ...loopUsage, contextCapacity: null }), /ctx /);
});
