import test from "node:test";
import assert from "node:assert/strict";
import { renderHistory } from "./render-history.ts";
import type { LogEntryWire } from "./render.ts";

process.env.NO_COLOR = "1";
const entry = (overrides: Partial<LogEntryWire>): LogEntryWire => ({
    id: 1, origin: "model", op: "READ", signal: null, scheme: null, hostname: null,
    pathname: null, fragment: null, lineMarker: null, status_rx: 200, tx: null,
    rx: null, tags: [], loop_seq: 1, turn_seq: 1, sequence: 1, ...overrides,
});

test("[§cli-conversation-history] snapshot speech and operation headings retain their chronological row order", () => {
    const source = "agui://anonymous/threads/alice/messages/prompt";
    const blocks = renderHistory({ attachment: true, entries: [
        entry({ id: 1, op: "SEND", origin: "_plurnk", source, attrs: { kind: "message" }, tx: { body: "row prompt" } }),
        entry({ id: 2, op: "READ", pathname: "a.md", tx: { body: "OPERAND_BODY_NOT_REPLAYED" } }),
        entry({ id: 3, op: "SEND", rx: { answers: [source], completion: 200 }, tx: { body: "row answer" } }),
    ], messages: [
        { id: "prompt", role: "user", name: source, content: "snapshot prompt\nsecond line" },
        { id: "3/reasoning", role: "reasoning", content: "OLD_REASONING_NOT_REPLAYED" },
        { id: "3", role: "assistant", content: "snapshot answer" },
    ] }, "alice", 80);
    assert.deepEqual(blocks, ["› snapshot prompt\n  second line", "READ (a.md)", "snapshot answer", "— 3 earlier entries · /log for more —"]);
});

test("{§cli-conversation-history}: rows newer than the snapshot carry their own answer; another actor retains attribution", () => {
    assert.deepEqual(renderHistory({ attachment: false, messages: [], entries: [
        entry({ id: 1, op: "SEND", origin: "_plurnk", source: "worker://helper", attrs: { kind: "message" }, tx: { body: "worker update" } }),
        entry({ id: 2, op: "SEND", rx: { answers: ["agui://anonymous/threads/alice/messages/m1"], completion: 200 }, tx: { body: "recent answer" } }),
        entry({ id: 3, op: "EDIT", origin: "_plurnk", attrs: { kind: "entry_materialized" } }),
    ] }, "alice", 80), ["worker://helper\nworker update", "recent answer"]);
});

test("{§cli-conversation-history}: an empty history emits no decorative seam or old reasoning", () => {
    assert.deepEqual(renderHistory({ attachment: true, entries: [], messages: [
        { id: "reasoning", role: "reasoning", content: "private thought" },
    ] }, "alice", 80), []);
});

test("{§cli-log-entry-line-format}: history retains the same structured failure explanation as live rows", () => {
    assert.deepEqual(renderHistory({ attachment: false, messages: [], entries: [
        entry({ op: "brave", status_rx: 502, tx: { target: { kind: "local", raw: "brave_web_search" } },
            rx: { status: 502, problem: { type: "https://problems.plurnk.xyz/executor/mcp/tool-reported-error",
                title: "Tool reported error", status: 502, diagnostic: "No web results found" } } }),
    ] }, "alice", 80), ["brave (brave_web_search) — Tool reported error: No web results found"]);
});
