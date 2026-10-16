// Unit tests for src/render.ts. Run with NO_COLOR=1 to keep assertions
// free of ANSI escape codes — the color rendering paths are simple
// enough that visual inspection during smoke covers them.

import { renderDescendantBlock } from "./render-message.ts";
import { paint } from "./color.ts";
import { indentDescendant, markDescendant, renderOperationRow } from "./render.ts";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
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
    isEmission,
    isArrivalEntry,
    isOwnArrival,
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
    target: null,
    lineMarker: null,
    status_rx: 200,
    tx: null,
    rx: overrides.op === "SEND" && overrides.target == null ? { answers: ["agui://anonymous/threads/t/messages/m1"] } : null,
    loop_seq: 1,
    turn_seq: 1,
    sequence: 1,
    ...overrides,
});

// ─── WAIT body is model speech ────────────────────────────────────────

test("a model WAIT with a body renders as the model's message: Markdown at full paint, not a dim preview", () => {
    const body = "Pilot at **12 of 30** graded.\n\n- 9 passes\n- next read in ten minutes";
    const spoken = renderLogEntry(entry({ op: "WAIT", origin: "model", signal: 202, status_rx: 202, lineMarker: { marks: [600] }, tx: { body, aside: "park while the poll runs" }, rx: { status: 202, attrs: { waiting: 600 } } }));
    const plain = stripVTControlCharacters(spoken);
    assert.match(plain, /park while the poll runs/u, "the lead line keeps the aside");
    assert.match(plain, /12 of 30/u);
    assert.match(plain, /9 passes/u);
    assert.doesNotMatch(plain, /\*\*12 of 30\*\*/u, "the body went through the Markdown layout, not the literal preview");
    assert.equal(spoken, renderLogEntry(entry({ op: "SEND", origin: "model", signal: 200, status_rx: 200, tx: { body: { raw: body }, aside: "park while the poll runs" }, rx: { answers: ["agui://anonymous/threads/t/messages/m1"] } })).replace(/^[^\n]*\n/u, spoken.split("\n")[0] + "\n"), "the body is painted exactly as a reply's body is");
    const silent = stripVTControlCharacters(renderLogEntry(entry({ op: "WAIT", origin: "model", signal: 202, status_rx: 202, lineMarker: { marks: [600] }, tx: { body: null, aside: "park while the poll runs" }, rx: { status: 202, attrs: { waiting: 600 } } })));
    assert.match(silent, /^WAIT/u, "a bodiless WAIT is still its operation row");
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
    assert.match(out, /[-*] item one/);
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
        target: null,
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

// ─── Delivered reply emphasis (colour enabled) ────────────────────────
// A delivered reply is plain: its Markdown carries the only emphasis, and the
// human's line is what sets the two voices apart ({§cli-broadcast-send-rendering}).
const colored = <T>(render: () => T): T => {
    const saved = process.env.PLURNK_CLIENT_COLOR;
    process.env.PLURNK_CLIENT_COLOR = "always";
    try { return render(); } finally {
        if (saved === undefined) delete process.env.PLURNK_CLIENT_COLOR;
        else process.env.PLURNK_CLIENT_COLOR = saved;
    }
};

const sendEntry = { op: "SEND", target: null, signal: 200, status_rx: 200, tx: { body: { raw: "Paris.", json: null } } };

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
        op: "SEND", origin: "client", target: null,
        signal: 200, status_rx: 200, tx: { body: { raw: "hi", json: null } },
    })));
    assert.doesNotMatch(out, /\x1b\[1m/u);
});

test("{§cli-broadcast-send-rendering} NO_COLOR build emits no bold (or background) codes", () => {
    const out = renderLogEntry(entry({
        op: "SEND", target: null, signal: 200, status_rx: 200,
        tx: { body: { raw: "Paris.", json: null } },
    }));
    assert.doesNotMatch(out, /\x1b\[1m/);  // no bold
    assert.doesNotMatch(out, /48;[25]/);   // no background band
    assert.doesNotMatch(out, /\x1b\[K/);
});

// ─── the literal row grammar ({§cli-log-entry-line-format}) ─────────────────

const read = (overrides: Partial<LogEntryWire> = {}): LogEntryWire => entry({
    op: "READ", target: "AGENTS.md", tx: { op: "READ", target: { kind: "local", raw: "AGENTS.md" }, matcher: null, aside: null },
    rx: { status: 200, content: "…", range: { unit: "line", total: 256, requested: [17, -1], returned: [17, 256] } },
    lineMarker: { marks: [17, -1] },
    ...overrides,
});

test("[§cli-log-entry-line-format] a READ row is the authored heading with the lines it returned", () => {
    assert.equal(renderLogEntry(read()), "READ (AGENTS.md) <17,-1> {240}");
});

test("[§cli-log-entry-line-format] a pattern READ keeps the pattern literal and counts its matched lines", () => {
    const line = renderLogEntry(read({
        target: "plurnk-core/SPEC.md",
        tx: { op: "READ", target: { kind: "local", raw: "plurnk-core/SPEC.md" }, matcher: { dialect: "regex", raw: "/^#{1,2} /", pattern: "^#{1,2} ", flags: "" }, aside: null },
        rx: { status: 200, content: "…", lineOrdinals: [1, 5, 35], range: { unit: "line", total: 5244, requested: [1, 35], returned: [1, 35] } },
        lineMarker: null,
    }));
    assert.equal(line, "READ (plurnk-core/SPEC.md) /^#{1,2} / {3}", "the pattern is not a Markdown heading and the count is the matched lines, not the span");
});

test("[§cli-log-entry-line-format] a FIND counts the items it returned and carries its aside last", () => {
    const line = renderLogEntry(entry({
        op: "FIND", target: "plurnk-parser/**",
        tx: { op: "FIND", target: { kind: "local", raw: "plurnk-parser/**" }, matcher: null, aside: "what the new package contains" },
        rx: { status: 200, results: [], range: { unit: "resource", total: 28, requested: [1, 16], returned: [1, 16] }, matchingPathCount: 28, matchLocationCount: 0 },
    }));
    assert.equal(line, "FIND (plurnk-parser/**) {16} what the new package contains", "a glob is not emphasis; the aside is a styled field after the count");
});

test("[§cli-log-entry-line-format] a 204 FIND counts zero and is not a failure", () => {
    const line = renderLogEntry(entry({
        op: "FIND", target: "src/**/*.ts", status_rx: 204,
        tx: { op: "FIND", target: { kind: "local", raw: "src/**/*.ts" }, matcher: null, aside: null },
        rx: { status: 204, content: null, results: [], range: { unit: "resource", total: 0, requested: [1, 16] } },
    }));
    assert.equal(line, "FIND (src/**/*.ts) {0}");
});

test("[§cli-log-entry-line-format] a failure keeps op, target, scope, pattern, and aside, then the Problem title at the right", () => {
    assert.equal(renderLogEntry(read({
        target: "plurnk-parser/README.md", status_rx: 404,
        tx: { op: "READ", target: { kind: "local", raw: "plurnk-parser/README.md" }, matcher: null, aside: null },
        rx: { status: 404, content: null, problem: { type: "https://problems.plurnk.xyz/scheme/file/entry-not-member", title: "Entry not member", status: 404, detail: "'plurnk-parser/README.md' exists on disk but is not a member of this workspace." } },
        lineMarker: { marks: [1, -1] },
    })), "READ (plurnk-parser/README.md) <1,-1> — Entry not member");
    assert.equal(renderLogEntry(read({
        target: "belfry.md", status_rx: 404, lineMarker: null,
        tx: { op: "READ", target: { kind: "local", raw: "belfry.md" }, matcher: { dialect: "regex", raw: "/\\bbats?\\b/i", pattern: "\\bbats?\\b", flags: "i" }, aside: "only the lines matching \"bat\" or \"bats\"" },
        rx: { status: 404, content: null, problem: { type: "https://problems.plurnk.xyz/scheme/file/entry-not-found", title: "Entry not found", status: 404, detail: "No entry exists at belfry.md." } },
    })), "READ (belfry.md) /\\bbats?\\b/i only the lines matching \"bat\" or \"bats\" — Entry not found", "one line; the title is to the right of the aside");
});

test("[§cli-hyperlinks] a web READ row links its target to itself; a workspace address never links", () => {
    const web = read({
        target: "https://example.com/guide", lineMarker: null,
        tx: { op: "READ", target: { kind: "url", raw: "https://example.com/guide" }, matcher: null, aside: null },
    });
    assert.match(renderLogEntry(web), /^READ \(https:\/\/example\.com\/guide\)/u, "without styling, the address is text");
    assert.match(colored(() => renderLogEntry(web)), /\(\x1b\]8;;https:\/\/example\.com\/guide\x1b\\https:\/\/example\.com\/guide\x1b\]8;;\x1b\\\)/u, "with styling, the target links to itself");
    const local = read({
        target: "notes.md", lineMarker: null,
        tx: { op: "READ", target: { kind: "local", raw: "notes.md" }, matcher: null, aside: null },
    });
    assert.doesNotMatch(colored(() => renderLogEntry(local)), /\x1b\]8/u, "a file is not a destination anything outside the client can open");
});

test("[§cli-curation-notice] the daemon's over-budget row renders as a curation notice, never as a failure", () => {
    const overBudget = entry({
        op: "error", origin: "_plurnk", status_rx: 413, target: null, lineMarker: null,
        tx: null,
        rx: { status: 413, problem: { type: "https://problems.plurnk.xyz/engine/context/packet-exceeds-budget", title: "Packet exceeds budget", status: 413, detail: "Context exceeds budget. YOU MUST ONLY KILL, MOVE or NOTE this turn." } },
    });
    assert.equal(renderLogEntry(overBudget), "notice — curating context", "the person sees the curation moment, not the model's mandate");
    assert.match(colored(() => renderLogEntry(overBudget)), /\u001B\[(?:1;)?32m/u, "the notice is painted as a success, not a failure");
    const other = entry({
        op: "error", origin: "_plurnk", status_rx: 422, target: null, lineMarker: null, tx: null,
        rx: { status: 422, problem: { type: "https://problems.plurnk.xyz/engine/rail/no-operation", title: "No operation", status: 422, detail: "The turn performed no operation." } },
    });
    assert.equal(renderLogEntry(other), "error — No operation", "every other daemon error row keeps its title");
});

test("[§cli-log-entry-line-format] a glob READ that matched nothing carries the daemon's detail, not a count", () => {
    assert.equal(renderLogEntry(read({
        target: "pets_*.md", status_rx: 204, lineMarker: null,
        tx: { op: "READ", target: { kind: "local", raw: "pets_*.md" }, matcher: null, aside: null },
        rx: { status: 204, detail: "No path matched pets_*.md." },
    })), "READ (pets_*.md) — No path matched pets_*.md.");
});

test("[§cli-log-entry-line-format] failed rows show structured diagnostics as literal text beside their title", () => {
    const failed = (diagnostic: unknown) => entry({
        op: "brave", status_rx: 502, tx: { target: { kind: "local", raw: "brave_web_search" } },
        rx: { status: 502, problem: { type: "https://problems.plurnk.xyz/executor/mcp/tool-reported-error", status: 502,
            title: "Tool reported error", detail: "The MCP tool reported an error.", diagnostic } },
    });
    assert.equal(renderLogEntry(failed("No web results found")), "brave (brave_web_search) — Tool reported error: No web results found");
    for (const diagnostic of [undefined, null, 42, {}, "", " \n ", "Tool reported error"]) {
        assert.equal(renderLogEntry(failed(diagnostic)), "brave (brave_web_search) — Tool reported error");
    }
    assert.equal(renderLogEntry(failed("\x1b[31mNo\x1b[0m\n\t**results** \x1b]52;c;c2VjcmV0\x07found\r")),
        "brave (brave_web_search) — Tool reported error: No **results** found");
    assert.equal(outcomeTitle({ ...failed("No web results found"), status_rx: 200 }), null, "success does not acquire failure narration");
    const value = failed("No web results found");
    const original = structuredClone(value);
    renderLogEntry(value);
    assert.deepEqual(value, original, "rendering does not rewrite the wire result");
});

test("[§cli-log-entry-line-format] an execution row is named by its runtime and previews its body beneath", () => {
    const line = renderLogEntry(entry({
        op: "sh", target: null,
        tx: { runtime: "sh", target: null, aside: "Run the focused tests", body: "npm test -- --grep focused" },
        rx: { status: 200, outcome: "started" }, attrs: { runtime: "sh", stream: "sh:///1a2b3c4d" },
    }));
    assert.equal(line, "sh Run the focused tests\n    npm test -- --grep focused\n", "{plurnk#104} the invocation body previews beneath the row, a blank row under it");
});

test("[§cli-log-entry-line-format] a client `!` row is named by its op, the daemon's default runtime", () => {
    const started = entry({
        op: "sh", origin: "client", target: null, status_rx: 200,
        tx: { runtime: "sh", target: null, aside: null, body: "printf x" },
        rx: { status: 200, outcome: "started" }, attrs: { runtime: "sh", stream: "sh:///1a2b3c4d" },
    });
    assert.equal(renderLogEntry(started), "sh\n    printf x\n", "the human's `!` command runs in the default shell; its row says so, its command beneath");
    const refused = entry({
        op: "cobol", target: null, status_rx: 404,
        tx: { runtime: "cobol", target: null, aside: null, body: "x" },
        rx: { status: 404, problem: { type: "x", title: "Unknown executor", status: 404 } },
    });
    assert.equal(renderLogEntry(refused), "cobol — Unknown executor\n    x\n", "a refused execution is an ordinary failed row under its runtime");
});

test("[§cli-log-entry-line-format] COPY and MOVE keep each scope beside its own path", () => {
    const line = renderLogEntry(entry({
        op: "COPY", target: "notes.md",
        tx: { op: "COPY", aside: null, source: { target: { kind: "local", raw: "notes.md" }, lineMarker: { marks: [1, 3] }, matcher: null, metadata: null }, destination: { target: { kind: "url", raw: "worker:///archive/notes.md" }, lineMarker: { marks: [-1] }, matcher: null, metadata: null } },
        rx: { status: 201 },
    }));
    assert.equal(line, "COPY (notes.md) <1,3> (worker:///archive/notes.md) <-1>");
});

test("[§cli-log-entry-line-format] the row is literal text: no Markdown, no glyphs, the op name at column zero", () => {
    const line = renderLogEntry(entry({ op: "FIND", target: "*.md", tx: { op: "FIND", target: { kind: "local", raw: "*.md" }, matcher: null, aside: null }, rx: { status: 200, results: [], range: { unit: "resource", total: 7, requested: [1, 16], returned: [1, 7] } } }));
    assert.equal(line, "FIND (*.md) {7}");
    assert.match(renderLogEntry(entry({ op: "WHATEVER", target: "/x", tx: { op: "WHATEVER", target: { raw: "/x" } } })), /^WHATEVER \(\/x\)/, "an unknown op still renders as itself");
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
        id: 100 + index, sequence: 5 + index, target: `pets_${index}.md`, lineMarker: null,
        tx: { op: "READ", target: { kind: "local", raw: `pets_${index}.md` }, matcher: { dialect: "regex", raw: "/dogs/i", pattern: "dogs", flags: "i" }, aside: "every dog" },
        rx: { status: 200, content: "…", lineOrdinals: [2], range: { unit: "line", total: 9, requested: [1, -1], returned: [1, 9] } },
        attrs: { fanout: { target: "pets_*.md", matched: 3, index, count: 3 } },
        ...over,
    });
    assert.deepEqual(collapse.admit(row(0)), []);
    assert.deepEqual(collapse.admit(row(1)), []);
    const last = collapse.admit(row(2));
    assert.equal(last.length, 1);
    assert.equal(renderLogEntry(last[0].entry, 80, last[0].override), "READ (pets_*.md) /dogs/i {3} every dog", "one line for the authored statement, counting the paths it read");
    const ordinary = read();
    assert.deepEqual(collapse.admit(ordinary), [{ entry: ordinary }], "an ordinary row is untouched");
    for (const diagnostic of [undefined, "Not indexed"]) {
        const failed = collapse.admit(row(0, { status_rx: 404, rx: { status: 404, problem: { type: "x", title: "Entry not member", status: 404, diagnostic } } }));
        assert.equal(failed.length, 1, "a failed path is visible immediately");
        assert.equal(renderLogEntry(failed[0].entry, 80, failed[0].override),
            `READ (pets_0.md) /dogs/i every dog — Entry not member${diagnostic === undefined ? "" : `: ${diagnostic}`}`);
        assert.deepEqual(collapse.admit(row(1)), [{ entry: row(1) }]);
        assert.deepEqual(collapse.admit(row(2)), [{ entry: row(2) }], "later rows cannot hide the concrete failure in a summary");
    }
});

// ─── SEND blocks ({§cli-broadcast-send-rendering}) ─────

test("[§cli-broadcast-send-rendering] a delivered message is its body under a blank lead line; a failed one is an operation", () => {
    assert.equal(renderLogEntry(entry({ op: "SEND", target: null, tx: { op: "SEND", aside: null, body: { raw: "Paris.", json: null } } })), "\nParis.", "no keyword: a blank line, then the body at column zero");
    const block = renderLogEntry(entry({ op: "SEND", target: null, tx: { op: "SEND", aside: "the answer", body: { raw: "line one\nline two", json: null } } }));
    assert.deepEqual(block.split("\n"), ["the answer", "line one", "line two"], "the aside takes the lead line; body lines stay at column zero");
    assert.equal(renderLogEntry(entry({ op: "SEND", target: null, status_rx: 400, tx: { op: "SEND", aside: null, body: { raw: "Undelivered.", json: null } }, rx: { status: 400, problem: { type: "x", title: "Recipient unknown", status: 400 } } })), "SEND — Recipient unknown\n    Undelivered.\n", "a failed message is an operation carrying its Problem title");
    assert.equal(renderLogEntry(entry({ op: "SEND", target: null, tx: { op: "SEND", aside: null, body: null } })), "SEND", "an empty reply retains its operation receipt without blank speech");
});

test("[§cli-log-entry-line-format] a directed SEND is an operation row, never a message block", () => {
    assert.equal(renderLogEntry(entry({ op: "SEND", target: "worker:///gone", status_rx: 410, tx: { op: "SEND", target: { kind: "url", raw: "worker:///gone" }, aside: null, body: { raw: "hi", json: null } }, rx: { status: 410, problem: { type: "x", title: "Worker gone", status: 410 } } })), "SEND (worker:///gone) — Worker gone\n    hi\n");
});









// ─── renderSummary ────────────────────────────────────────────────────

const usage = (inputTokens: number, outputTokens: number, costUsd = "0") => ({
    accounting: {
        requests: [{ provider: "provider:test", model: "test", outcome: "response" }],
        usage: { inputTokens, outputTokens }, knownUsage: { inputTokens, outputTokens },
        costUsd,
        knownCostUsd: costUsd,
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
    const loopThrew = {
        status: 500,
        problem: {
            type: "https://problems.plurnk.xyz/daemon/drain/loop-threw",
            title: "Loop threw",
            status: 500,
            detail: "The loop failed outside its operation result contract.",
        },
    };
    const line = renderSummary(0, 83, loopThrew, false, usage(10, 5));
    assert.match(line, /failed/);
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

test("[§cli-summary-line-per-loop] curationGauge: weight + budget → 'cur N%/Mk'", () => {
    assert.equal(curationGauge(12000, 48000), " · cur 25%/48k");
});

test("[§cli-summary-line-per-loop] contextGauge: occupancy + window → 'ctx N%/Mk'", () => {
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
        op: "SEND", target: null, signal: 200, status_rx: 200,
        tx: { body: { raw: "Paris.", json: null } },
    }));
    const inner = out.replace(/^\n|\n$/g, "");
    assert.ok(!inner.includes("\n"), `expected one line, got: ${JSON.stringify(out)}`);
    assert.match(inner, /Paris\.$/);
});

test("broadcast: a multi-line body follows the blank lead line at column zero", () => {
    const out = renderLogEntry(entry({
        op: "SEND", target: null, signal: 200, status_rx: 200,
        tx: { body: { raw: "line one\nline two", json: null } },
    }));
    assert.deepEqual(out.split("\n"), ["", "line one", "line two"]);
});

// ─── Coordinate-free human waterfall (plurnk#21) ──────────────────────

test("[§cli-log-entry-line-format] the human waterfall carries no log coordinates", () => {
    const out = renderLogEntry(entry({
        op: "READ", target: "worker:///x", status_rx: 200,
        loop_seq: 1, turn_seq: 2, sequence: 3, rx: {}, tx: {},
    }));
    assert.doesNotMatch(out, /01\/02\/03/, "a human row carries no log coordinate");
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

test("{§cli-what-is-not-rendered} an emission row is recognized from hydrated or JSON attrs, and only from the daemon", () => {
    const base = { origin: "_plurnk", op: "READ" } as Partial<LogEntryWire>;
    assert.equal(isEmission(entry({ ...base, attrs: { kind: "emission" } })), true);
    assert.equal(isEmission(entry({ ...base, attrs: JSON.stringify({ kind: "emission" }) })), true);
    assert.equal(isEmission(entry({ ...base, attrs: { kind: "entry_materialized" } })), false);
    assert.equal(isEmission(entry({ ...base, origin: "model", attrs: { kind: "emission" } })), false);
    assert.equal(isEmission(entry({ ...base, op: "EDIT", attrs: { kind: "emission" } })), false);
});

test("coordinates never leak into rows, from ordinals or DB ids", () => {
    const out = renderLogEntry(entry({
        op: "READ", target: "worker:///x", status_rx: 200,
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
        const out = renderLogEntry(entry({ op: "READ", target: "worker:///x", status_rx: status, rx: {} }));
        assert.match(out, new RegExp(String(status)), `error ${status} keeps its code`);
    }
    for (const status of [102, 202, 301]) {
        const out = renderLogEntry(entry({ op: "READ", target: "worker:///x", status_rx: status, rx: {} }));
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
    assert.match(renderSendBody({ body: { raw: "- one\n- two", json: null } }), /[-*] one/);
});

test("extractSendBody prettify: plain text (no markdown markers) passes through", () => {
    assert.equal(renderSendBody({ body: { raw: "just words", json: null } }), "just words");
});

test("extractSendBody prettify: conventional inline right arrow renders as its terminal glyph", () => {
    const raw = "loading $\\rightarrow$ running";
    assert.equal(renderSendBody({ body: { raw, json: null } }), "loading → running");
    assert.equal(extractSendBody({ body: { raw, json: null } }), raw, "CLI output remains verbatim");
});

test("{§cli-markdown-projection} a reply with only inline formatting still uses native Markdown", () => {
    for (const [raw, expected] of [["*emphasis*", "emphasis"], ["_emphasis_", "emphasis"], ["~~removed~~", "removed"]]) {
        assert.equal(renderSendBody({ body: { raw } }), expected);
        assert.equal(extractSendBody({ body: { raw } }), raw, "CLI text remains untouched");
    }
});

test("{§cli-markdown-projection} reply code retains literal math and Markdown rather than normalizing their contents", () => {
    for (const raw of ["Use `$\\rightarrow$` verbatim.", "```text\n$\\rightarrow$ **not bold**\n```", "    $\\rightarrow$ **not bold**"]) {
        const out = renderSendBody({ body: { raw } });
        assert.ok(out.includes("$\\rightarrow$"), out);
        assert.doesNotMatch(out, /→/);
        if (raw.includes("**not bold**")) assert.ok(out.includes("**not bold**"));
        assert.equal(extractSendBody({ body: { raw } }), raw);
    }
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

test("renderSummary: unavailable money is explicitly unknown, not silently omitted", () => {
    const out = renderSummary(1, 100, terminalResult(200), false, {
        accounting: {
            requests: [{ provider: "provider:test", model: "test", outcome: "response", cost: { kind: "unknown" } }],
            usage: { inputTokens: 10, outputTokens: 5 }, knownUsage: { inputTokens: 10, outputTokens: 5 },
            costUsd: null, knownCostUsd: null,
        },
        curationWeight: null,
        curationBudget: null,
        contextTokens: null,
        contextCapacity: null,
        meta: {},
    });
    assert.match(out, /↓10 ↑5/, "physical evidence still renders");
    assert.match(out, /loop \$\?/, "a missing price is not a free request");
});

test("[§cli-summary-line-per-loop] contextGauge renders the daemon's request-matched physical capacity", () => {
    assert.equal(contextGauge(18000, 36000), " · ctx 50%/36k");
    assert.equal(contextGauge(18000, 128000), " · ctx 14%/128k");
    assert.equal(contextGauge(18000, null), "", "a loop the daemon can't window omits the gauge, never lies with a stale one");
});

test("[§cli-summary-line-per-loop] renderSummary takes both gauge denominators from the terminal envelope", () => {
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
    const row = renderPendingRow(entry({ op: "sh", target: null, tx: { runtime: "sh", target: null, aside: "Run the suite", body: "npm test" }, rx: { status: 200, outcome: "started" }, attrs: { runtime: "sh", stream: "sh:///1a2b3c4d" } }));
    assert.equal(row, "sh Run the suite");
    assert.doesNotMatch(row, /npm test|started/);
});

test("{plurnk#107} a body previews at the knob's line count and names the address the rest lives at; a NOTE renders whole", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
    const sh = entry({
        op: "sh", target: null, loop_seq: 1, turn_seq: 2, sequence: 3,
        tx: { runtime: "sh", target: null, aside: null, body: lines.join("\n") },
        rx: { status: 200, outcome: "started" }, attrs: { runtime: "sh", stream: "sh:///1a2b3c4d" },
    });
    const rows = renderLogEntry(sh, 80).split("\n");
    assert.equal(rows[0], "sh");
    assert.deepEqual(rows.slice(1, 4), lines.slice(0, 3).map((line) => `    ${line}`), "three of forty lines, the shipped PLURNK_CLIENT_PREVIEW_LINES, four columns in");
    assert.equal(rows[4], "    … +37 lines · log:///1/2/3/sh", "the rest is named with the address it lives at");
    assert.deepEqual(rows.slice(5), [""], "a blank row closes the block");
    const short = entry({ ...sh, tx: { runtime: "sh", target: null, aside: null, body: "one\ntwo" } });
    assert.equal(renderLogEntry(short, 80), "sh\n    one\n    two\n", "a short body is shown whole");
    const note = entry({
        op: "NOTE", target: null, loop_seq: 1, turn_seq: 2, sequence: 4,
        tx: { op: "NOTE", target: null, aside: null, body: { raw: lines.join("\n"), json: null } },
    });
    const noteRows = renderLogEntry(note, 80).split("\n");
    assert.deepEqual([noteRows[0], noteRows.at(-1)], ["", "line 40"], "a model NOTE uses the message layout");
    assert.equal(noteRows.length, 41, "the blank lead and all forty lines");
    assert.deepEqual(noteRows.slice(1, 3), ["line 1", "line 2"], "a model NOTE uses the full column width");
    assert.ok(!noteRows.some((row) => /… \+\d+ lines/u.test(row)), "a NOTE is never cut");
});

test("{§cli-note-rendering} a model NOTE renders plain and dim, the status line's weight, never as a reply", () => {
    const note = entry({
        op: "NOTE", target: null, loop_seq: 1, turn_seq: 2, sequence: 4,
        tx: { op: "NOTE", target: null, aside: null, body: { raw: "bearings kept\nnext: read the test", json: null } },
    });
    process.env.PLURNK_CLIENT_COLOR = "always";
    try {
        const rows = renderLogEntry(note, 80).split("\n");
        assert.deepEqual(rows, ["", paint("bearings kept", "dim"), paint("next: read the test", "dim")],
            "a blank lead, then every line dim: no reply weight");
        const bold = entry({ ...note, tx: { op: "NOTE", target: null, aside: null, body: { raw: "**bold**", json: null } } });
        assert.equal(renderLogEntry(bold, 80), `\n${paint("bold", "dim")}`, "Markdown weight is stripped before the dim paint");
    } finally {
        delete process.env.PLURNK_CLIENT_COLOR;
    }
});

test("{plurnk#108} a lineage row renders two columns in with the child's name, its body previewed, and a child's conclusion names its outcome", () => {
    const launch = entry({
        op: "brave", origin: "_plurnk", source: "worker://identity", target: "brave_web_search",
        tx: { runtime: "brave", target: { kind: "local", raw: "brave_web_search" }, aside: null, body: "{\"query\":\"space bunny\"}" },
        rx: { status: 200, outcome: "started" }, attrs: { runtime: "brave", stream: "brave:///5623708a" },
    });
    const rows = renderLogEntry(launch, 80).split("\n");
    assert.equal(rows[0], "  🐜 identity brave (brave_web_search)", "the child's name leads, two columns in");
    assert.equal(rows[1], "      {\"query\":\"space bunny\"}", "the body previews beneath, one step deeper");
    assert.deepEqual(rows.slice(2), [""], "the blank row closes the block");
    const struck = entry({
        op: "READ", origin: "_plurnk", target: "ops://identity/14", status_rx: 500,
        tx: { op: "READ", target: { kind: "url", raw: "ops://identity/14" }, matcher: null, aside: null },
        rx: { status: 500, problem: { type: "x", title: "Struck out", status: 500 } },
    });
    const conclusion = renderLogEntry(struck, 80);
    assert.match(conclusion, /^READ \(ops:\/\/identity\/14\).*— Struck out/u, "a child's conclusion is the parent's own row, carrying the child's terminal outcome");
    assert.ok(!conclusion.includes("🐜"), "no mark: the harness reads ops:// for the worker itself too, and the ant is the status line's child count");
    assert.ok(!renderLogEntry(entry({ op: "sh", origin: "model", tx: { runtime: "sh", body: "ls" } }), 80).includes("🐜"), "the bound worker's own rows carry no mark");
    const arrival = entry({ op: "SEND", origin: "_plurnk", attrs: { kind: "message" }, source: "worker://identity", tx: { body: { raw: "done" } } });
    assert.ok(!renderLogEntry(arrival, 80).includes("🐜"), "a child's message keeps its arrival form, sender and all");
});

test("{plurnk#108} an observed descendant's row steps in one step per generation, and its output follows", () => {
    const grandchild = entry({ op: "sh", origin: "model", tx: { runtime: "sh", body: "ls" } });
    const rows = renderDescendantBlock(grandchild, "grand", 2).split("\n");
    assert.equal(rows[0], "    🐜 grand sh", "two generations, four columns in");
    assert.equal(rows[1], "        ls", "the preview follows one step deeper");
    assert.equal(indentDescendant("    one\n\n    two", 1), "      one\n\n      two", "blank lines stay blank");
    assert.equal(markDescendant("sh\n    ls", "child", 1), "  🐜 child sh\n      ls");
});

test("{plurnk#107} the preview count is the knob's, never the terminal's height, and an unreadable knob is an error", () => {
    const sh = entry({
        op: "sh", target: null, loop_seq: 1, turn_seq: 2, sequence: 3,
        tx: { runtime: "sh", target: null, aside: null, body: Array.from({ length: 12 }, (_, index) => `l${index + 1}`).join("\n") },
        rx: { status: 200, outcome: "started" }, attrs: { runtime: "sh", stream: "sh:///1a2b3c4d" },
    });
    const shipped = process.env.PLURNK_CLIENT_PREVIEW_LINES;
    try {
        process.env.PLURNK_CLIENT_PREVIEW_LINES = "8";
        assert.equal(renderLogEntry(sh, 80).split("\n").length, 11, "eight lines, the marker, a blank row");
        process.env.PLURNK_CLIENT_PREVIEW_LINES = "0";
        assert.equal(renderLogEntry(sh, 80), "sh\n    … +12 lines · log:///1/2/3/sh\n", "zero shows only where the body lives");
        process.env.PLURNK_CLIENT_PREVIEW_LINES = "a third";
        assert.throws(() => renderLogEntry(sh, 80), /PLURNK_CLIENT_PREVIEW_LINES must be a non-negative integer/u);
    } finally {
        if (shipped === undefined) delete process.env.PLURNK_CLIENT_PREVIEW_LINES;
        else process.env.PLURNK_CLIENT_PREVIEW_LINES = shipped;
    }
});

test("{plurnk#162} a previewed line is one row: a line wider than the terminal is cut at its width and marked", () => {
    const minified = "x".repeat(43_761);
    const sh = entry({
        op: "sh", target: null, loop_seq: 8, turn_seq: 1, sequence: 5,
        tx: { runtime: "sh", target: null, aside: null, body: `${minified}\n${"漢".repeat(200)}\n\tindented` },
        rx: { status: 200, outcome: "started" }, attrs: { runtime: "sh", stream: "sh:///92689a95" },
    });
    const rows = stripVTControlCharacters(renderLogEntry(sh, 80)).split("\n");
    assert.equal(rows.length, 5, "a row, three preview rows and the closing blank: no line wraps");
    assert.equal(rows[1], `    ${"x".repeat(75)}…`, "the cut fills the row and is marked");
    assert.ok(rows[2]!.endsWith("…") && rows[2]!.length <= 4 + 38, "wide characters count two columns each");
    assert.equal(rows[3], "        indented", "a tab is four columns");
    for (const row of rows) assert.ok(row.length <= 80, `no preview row is wider than the terminal: ${row.length}`);
});

// ─── The row's verdict and its paint ({§cli-log-entry-line-format}, plurnk#181) ───
// Paint is asserted as SGR, never stripped: green 32, red 31, dim 38;5;145 on the default dark ground.
const GREEN_NAME = (name: string): string => `\x1b[1;32m${name}\x1b[0m`;
const RED_NAME = (name: string): string => `\x1b[1;31m${name}\x1b[0m`;
const DIM = (text: string): string => `\x1b[38;5;145m${text}\x1b[0m`;
const RED = (text: string): string => `\x1b[31m${text}\x1b[0m`;

test("{§cli-log-entry-line-format} the verdict is the row's status: a disposition's informational detail is dim beside a green name", () => {
    for (const detail of ["Nothing is in flight. Continuing.", "This loop is already concluded.", "All Open Messages resolved. Review new results; emit no OPs if finished."]) {
        const wait = entry({ op: "WAIT", status_rx: 102, tx: { op: "WAIT", body: null, target: null, aside: null }, rx: { status: 102, detail } });
        assert.equal(colored(() => renderLogEntry(wait, 120)), `${GREEN_NAME("WAIT")} — ${DIM(detail)}`, detail);
    }
    const silent = entry({ op: "WAIT", status_rx: 102, tx: { op: "WAIT", body: null, target: null, aside: null }, rx: { status: 102 } });
    assert.equal(colored(() => renderLogEntry(silent, 120)), GREEN_NAME("WAIT"), "no detail, no dash");
});

test("{§cli-log-entry-line-format} a row at 400 or above is red, name and outcome, with its Problem title or its detail", () => {
    const refused = entry({
        op: "WAIT", status_rx: 422, tx: { op: "WAIT", body: null, target: null, aside: null },
        rx: { status: 422, problem: { type: "https://problems.plurnk.xyz/engine/turn/no-operation", title: "No operation", status: 422 } },
    });
    assert.equal(colored(() => renderLogEntry(refused, 120)), `${RED_NAME("WAIT")} — ${RED("No operation")}`);
    const problemless = entry({ op: "WAIT", status_rx: 499, tx: { op: "WAIT", body: null, target: null, aside: null }, rx: { status: 499, detail: "Cancelled." } });
    assert.equal(colored(() => renderLogEntry(problemless, 120)), `${RED_NAME("WAIT")} — ${RED("Cancelled.")}`, "a failing status reddens a Problem-less detail too");
    const read = entry({ op: "READ", status_rx: 404, tx: { target: "missing.txt" }, rx: { status: 404, problem: { type: "https://problems.plurnk.xyz/engine/entry/not-found", title: "Entry not found", status: 404 } } });
    assert.match(colored(() => renderLogEntry(read, 120)), /^\x1b\[1;31mREAD\x1b\[0m .*— \x1b\[31mEntry not found\x1b\[0m\n?$/u);
});

test("{§cli-log-entry-line-format} a caller's verdict overrides the status in both directions, and an outcome text alone never reddens", () => {
    const launched = entry({ op: "sh", status_rx: 102, tx: { runtime: "sh", target: null, aside: null, body: null }, rx: { status: 102 } });
    assert.equal(colored(() => renderOperationRow(launched, { failed: true, failure: "exit 2" })), `${RED_NAME("sh")} — ${RED("exit 2")}`, "an execution that concluded unsuccessfully");
    assert.equal(colored(() => renderOperationRow(launched, { failed: false, failure: null })), GREEN_NAME("sh"), "an execution that concluded 200");
    assert.equal(colored(() => renderOperationRow(launched, { failure: "a note" })), `${GREEN_NAME("sh")} — ${DIM("a note")}`, "text is not a verdict");
    const refused = entry({ op: "sh", status_rx: 403, tx: { runtime: "sh", target: null, aside: null, body: null }, rx: { status: 403 } });
    assert.equal(colored(() => renderOperationRow(refused, { failed: false, failure: null })), GREEN_NAME("sh"), "the caller's verdict stands over a failing status");
});
