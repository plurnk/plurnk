import test from "node:test";
import assert from "node:assert/strict";
import { formatRollback } from "./rollback.ts";

test("rollback output lists each reversal by file and row, the skipped rows by reason, and the outcome", () => {
    assert.equal(formatRollback({
        to: "1/1/2",
        restored: [
            { coordinate: "1/1/4", path: "new.md", action: "delete" },
            { coordinate: "1/1/3", path: "a.md", action: "update" },
        ],
        skipped: [{ coordinate: "1/1/5", reason: "no-patch" }, { coordinate: "1/1/6", reason: "already-reversed" }],
        stopped: null,
    }), [
        "rollback: to log:///1/1/2",
        "rollback: removed new.md (log:///1/1/4)",
        "rollback: restored a.md (log:///1/1/3)",
        "rollback: skipped log:///1/1/5, kept no patch",
        "rollback: skipped log:///1/1/6, already reversed",
        "rollback: 2 file mutations reversed, each as your own operation",
    ].join("\n"));
});

test("rollback output names where drift stopped it, and says so when nothing was reversed", () => {
    assert.equal(formatRollback({
        to: "1/1/2",
        restored: [],
        skipped: [],
        stopped: { coordinate: "1/1/3", path: "a.md", reason: "drift", detail: "'a.md' no longer holds what log:///1/1/3 wrote." },
    }), [
        "rollback: to log:///1/1/2",
        "rollback: stopped at log:///1/1/3 (a.md), drift: 'a.md' no longer holds what log:///1/1/3 wrote.",
    ].join("\n"));
    assert.equal(formatRollback({ to: "1/1/2", restored: [], skipped: [], stopped: null }), [
        "rollback: to log:///1/1/2",
        "rollback: nothing to reverse",
    ].join("\n"));
});
