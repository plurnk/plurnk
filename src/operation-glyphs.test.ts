import test from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth, truncateToWidth } from "@earendil-works/pi-tui";
import stringWidth from "string-width";
import { renderLogEntry } from "./render-message.ts";
import { renderOperationRow, type LogEntryWire } from "./render.ts";
import { formatPlain } from "./cli.ts";
import { renderDiagnostic } from "./diagnostics.ts";

process.env.NO_COLOR = "1";

const entry = (op: string, overrides: Partial<LogEntryWire> = {}): LogEntryWire => ({
    id: 1, op, origin: "model", signal: null, target: "example", lineMarker: null,
    status_rx: 200, tx: null, rx: null, loop_seq: 1, turn_seq: 1, sequence: 1,
    ...overrides,
});

test("[§cli-operation-glyphs] operation labels are glyphs; other runtimes retain their names after a gear", () => {
    const labels = {
        NOTE: "🗒️", FIND: "🔎", READ: "📖", EDIT: "📝", COPY: "🖨️", MOVE: "📦",
        KILL: "🗑️", WORK: "🐜", FORK: "🔱", BARE: "☁️", WAIT: "⏳", SEND: "✉️",
        WARN: "⚠️", FAIL: "⛔", INFO: "📌", FACT: "📊", IDEA: "💡", PLAN: "🚧",
        sh: "⚙️ sh", mcp: "⚙️ mcp", schedule: "⚙️ schedule", members: "⚙️ members",
        brave: "⚙️ brave", tools: "⚙️ tools",
    };
    for (const [op, label] of Object.entries(labels)) {
        const row = entry(op, { target: null });
        assert.equal(renderOperationRow(row), label, op);
        assert.equal(formatPlain(row), `[200] model ${op}`, "CLI trace keeps operation names");
        const glyph = label.split(" ")[0]!;
        assert.equal(visibleWidth(glyph), 2, op);
        assert.equal(stringWidth(glyph), 2, op);
        assert.equal(visibleWidth(`${glyph} x`), 4, "a literal space follows the two-column glyph");
        assert.equal(stripVTControlCharacters(truncateToWidth(`${glyph} xyz`, 4, "")), `${glyph} x`, "clipping preserves the glyph and its spacing");
    }
});

test("[§cli-operation-glyphs] NOTE categories replace both the NOTE label and its category aside, never its body", () => {
    for (const [aside, label] of [["fact", "📊"], ["IDEA", "💡"], [" plan ", "🚧"]]) {
        const row = entry("NOTE", { target: null, tx: { aside, body: { raw: "Retained words." } } });
        assert.equal(renderOperationRow(row), label);
        assert.equal(renderLogEntry(row), `${label}\nRetained words.`);
        assert.equal((row.tx as { aside: string }).aside, aside, "wire metadata is unchanged");
    }
    const row = entry("NOTE", { target: null, tx: { aside: "plan for tomorrow", body: { raw: "Retained words." } } });
    assert.equal(renderLogEntry(row), "🗒️ plan for tomorrow\nRetained words.", "free-form asides are not inferred categories");
});

test("[§cli-operation-glyphs] SEND completion is not the receipt's transport status", () => {
    for (const [completion, label] of [[undefined, "✉️"], [200, "🐹"], [499, "❌"]] as const) {
        for (const delivered of [false, true]) {
            const row = entry("SEND", { target: null, signal: completion ?? null,
                message: delivered ? { id: "reply", role: "assistant" } : undefined,
                tx: { body: { raw: "Answer." } }, rx: { status: 200, completion } });
            assert.equal(renderLogEntry(row).split("\n")[0], label);
            assert.equal(renderOperationRow({ ...row, signal: null }), label, "history may carry only the settled completion");
        }
    }
    assert.equal(renderOperationRow(entry("SEND", { target: null, status_rx: 499, rx: { status: 499, problem: { title: "Refused" } } })),
        "✉️ — Refused", "a failed delivery is not a cancellation reply");
    assert.equal(renderOperationRow(entry("error", { target: null, status_rx: 400, attrs: { attempt: { verb: "READ" } }, rx: { problem: { title: "Invalid range" } } })),
        "📖 — Invalid range", "a refused operation retains its identity");
});

test("[§cli-operation-glyphs] diagnostics use the corresponding severity glyph", () => {
    for (const [level, glyph] of [["warn", "⚠️"], ["error", "⛔"], ["info", "📌"]] as const) {
        assert.equal(renderDiagnostic({ source: "fixture", kind: "notice", level, message: "Exact words." }),
            `${glyph} fixture:notice — Exact words.`);
    }
});
