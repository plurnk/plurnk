// Unit tests for src/render.ts. Run with NO_COLOR=1 to keep assertions
// free of ANSI escape codes — the color rendering paths are simple
// enough that visual inspection during smoke covers them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PLURNK_OPS } from "@plurnk/plurnk-contracts";

// Set NO_COLOR before importing render.ts so its module-load-time check
// returns false and all color helpers emit empty strings.
process.env.NO_COLOR = "1";

const {
    extractSendBody,
    renderLogEntry,
    renderPendingRow,
    renderReasoning,
    renderSummary,
    curationGauge,
    contextGauge,
    progressLabel,
    coordLabel,
    isEntryMaterialization,
    isPromptEntry,
    entryTarget,
    receiptCount,
    outcomeTitle,
    FanoutCollapse,
} = await import("./render.ts");
type LogEntryWire = Awaited<ReturnType<typeof import("./render.ts")["renderLogEntry"]>> extends string
    ? Parameters<typeof import("./render.ts")["renderLogEntry"]>[0]
    : never;

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
    rx: null,
    tags: [],
    loop_seq: 1,
    turn_seq: 1,
    sequence: 1,
    ...overrides,
});

// ─── sendSubGlyph ─────────────────────────────────────────────────────

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

test("model-authored text never reaches the terminal with its own control sequences (plurnk#35)", () => {
    const body = extractSendBody({ body: { raw: "safe \x1b]52;c;aGVsbG8=\x07 text", json: null } }, true);
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

// ─── user prompt entries ─────────────────────────────────────────────

test("[§cli-what-is-not-rendered] isPromptEntry classifies only the service's actionless prompt row", () => {
    assert.equal(isPromptEntry(entry({ op: "prompt", scheme: "prompt", pathname: "/1/1" })), true);
    assert.equal(isPromptEntry(entry({ op: "prompt", scheme: "prompt", pathname: "/3/2" })), true);
    assert.equal(isPromptEntry(entry({ op: "EDIT", scheme: "prompt", pathname: "/1/1" })), false, "the obsolete synthetic EDIT shape is not tolerated");
    assert.equal(isPromptEntry(entry({ op: "READ", scheme: "prompt", pathname: "/1/1" })), false);
    assert.equal(isPromptEntry(entry({ op: "prompt", scheme: "worker", pathname: "/notes.md" })), false);
});

test("[§cli-log-entry-line-format] entryTarget preserves literal resource addresses without caller-relative synthesis", () => {
    assert.equal(entryTarget(entry({ scheme: "worker", hostname: null, pathname: "/plan.md" })), "worker:///plan.md", "empty authority = commons, verbatim");
    assert.equal(entryTarget(entry({ scheme: "worker", hostname: "extract-host", pathname: "/plan.md" })), "worker://extract-host/plan.md", "named worker verbatim");
    assert.equal(entryTarget(entry({ scheme: "worker", hostname: "plurnk", pathname: "/docs/x.md" })), "worker://plurnk/docs/x.md", "plurnk = kernel, bare");
    assert.equal(entryTarget(entry({ scheme: "prompt", hostname: "extract-host", pathname: "/1/2" })), "prompt://extract-host/1/2");
    assert.equal(entryTarget(entry({ scheme: "reasoning", hostname: "extract-host", pathname: "/1/2/1" })), "reasoning://extract-host/1/2/1");
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

test("bold: a failed SEND is not presented as a delivered answer", async () => {
    delete process.env.NO_COLOR; // any non-empty value disables (no-color.org, plurnk#29)
    const colored = await freshRender("bold=499");
    process.env.NO_COLOR = "1";
    const out = colored.renderLogEntry(entry({ ...sendEntry, op: "SEND", signal: null, status_rx: 499 }));
    assert.doesNotMatch(out, /\x1b\[1m[^\x1b]*Paris/, "the header word is styled; the undelivered body is not the bold answer");
});

test("bold: inner RESET re-arms bold so header styling cannot cut the answer", async () => {
    delete process.env.NO_COLOR; // any non-empty value disables (no-color.org, plurnk#29)
    const colored = await freshRender("bold=rearm");
    process.env.NO_COLOR = "1";
    // The aside's dim span emits its own RESET; answer bold must resume
    // immediately afterward instead of dying before the body.
    const out = colored.renderLogEntry(entry({ ...sendEntry, tx: { aside: "ready", body: { raw: "strong then more", json: null } } }));
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
    assert.doesNotMatch(out, /\x1b\[1m[^\x1b]*hi/, "a client's message body is not presented as the model's answer");
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

// ─── SEND blocks and TASK tables ({§cli-broadcast-send-rendering}, {§cli-plan-rendering}) ─────

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

const inventory = (entries: unknown[], over: Partial<LogEntryWire> = {}): LogEntryWire => entry({
    op: "TASK", scheme: null, pathname: null, signal: 102, status_rx: 102,
    tx: { op: "TASK", aside: null, body: { entries } } as unknown as { body: { raw: string; json: null } },
    rx: { status: 102 },
    ...over,
});

test("[§cli-plan-rendering] TASK renders a status-column table with only the populated columns, under the native names", () => {
    const out = renderLogEntry(inventory([
        { content: "Read core docs (AGENTS, ARCHITECTURE, package.json, README)", priority: "medium", status: "in_progress" },
        { content: "Compose project description response", priority: "medium", status: "pending" },
    ]), 100);
    const lines = out.split("\n");
    assert.equal(lines[0], "", "no keyword: the lead line is blank");
    assert.doesNotMatch(out, /TASK/);
    assert.match(out, /todo/);
    assert.match(out, /in_progress/);
    assert.doesNotMatch(out, /pending|completed|waiting|failed/, "empty columns are absent and ACP's pending is shown as todo");
    assert.match(out, /Read core docs/);
    assert.match(out, /Compose project description response/);
    assert.doesNotMatch(out, /✅|🚧|⬜|▶️|102/);
});

test("[§cli-plan-rendering] a deferred completion carries the receipt's detail on the TASK line, and a failed TASK its Problem title", () => {
    const deferred = renderLogEntry(inventory([{ content: "Compose the response", priority: "medium", status: "completed" }], {
        rx: { status: 102, detail: "Completion deferred: 1 operation failed in the same turn. The failure is in this packet; address it or complete with a TASK now." },
        attrs: { failures: 1 },
    }), 100);
    assert.match(deferred.split("\n")[0]!, /^Completion deferred: 1 operation failed in the same turn\./);
    assert.match(deferred, /completed/);
    const failed = renderLogEntry(inventory([{ content: "Verify", priority: "medium", status: "completed", _meta: { "plurnk.xyz/status": "failed" } }], {
        status_rx: 409, rx: { status: 409, problem: { type: "x", title: "Loop already terminal", status: 409 } },
    }), 100);
    assert.equal(failed.split("\n")[0], "Loop already terminal");
    assert.match(failed, /failed/);
    assert.equal(renderLogEntry(inventory([], { status_rx: 200, rx: { status: 200 } })), "", "an empty inventory is the blank lead line alone");
});

test("[§cli-plan-rendering] the TASK table wraps to the live width instead of overflowing it", () => {
    const out = renderLogEntry(inventory([
        { content: "A rather long description of a task that must wrap without losing any of its words at all", priority: "medium", status: "in_progress" },
        { content: "Another long description that sits in the second column and must wrap independently", priority: "medium", status: "pending" },
    ]), 60);
    assert.ok(out.split("\n").every((line) => line.length <= 60), out);
    assert.match(out, /losing any/);
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
