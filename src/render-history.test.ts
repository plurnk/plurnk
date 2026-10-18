import test from "node:test";
import assert from "node:assert/strict";
import { renderHistory } from "./render-history.ts";
import type { LogEntryWire } from "./render.ts";
import { snapshotRows } from "./rows.ts";

process.env.NO_COLOR = "1";
const entry = (overrides: Partial<LogEntryWire>): LogEntryWire => ({
    id: 1, origin: "model", op: "READ", signal: null,
    target: null, lineMarker: null, status_rx: 200, tx: null,
    rx: null, loop_seq: 1, turn_seq: 1, sequence: 1, ...overrides,
});

test("{§cli-broadcast-send-rendering}: qualified attachment preserves standard speech addressed under earlier thread spellings", () => {
    for (const source of ["agui://operator/threads/alice/messages/m1", "agui://operator/threads/opaque-uuid/messages/m1"]) {
        const rows = snapshotRows([{ id: "1/1/1", role: "assistant", content: "Retained answer", metadata: { plurnk: {
            id: 1, coordinate: "1/1/1", worker: 7, origin: "model", op: "SEND", source: null, address: null,
            signal: 200, status: 200, attrs: {}, receipt: { status: 200, answers: [source], completion: 200 },
        } } }]);
        assert.deepEqual(renderHistory({ attachment: true, entries: rows }, "42#alice", 80),
            ["🐹\nRetained answer", "— 1 earlier entries · /log for more —"]);
    }
});

test("[§cli-worker-history] a snapshot's prompt, operation headings and speech keep their row order; its reasoning is never replayed", () => {
    const source = "agui://anonymous/threads/alice/messages/prompt";
    const facts = (id: number, over: Record<string, unknown> = {}) => ({ plurnk: { id, coordinate: `1/1/${id}`, worker: 7, origin: "model", op: "READ",
        source: null, address: null, signal: null, status: 200, attrs: {}, ...over } });
    const rows = snapshotRows([
        { id: "prompt", role: "user", content: "snapshot prompt\nsecond line", metadata: facts(1, { origin: "_plurnk", op: "SEND", source, attrs: { kind: "message" } }) },
        { id: "1/1/2", role: "assistant", toolCalls: [{ id: "1/1/2", type: "function",
            function: { name: "READ", arguments: JSON.stringify({ target: { kind: "local", raw: "a.md" } }) }, metadata: facts(2, { address: "a.md" }) }] },
        { id: "1/1/2/result", role: "tool", toolCallId: "1/1/2", content: JSON.stringify({ status: 200 }), metadata: facts(2, { address: "a.md" }) },
        { id: "1/1/3/reasoning", role: "reasoning", content: "OLD_REASONING_NOT_REPLAYED" },
        { id: "1/1/3", role: "assistant", content: "snapshot answer",
            metadata: { plurnk: { ...facts(3, { op: "SEND" }).plurnk, aside: null, receipt: { status: 200, answers: [source], completion: 200 } } } },
    ]);
    assert.deepEqual(renderHistory({ attachment: true, entries: rows }, "alice", 80),
        ["› snapshot prompt\n  second line", "📖 (a.md)", "🐹\nsnapshot answer", "— 3 earlier entries · /log for more —"]);
});

test("{§cli-worker-history}: another actor's message keeps its sender, an answer its words, and a materialization draws nothing", () => {
    assert.deepEqual(renderHistory({ attachment: false, entries: [
        entry({ id: 1, op: "SEND", origin: "_plurnk", source: "worker://helper", attrs: { kind: "message" }, tx: { body: "worker update" } }),
        entry({ id: 2, op: "SEND", message: { id: "1/1/2", role: "assistant" }, rx: { answers: ["agui://anonymous/threads/alice/messages/m1"], completion: 200 }, tx: { body: "recent answer" } }),
        entry({ id: 3, op: "EDIT", origin: "_plurnk", attrs: { kind: "entry_materialized" } }),
    ] }, "alice", 80), ["✉️ (worker://helper)\nworker update", "🐹\nrecent answer"]);
});

test("{§cli-worker-history}: an empty history emits no decorative seam or old reasoning", () => {
    assert.deepEqual(renderHistory({ attachment: true, entries: snapshotRows([{ id: "reasoning", role: "reasoning", content: "private thought" }]) }, "alice", 80), []);
});

test("{§cli-log-entry-line-format}: history retains the same structured failure explanation as live rows", () => {
    assert.deepEqual(renderHistory({ attachment: false, entries: [
        entry({ op: "brave", status_rx: 502, tx: { target: { kind: "local", raw: "brave_web_search" } },
            rx: { status: 502, problem: { type: "https://problems.plurnk.xyz/executor/mcp/tool-reported-error",
                title: "Tool reported error", status: 502, diagnostic: "No web results found" } } }),
    ] }, "alice", 80), ["⚙️ brave (brave_web_search) — Tool reported error: No web results found"]);
});
