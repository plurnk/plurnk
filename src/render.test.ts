// Unit tests for src/render.ts. Run with NO_COLOR=1 to keep assertions
// free of ANSI escape codes — the color rendering paths are simple
// enough that visual inspection during smoke covers them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PLURNK_OPS } from "@plurnk/plurnk-contracts";

// NO_COLOR keeps every render plain; colour is read per call.
process.env.NO_COLOR = "1";

const {
    extractSendBody,
    renderPendingRow,
    renderReasoning,
    renderSummary,
    curationGauge,
    contextGauge,
    progressLabel,
    coordLabel,
    isEntryMaterialization,
    isArrivalEntry,
    isOwnArrival,
    entryTarget,
    receiptCount,
    outcomeTitle,
    FanoutCollapse,
} = await import("./render.ts");
const { renderLogEntry, renderSendBody } = await import("./render-message.ts");
import type { LogEntryWire } from "./render.ts";

// Minimal entry factory — fills in plausible defaults; callers override what matters.
const entry = (overrides: Partial<LogEntryWire> = {}): LogEntryWire => ({
    id: 1,
    op: "READ",
    origin: "model",
    signal: null,
    scheme: null,
    pathname: null,
    hostname: null,
    fragment: null,
    lineMarker: null,
    status_rx: 200,
    tx: null,
    rx: overrides.op === "SEND" && overrides.scheme == null ? { answers: [] } : null,
    tags: [],
    loop_seq: 1,
    turn_seq: 1,
    sequence: 1,
    ...overrides,
});

// ─── sendSubGlyph ─────────────────────────────────────────────────────

// ─── extractSendBody ──────────────────────────────────────────────────

test("extractSendBody: null tx → empty", () => {
    assert.equal(renderSendBody(null), "");
    assert.equal(extractSendBody(undefined), "");
});

test("extractSendBody: null body → empty", () => {
    assert.equal(renderSendBody({ body: null }), "");
});

test("extractSendBody prettify=false: raw verbatim, json ignored", () => {
    const tx = { body: { raw: '{"k":"v"}', json: { k: "v" } } };
    assert.equal(extractSendBody(tx), '{"k":"v"}');
});

test("extractSendBody prettify=false: non-string raw → empty", () => {
    const tx = { body: { raw: 123, json: 123 } };
    assert.equal(extractSendBody(tx), "");
});

test("extractSendBody prettify=true: json wins, pretty-printed", () => {
    const tx = { body: { raw: '{"k":"v"}', json: { k: "v" } } };
    assert.equal(renderSendBody(tx), '{\n  "k": "v"\n}');
});

test("extractSendBody prettify=true: markdown body → ANSI transform applied", () => {
    // With NO_COLOR=1, ANSI codes collapse to empty. The mature renderer owns
    // the terminal list marker and indentation.
    const tx = { body: { raw: "- item one\n- item two", json: null } };
    const out = renderSendBody(tx);
    assert.match(out, /\* item one/);
});

test("extractSendBody prettify=true: plain text → raw verbatim", () => {
    const tx = { body: { raw: "Hello, world.", json: null } };
    assert.equal(renderSendBody(tx), "Hello, world.");
});

test("model-authored text never reaches the terminal with its own control sequences (plurnk#35)", () => {
    const body = renderSendBody({ body: { raw: "safe \x1b]52;c;aGVsbG8=\x07 text", json: null } });
    assert.doesNotMatch(body, /\x1b\]52/, "an OSC 52 clipboard write inside a SEND body is stripped");
    assert.match(body, /safe/); assert.match(body, /text/);
    const send = renderLogEntry(entry({ op: "SEND", signal: 200, tx: { body: { raw: "done \x1b[31mRED\x1b[0m\rgone", json: null } } }));
    assert.doesNotMatch(send, /\x1b\[31m/, "a model SGR sequence in a SEND body is stripped");
    assert.doesNotMatch(send, /\r/, "a carriage-return overwrite is stripped");
    const reasoning = renderReasoning("think \x1b]8;;https://evil.test\x07here\x1b]8;;\x07");
    assert.doesNotMatch(reasoning, /\x1b\]8/, "an OSC 8 link in reasoning is stripped");
    assert.match(reasoning, /think here/, "the words survive");
});

test("renderReasoning: distinct, compact block with no coordinate or status code", () => {
    assert.equal(renderReasoning("first line\nsecond line"), "💭 first line\n   second line");
});

// ─── renderLogEntry: target rendering ────────────────────────────────

// ─── renderLogEntry: broadcast SEND ──────────────────────────────────

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

// ─── message arrivals ────────────────────────────────────────────────

test("[§cli-what-is-not-rendered] an arrival is the daemon's inbound SEND row; only the viewer's own is withheld", () => {
    const own = entry({ op: "SEND", origin: "_plurnk", attrs: { kind: "message" }, source: "agui://anonymous/threads/my%20thread/messages/m-1", tx: { body: { raw: "hi" } } });
    const peer = entry({ op: "SEND", origin: "_plurnk", attrs: { kind: "message" }, source: "worker://reviewer", tx: { body: { raw: "done" } } });
    const other = entry({ op: "SEND", origin: "_plurnk", attrs: { kind: "message" }, source: "agui://anonymous/threads/elsewhere/messages/m-2", tx: { body: { raw: "hey" } } });
    assert.equal(isArrivalEntry(own), true);
    assert.equal(isArrivalEntry(peer), true);
    assert.equal(isArrivalEntry(entry({ op: "SEND", origin: "model", tx: { body: { raw: "reply" } } })), false, "the model's own SEND is not an arrival");
    assert.equal(isArrivalEntry(entry({ op: "READ", origin: "_plurnk" })), false, "a harness READ is not an arrival");
    assert.equal(isArrivalEntry(entry({ op: "SEND", origin: "_plurnk", source: "worker://counter", attrs: { kind: "loop_termination" } })), false, "a child's conclusion narration is not an arrival");
    assert.equal(isOwnArrival(own, "my thread"), true, "the thread id is URI-encoded in the source");
    assert.equal(isOwnArrival(other, "my thread"), false, "another thread's message renders");
    assert.equal(isOwnArrival(peer, "my thread"), false, "a peer worker's message renders");
    const rendered = renderLogEntry(peer, 80);
    assert.match(rendered, /SEND/);
    assert.match(rendered, /\(worker:\/\/reviewer\)/, "the sender sits where a target would");
    assert.match(rendered, /done/, "the body follows");
});

test("[§cli-log-entry-line-format] entryTarget preserves literal resource addresses without caller-relative synthesis", () => {
    assert.equal(entryTarget(entry({ scheme: "worker", hostname: null, pathname: "/plan.md" })), "worker:///plan.md", "empty authority = commons, verbatim");
    assert.equal(entryTarget(entry({ scheme: "worker", hostname: "extract-host", pathname: "/plan.md" })), "worker://extract-host/plan.md", "named worker verbatim");
    assert.equal(entryTarget(entry({ scheme: "worker", hostname: "plurnk", pathname: "/docs/x.md" })), "worker://plurnk/docs/x.md", "plurnk = kernel, bare");
    assert.equal(entryTarget(entry({ scheme: "reasoning", hostname: "extract-host", pathname: "/1/2/1" })), "reasoning://extract-host/1/2/1");
});

// ─── Conversation reply emphasis (colour enabled) ─────────────────────
// A delivered reply is plain: its Markdown carries the only emphasis, and the
// human's line is what sets the two voices apart ({§cli-broadcast-send-rendering}).
const colored = <T>(render: () => T): T => {
    delete process.env.NO_COLOR; // any non-empty value disables (no-color.org, plurnk#29)
    try { return render(); } finally { process.env.NO_COLOR = "1"; }
};

const sendEntry = { op: "SEND", scheme: null, pathname: null, signal: 200, status_rx: 200, tx: { body: { raw: "Paris.", json: null } } };

test("{§cli-broadcast-send-rendering} the model's delivered reply is plain: no bold of its own, no background band", () => {
    const out = colored(() => renderLogEntry(entry(sendEntry)));
    assert.doesNotMatch(out, /\x1b\[1m/, "prose carries no bold; only Markdown emphasis may");
    assert.doesNotMatch(out, /48;[25]/);    // no background band of any kind
    assert.doesNotMatch(out, /\x1b\[K/);    // no edge-paint
    // A styled lead line (the aside's dim span) does not spill into the body.
    const aside = colored(() => renderLogEntry(entry({ ...sendEntry, tx: { aside: "ready", body: { raw: "then more", json: null } } })));
    assert.match(aside, /\x1b\[0m\nthen more$/u);
});

test("{§cli-broadcast-send-rendering} a failed SEND is not presented as a delivered answer", () => {
    const out = colored(() => renderLogEntry(entry({ ...sendEntry, op: "SEND", signal: null, status_rx: 499 })));
    assert.match(out, /\x1b\[31m/u, "the Problem title stands in red where the keyword was");
    assert.doesNotMatch(out, /\x1b\[1m/u, "the undelivered body is as plain as a delivered one");
});

test("{§cli-broadcast-send-rendering} a client-origin broadcast is the same plain block", () => {
    const out = colored(() => renderLogEntry(entry({
        op: "SEND", origin: "client", scheme: null, pathname: null,
        signal: 200, status_rx: 200, tx: { body: { raw: "hi", json: null } },
    })));
    assert.doesNotMatch(out, /\x1b\[1m/u);
});

test("{§cli-broadcast-send-rendering} NO_COLOR build emits no bold (or background) codes", () => {
    const out = renderLogEntry(entry({
        op: "SEND", scheme: null, pathname: null, signal: 200, status_rx: 200,
        tx: { body: { raw: "Paris.", json: null } },
    }));
    assert.doesNotMatch(out, /\x1b\[1m/);  // no bold
    assert.doesNotMatch(out, /48;[25]/);   // no background band
    assert.doesNotMatch(out, /\x1b\[K/);
});

// ─── the literal row grammar ({§cli-log-entry-line-format}) ─────────────────

const read = (overrides: Partial<LogEntryWire> = {}): LogEntryWire => entry({
    op: "READ", scheme: null, pathname: "AGENTS.md", tx: { op: "READ", target: { kind: "local", raw: "AGENTS.md" }, matcher: null, aside: null },
    rx: { status: 200, content: "…", range: { unit: "line", total: 256, requested: [17, -1], returned: [17, 256] } },
    lineMarker: { marks: [17, -1] },
    ...overrides,
});

test("[§cli-log-entry-line-format] a READ row is the authored heading with the lines it returned", () => {
    assert.equal(renderLogEntry(read()), "READ (AGENTS.md) <17,-1> {240}");
});

test("[§cli-log-entry-line-format] a pattern READ keeps the pattern literal and counts its matched lines", () => {
    const line = renderLogEntry(read({
        pathname: "plurnk-core/SPEC.md",
        tx: { op: "READ", target: { kind: "local", raw: "plurnk-core/SPEC.md" }, matcher: { dialect: "regex", raw: "/^#{1,2} /", pattern: "^#{1,2} ", flags: "" }, aside: null },
        rx: { status: 200, content: "…", lineOrdinals: [1, 5, 35], range: { unit: "line", total: 5244, requested: [1, 35], returned: [1, 35] } },
        lineMarker: null,
    }));
    assert.equal(line, "READ (plurnk-core/SPEC.md) /^#{1,2} / {3}", "the pattern is not a Markdown heading and the count is the matched lines, not the span");
});

test("[§cli-log-entry-line-format] a FIND counts the items it returned and carries its aside last", () => {
    const line = renderLogEntry(entry({
        op: "FIND", pathname: "plurnk-parser/**",
        tx: { op: "FIND", target: { kind: "local", raw: "plurnk-parser/**" }, matcher: null, aside: "what the new package contains" },
        rx: { status: 200, results: [], range: { unit: "resource", total: 28, requested: [1, 16], returned: [1, 16] }, matchingPathCount: 28, matchLocationCount: 0 },
    }));
    assert.equal(line, "FIND (plurnk-parser/**) {16} what the new package contains", "a glob is not emphasis; the aside is a styled field after the count");
});

test("[§cli-log-entry-line-format] a 204 FIND counts zero and is not a failure", () => {
    const line = renderLogEntry(entry({
        op: "FIND", pathname: "src/**/*.ts", status_rx: 204,
        tx: { op: "FIND", target: { kind: "local", raw: "src/**/*.ts" }, matcher: null, aside: null },
        rx: { status: 204, content: null, results: [], range: { unit: "resource", total: 0, requested: [1, 16] } },
    }));
    assert.equal(line, "FIND (src/**/*.ts) {0}");
});

test("[§cli-log-entry-line-format] a failure keeps op, target, scope, pattern, and aside, then the Problem title at the right", () => {
    assert.equal(renderLogEntry(read({
        pathname: "plurnk-parser/README.md", status_rx: 404,
        tx: { op: "READ", target: { kind: "local", raw: "plurnk-parser/README.md" }, matcher: null, aside: null },
        rx: { status: 404, content: null, problem: { type: "https://problems.plurnk.xyz/scheme/file/entry-not-member", title: "Entry not member", status: 404, detail: "'plurnk-parser/README.md' exists on disk but is not a member of this workspace." } },
        lineMarker: { marks: [1, -1] },
    })), "READ (plurnk-parser/README.md) <1,-1> — Entry not member");
    assert.equal(renderLogEntry(read({
        pathname: "belfry.md", status_rx: 404, lineMarker: null,
        tx: { op: "READ", target: { kind: "local", raw: "belfry.md" }, matcher: { dialect: "regex", raw: "/\\bbats?\\b/i", pattern: "\\bbats?\\b", flags: "i" }, aside: "only the lines matching \"bat\" or \"bats\"" },
        rx: { status: 404, content: null, problem: { type: "https://problems.plurnk.xyz/scheme/file/entry-not-found", title: "Entry not found", status: 404, detail: "No entry exists at belfry.md." } },
    })), "READ (belfry.md) /\\bbats?\\b/i only the lines matching \"bat\" or \"bats\" — Entry not found", "one line; the title is to the right of the aside");
});

test("[§cli-log-entry-line-format] a glob READ that matched nothing carries the daemon's detail, not a count", () => {
    assert.equal(renderLogEntry(read({
        pathname: "pets_*.md", status_rx: 204, lineMarker: null,
        tx: { op: "READ", target: { kind: "local", raw: "pets_*.md" }, matcher: null, aside: null },
        rx: { status: 204, detail: "No path matched pets_*.md." },
    })), "READ (pets_*.md) — No path matched pets_*.md.");
});

test("[§cli-log-entry-line-format] an execution row is named by its runtime and carries no body", () => {
    const line = renderLogEntry(entry({
        op: "sh", scheme: null, pathname: null,
        tx: { runtime: "sh", target: null, aside: "Run the focused tests", body: "npm test -- --grep focused" },
        rx: { status: 200, outcome: "started" }, attrs: { runtime: "sh", stream: "sh:///1a2b3c4d" },
    }));
    assert.equal(line, "sh Run the focused tests");
    assert.doesNotMatch(line, /npm test/, "invocation bodies never reach the waterfall");
});

test("[§cli-log-entry-line-format] a client `!` row is named by its op, the daemon's default runtime", () => {
    const started = entry({
        op: "sh", origin: "client", scheme: null, pathname: null, status_rx: 200,
        tx: { runtime: "sh", target: null, aside: null, body: "printf x" },
        rx: { status: 200, outcome: "started" }, attrs: { runtime: "sh", stream: "sh:///1a2b3c4d" },
    });
    assert.equal(renderLogEntry(started), "sh", "the human's `!` command runs in the default shell; its row says so");
    const refused = entry({
        op: "cobol", scheme: null, pathname: null, status_rx: 404,
        tx: { runtime: "cobol", target: null, aside: null, body: "x" },
        rx: { status: 404, problem: { type: "x", title: "Unknown executor", status: 404 } },
    });
    assert.equal(renderLogEntry(refused), "cobol — Unknown executor", "a refused execution is an ordinary failed row under its runtime");
});

test("[§cli-log-entry-line-format] COPY and MOVE keep each scope beside its own path", () => {
    const line = renderLogEntry(entry({
        op: "COPY", pathname: "notes.md",
        tx: { op: "COPY", aside: null, source: { target: { kind: "local", raw: "notes.md" }, lineMarker: { marks: [1, 3] }, matcher: null, metadata: null }, destination: { target: { kind: "url", raw: "worker:///archive/notes.md" }, lineMarker: { marks: [-1] }, matcher: null, metadata: null } },
        rx: { status: 201 },
    }));
    assert.equal(line, "COPY (notes.md) <1,3> (worker:///archive/notes.md) <-1>");
});

test("[§cli-log-entry-line-format] the row is literal text: no Markdown, no glyphs, the op name at column zero", () => {
    const line = renderLogEntry(entry({ op: "FIND", pathname: "*.md", tx: { op: "FIND", target: { kind: "local", raw: "*.md" }, matcher: null, aside: null }, rx: { status: 200, results: [], range: { unit: "resource", total: 7, requested: [1, 16], returned: [1, 7] } } }));
    assert.equal(line, "FIND (*.md) {7}");
    assert.match(renderLogEntry(entry({ op: "WHATEVER", pathname: "/x", tx: { op: "WHATEVER", target: { raw: "/x" } } })), /^WHATEVER \(\/x\)/, "an unknown op still renders as itself");
    assert.match(renderLogEntry(entry({ op: "BARE", tx: { op: "BARE", target: null, aside: "ask the model" } })), /^BARE ask the model$/);
});

test("receiptCount and outcomeTitle read only the receipt", () => {
    assert.equal(receiptCount(read()), 240);
    assert.equal(receiptCount(read({ rx: { status: 200, lineOrdinals: [2, 4] } })), 2);
    assert.equal(receiptCount(read({ op: "EDIT", rx: { status: 201 } })), null);
    assert.equal(receiptCount(read({ rx: null })), null);
    assert.equal(outcomeTitle(read()), null);
    assert.equal(outcomeTitle(read({ status_rx: 500, rx: { status: 500, detail: "The scheme threw." } })), "The scheme threw.");
    assert.equal(outcomeTitle(read({ status_rx: 500, rx: null })), "500");
});

test("[§cli-log-entry-line-format] a fanned-out READ collapses to its authored glob once its last row is in", () => {
    const collapse = new FanoutCollapse();
    const row = (index: number, over: Partial<LogEntryWire> = {}) => read({
        id: 100 + index, sequence: 5 + index, pathname: `pets_${index}.md`, lineMarker: null,
        tx: { op: "READ", target: { kind: "local", raw: `pets_${index}.md` }, matcher: { dialect: "regex", raw: "/dogs/i", pattern: "dogs", flags: "i" }, aside: "every dog" },
        rx: { status: 200, content: "…", lineOrdinals: [2], range: { unit: "line", total: 9, requested: [1, -1], returned: [1, 9] } },
        attrs: { fanout: { target: "pets_*.md", matched: 3, index, count: 3 } },
        ...over,
    });
    assert.deepEqual(collapse.admit(row(0)), { kind: "suppressed" });
    assert.deepEqual(collapse.admit(row(1)), { kind: "suppressed" });
    const last = collapse.admit(row(2));
    assert.equal(last.kind, "collapsed");
    if (last.kind !== "collapsed") return;
    assert.equal(renderLogEntry(row(2), 80, last.override), "READ (pets_*.md) /dogs/i {3} every dog", "one line for the authored statement, counting the paths it read");
    assert.deepEqual(collapse.admit(read()), { kind: "row" }, "an ordinary row is untouched");
    collapse.admit(row(0, { status_rx: 404, rx: { status: 404, problem: { type: "x", title: "Entry not member", status: 404 } } }));
    collapse.admit(row(1));
    const failed = collapse.admit(row(2));
    if (failed.kind !== "collapsed") { assert.fail("expected the collapsed row"); return; }
    assert.equal(renderLogEntry(row(2), 80, failed.override), "READ (pets_*.md) /dogs/i {3} every dog — Entry not member", "a failed path names the collapsed row");
});

// ─── SEND blocks ({§cli-broadcast-send-rendering}) ─────

test("[§cli-broadcast-send-rendering] a delivered message is its body under a blank lead line; a failed one leads with its outcome", () => {
    assert.equal(renderLogEntry(entry({ op: "SEND", scheme: null, pathname: null, tx: { op: "SEND", aside: null, body: { raw: "Paris.", json: null } } })), "\nParis.", "no keyword: a blank line, then the body at column zero");
    const block = renderLogEntry(entry({ op: "SEND", scheme: null, pathname: null, tx: { op: "SEND", aside: "the answer", body: { raw: "line one\nline two", json: null } } }));
    assert.deepEqual(block.split("\n"), ["the answer", "line one", "line two"], "the aside takes the lead line; body lines stay at column zero");
    assert.equal(renderLogEntry(entry({ op: "SEND", scheme: null, pathname: null, status_rx: 400, tx: { op: "SEND", aside: null, body: { raw: "Undelivered.", json: null } }, rx: { status: 400, problem: { type: "x", title: "Recipient unknown", status: 400 } } })), "Recipient unknown\nUndelivered.", "a failed message leads with its Problem title");
    assert.equal(renderLogEntry(entry({ op: "SEND", scheme: null, pathname: null, tx: { op: "SEND", aside: null, body: null } })), "", "an empty message is the blank lead line alone");
});

test("[§cli-log-entry-line-format] a directed SEND is an operation row, never a message block", () => {
    assert.equal(renderLogEntry(entry({ op: "SEND", scheme: "worker", pathname: "/gone", status_rx: 410, tx: { op: "SEND", target: { kind: "url", raw: "worker:///gone" }, aside: null, body: { raw: "hi", json: null } }, rx: { status: 410, problem: { type: "x", title: "Worker gone", status: 410 } } })), "SEND (worker:///gone) — Worker gone");
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
    assert.match(s, /↓1k ↑345/);
    assert.match(s, /loop \$0\.0004$/, "spend to the hundredth of a cent");
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
    assert.match(s, /↓10 ↑5/);
    assert.doesNotMatch(s, /\$/);
});

test("renderSummary: no usage (non-model op) omits the token part", () => {
    const s = renderSummary(0, 50, terminalResult(201), false);
    assert.doesNotMatch(s, /↓|↑|tokens/);
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

test("broadcast: a multi-line body follows the blank lead line at column zero", () => {
    const out = renderLogEntry(entry({
        op: "SEND", scheme: null, pathname: null, signal: 200, status_rx: 200,
        tx: { body: { raw: "line one\nline two", json: null } },
    }));
    assert.deepEqual(out.split("\n"), ["", "line one", "line two"]);
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

test("active-prompt progress is a bounded three-cell pre-completion percentage", () => {
    assert.equal(progressLabel(7), " 7%");
    assert.equal(progressLabel(42), "42%");
    assert.equal(progressLabel(99), "99%");
    assert.equal(progressLabel(107.9), "99%");
});

test("entry materialization narration is recognized from hydrated or JSON attrs", () => {
    const base = { origin: "_plurnk", op: "EDIT" } as Partial<LogEntryWire>;
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

// ─── buildExtra: per-op branch coverage ──────────────────────────────

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
    const out = renderSendBody({ body: { raw: "# Title", json: null } });
    assert.match(out, /Title/);
    assert.doesNotMatch(out, /# Title/);
});

test("extractSendBody prettify: bold, inline code, and bullets transform", () => {
    assert.match(renderSendBody({ body: { raw: "**strong**", json: null } }), /strong/);
    assert.match(renderSendBody({ body: { raw: "`code`", json: null } }), /code/);
    assert.match(renderSendBody({ body: { raw: "- one\n- two", json: null } }), /\* one/);
});

test("extractSendBody prettify: plain text (no markdown markers) passes through", () => {
    assert.equal(renderSendBody({ body: { raw: "just words", json: null } }), "just words");
});

test("extractSendBody prettify: conventional inline right arrow renders as its terminal glyph", () => {
    const raw = "loading $\\rightarrow$ running";
    assert.equal(renderSendBody({ body: { raw, json: null } }), "loading → running");
    assert.equal(extractSendBody({ body: { raw, json: null } }), raw, "CLI output remains verbatim");
});

// ─── renderSummary: usage token part ─────────────────────────────────

test("renderSummary: usage renders input/output and exact cost", () => {
    const out = renderSummary(3, 850, terminalResult(200), false, usage(100, 50, "0.5"));
    assert.match(out, /↓100 ↑50/);
    assert.match(out, /\$0\.5/);
});

test("renderSummary: zero cost omits the $ part", () => {
    const out = renderSummary(1, 100, terminalResult(200), false, usage(10, 5));
    assert.match(out, /↓10 ↑5/);
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
    assert.match(out, /↓10 ↑5/, "physical evidence still renders");
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

test("[§cli-what-is-not-rendered] a pending execution's grey row is the plain row with no outcome", () => {
    const row = renderPendingRow(entry({ op: "sh", scheme: null, pathname: null, tx: { runtime: "sh", target: null, aside: "Run the suite", body: "npm test" }, rx: { status: 200, outcome: "started" }, attrs: { runtime: "sh", stream: "sh:///1a2b3c4d" } }));
    assert.equal(row, "sh Run the suite");
    assert.doesNotMatch(row, /npm test|started/);
});
