import { test } from "node:test";
import assert from "node:assert/strict";
import { FanoutCollapse, renderOperationRow, type LogEntryWire } from "./render.ts";
import { renderHistory } from "./render-history.ts";

process.env.NO_COLOR = "1";

const row = (op: string, index: number, overrides: Partial<LogEntryWire> = {}): LogEntryWire => ({
    id: index + 1, worker_id: 1, op, origin: "model", signal: null,
    target: `file://part-${index}.txt`,
    lineMarker: null, status_rx: 200, tx: { op, target: { kind: "local", raw: `part-${index}.txt` } },
    rx: { status: 200, lineOrdinals: [1] }, loop_seq: 1, turn_seq: 1, sequence: index + 1,
    attrs: { fanout: { target: "part-*.txt", matched: 3, index, count: 3 } },
    ...overrides,
});

for (const op of ["READ", "EDIT", "KILL"]) {
    test(`{§cli-log-entry-line-format}: ${op} collapses only a complete successful group`, () => {
        const collapse = new FanoutCollapse();
        assert.deepEqual(collapse.admit(row(op, 0)), []);
        assert.deepEqual(collapse.admit(row(op, 1)), []);
        const shown = collapse.admit(row(op, 2));
        assert.equal(shown.length, 1);
        assert.equal(renderOperationRow(shown[0].entry, shown[0].override), `${op} (part-*.txt) {3}`);
        assert.deepEqual(collapse.flush(), []);
    });

    test(`{§cli-log-entry-line-format}: ${op} exposes concrete successes and failures before the last planned receipt`, () => {
        const collapse = new FanoutCollapse();
        const first = row(op, 0);
        const failed = row(op, 1, { status_rx: 409, rx: { status: 409, problem: {
            type: "https://example.test/conflict", title: "Entry changed", status: 409, diagnostic: "READ current content",
        } } });
        collapse.admit(first);
        assert.deepEqual(collapse.admit(failed), [{ entry: first }, { entry: failed }]);
        assert.match(renderOperationRow(failed), /part-1\.txt.*Entry changed: READ current content/);
        assert.deepEqual(collapse.flush(), [], "failure already exposed both receipts");
        const last = row(op, 2);
        assert.deepEqual(collapse.admit(last), [{ entry: last }], "a late suffix cannot claim a whole group");
    });

    test(`{§cli-log-entry-line-format}: ending a ${op} group retains partial work exactly once`, () => {
        const collapse = new FanoutCollapse();
        const first = row(op, 0);
        collapse.admit(first);
        assert.deepEqual(collapse.flush(), [{ entry: first }]);
        assert.deepEqual(collapse.flush(), []);
        const last = row(op, 2);
        assert.deepEqual(collapse.admit(last), [{ entry: last }]);
    });

    test(`{§cli-worker-history}: partial ${op} history retains targets and original failures`, () => {
        const entries = [row(op, 0), row(op, 1, { status_rx: 409, rx: { status: 409, problem: {
            type: "https://example.test/conflict", title: "Entry changed", status: 409,
        } } })];
        assert.deepEqual(renderHistory({ attachment: false, entries, messages: [] }, "main", 80),
            entries.map((entry) => renderOperationRow(entry)));
        assert.deepEqual(renderHistory({ attachment: false, entries: [row(op, 2)], messages: [] }, "main", 80),
            [renderOperationRow(row(op, 2))], "a bounded history suffix remains one known receipt");
    });
}

for (const [boundary, override] of Object.entries({
    worker: { worker_id: 2 }, loop: { loop_seq: 2 }, turn: { turn_seq: 2 },
    operation: { op: "KILL" }, origin: { origin: "client" }, source: { source: "worker://other" },
    selector: { attrs: { fanout: { target: "other-*", matched: 3, index: 1, count: 3 } } },
    count: { attrs: { fanout: { target: "part-*.txt", matched: 4, index: 1, count: 4 } } },
    ordinary: { attrs: null },
})) {
    test(`{§cli-log-entry-line-format}: a ${boundary} boundary cannot combine unrelated receipts`, () => {
        const collapse = new FanoutCollapse();
        const first = row("EDIT", 0);
        const next = row("EDIT", 1, override);
        collapse.admit(first);
        assert.deepEqual(collapse.admit(next), [{ entry: first }, { entry: next }]);
        assert.deepEqual(collapse.flush(), []);
    });
}

test("{§cli-log-entry-line-format}: a repeated selector starts a distinct group", () => {
    const collapse = new FanoutCollapse();
    const earlier = row("EDIT", 0);
    collapse.admit(earlier);
    const later = row("EDIT", 0, { id: 4, sequence: 4 });
    assert.deepEqual(collapse.admit(later), [{ entry: earlier }]);
    assert.deepEqual(collapse.flush(), [{ entry: later }]);
});

test("{§cli-log-entry-line-format}: a missing prefix, gap, or pending receipt is never a complete result", () => {
    const collapse = new FanoutCollapse();
    const last = row("READ", 2);
    assert.deepEqual(collapse.admit(last), [{ entry: last }]);
    const first = row("READ", 0);
    collapse.admit(first);
    assert.deepEqual(collapse.admit(last), [{ entry: first }, { entry: last }]);
    for (const status of [102, 202]) {
        const pending = row("READ", 0, { status_rx: status, rx: { status } });
        assert.deepEqual(collapse.admit(pending), [{ entry: pending }]);
    }
    assert.deepEqual(collapse.flush(), []);
});
