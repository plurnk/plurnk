import test from "node:test";
import assert from "node:assert/strict";
import { renderHistory, renderRows } from "./render-history.ts";
import type { LogEntryWire } from "./render.ts";
import { snapshotRows } from "./rows.ts";

process.env.NO_COLOR = "1";
const entry = (overrides: Partial<LogEntryWire>): LogEntryWire => ({
    id: 1, origin: "model", op: "READ", signal: null,
    target: null, lineMarker: null, status_rx: 200, tx: null,
    rx: null, loop_seq: 1, turn_seq: 1, sequence: 1, ...overrides,
});

test("{§cli-broadcast-send-rendering}: qualified attachment preserves standard speech addressed under earlier thread spellings", () => {
    for (const source of ["acp://operator/threads/alice/messages/m1", "acp://operator/threads/opaque-uuid/messages/m1"]) {
        const rows = snapshotRows([{ id: "1/1/1", role: "assistant", content: "Retained answer", metadata: { plurnk: {
            id: 1, coordinate: "1/1/1", worker: 7, origin: "model", op: "SEND", source: null, address: null,
            signal: 200, status: 200, attrs: {}, receipt: { status: 200, answers: [source], completion: 200 },
        } } }]);
        assert.deepEqual(renderHistory({ attachment: true, accepted: new Map(), entries: rows }, "42#alice", 80),
            ["🐹\nRetained answer"]);
    }
});

// plurnk-service {§acp-status-descendants}: the bound worker's tree names each descendant and its generation.
test("[§cli-worker-history] a descendant's rows are drawn as quietly as the bound worker's, marked and stepped in by generation", () => {
    const tree = new Map([[8, { workerId: 8, name: "helper", parentWorkerId: 7, depth: 1 }], [9, { workerId: 9, name: "digger", parentWorkerId: 8, depth: 2 }]]);
    const rows = [
        entry({ id: 1, worker_id: 7, target: "a.md", pathname: "/a.md" } as Partial<LogEntryWire>),
        entry({ id: 2, worker_id: 8, origin: "_plurnk", op: "SEND", source: "worker://main", attrs: { kind: "message" }, tx: { body: { raw: "Look into it." } } } as Partial<LogEntryWire>),
        entry({ id: 3, worker_id: 8, target: "b.md", pathname: "/b.md" } as Partial<LogEntryWire>),
        entry({ id: 4, worker_id: 9, target: "c.md", pathname: "/c.md" } as Partial<LogEntryWire>),
        entry({ id: 5, worker_id: 8, op: "SEND", signal: 200, tx: { body: { raw: "Found it." } } } as Partial<LogEntryWire>),
    ];
    const [own, asked, read, deeper, replied] = renderRows(rows, "main", 80, true, tree);
    assert.doesNotMatch(own ?? "", /🐜/u, "the bound worker's own row carries no mark");
    assert.match(asked ?? "", /^ {2}🐜 helper \S+ \(worker:\/\/main\)\n {2}Look into it\.$/u, "a descendant's arrival: its sender, then its words, one step in");
    assert.match(read ?? "", /^ {2}🐜 helper [^\n]*b\.md/u, "a descendant's operation: its heading, one step in");
    assert.match(deeper ?? "", /^ {4}🐜 digger [^\n]*c\.md/u, "a grandchild steps in once more");
    assert.match(replied ?? "", /^ {2}🐜 helper [^\n]*\n {2}Found it\.$/u, "a descendant's reply keeps its words whole, as the bound worker's do");
    assert.deepEqual(renderRows(rows, "main", 80, true), renderRows(rows, "main", 80, true, new Map()), "without a tree, every row is drawn as its own");
});

test("[§cli-worker-history] a snapshot's prompt, operation headings and speech keep their row order; its reasoning is never replayed", () => {
    const source = "acp://anonymous/threads/alice/messages/prompt";
    const facts = (id: number, over: Record<string, unknown> = {}) => ({ plurnk: { id, coordinate: `1/1/${id}`, worker: 7, origin: "model", op: "READ",
        source: null, address: null, signal: null, status: 200, attrs: {}, ...over } });
    const rows = snapshotRows([
        { id: "prompt", role: "user", content: "snapshot prompt\nsecond line", metadata: facts(1, { origin: "_plurnk", op: "SEND", source, attrs: { kind: "message" } }) },
        { id: "1/1/2", role: "assistant", toolCalls: [{ id: "1/1/2", type: "function",
            function: { name: "READ", arguments: JSON.stringify({ target: { kind: "local", raw: "a.md" } }) }, metadata: facts(2, { address: "a.md" }) }] },
        { id: "1/1/2/result", role: "tool", toolCallId: "1/1/2", content: JSON.stringify({ status: 200 }) },
        { id: "1/1/3/reasoning", role: "reasoning", content: "OLD_REASONING_NOT_REPLAYED" },
        { id: "1/1/3", role: "assistant", content: "snapshot answer",
            metadata: { plurnk: { ...facts(3, { op: "SEND" }).plurnk, aside: null, receipt: { status: 200, answers: [source], completion: 200 } } } },
    ]);
    assert.deepEqual(renderHistory({ attachment: true, accepted: new Map(), entries: rows }, "alice", 80),
        ["› snapshot prompt\n  second line", "📖 (a.md)", "🐹\nsnapshot answer"]);
});

test("{§cli-worker-history}: another actor's message keeps its sender, an answer its words, and a materialization draws nothing", () => {
    assert.deepEqual(renderHistory({ attachment: false, accepted: new Map(), entries: [
        entry({ id: 1, op: "SEND", origin: "_plurnk", source: "worker://helper", attrs: { kind: "message" }, tx: { body: "worker update" } }),
        entry({ id: 2, op: "SEND", message: { id: "1/1/2", role: "assistant" }, rx: { answers: ["acp://anonymous/threads/alice/messages/m1"], completion: 200 }, tx: { body: "recent answer" } }),
        entry({ id: 3, op: "EDIT", origin: "_plurnk", attrs: { kind: "entry_materialized" } }),
    ] }, "alice", 80), ["✉️ (worker://helper)\nworker update", "🐹\nrecent answer"]);
});

test("{§cli-worker-history}: an empty history emits no decorative seam or old reasoning", () => {
    assert.deepEqual(renderHistory({ attachment: true, accepted: new Map(), entries: snapshotRows([{ id: "reasoning", role: "reasoning", content: "private thought" }]) }, "alice", 80), []);
});

test("{§cli-log-entry-line-format}: history retains the same structured failure explanation as live rows", () => {
    assert.deepEqual(renderHistory({ attachment: false, accepted: new Map(), entries: [
        entry({ op: "brave", status_rx: 502, tx: { target: { kind: "local", raw: "brave_web_search" } },
            rx: { status: 502, problem: { type: "https://problems.plurnk.xyz/executor/mcp/tool-reported-error",
                title: "Tool reported error", status: 502, diagnostic: "No web results found" } } }),
    ] }, "alice", 80), ["⚙️ brave (brave_web_search) — Tool reported error: No web results found"]);
});
