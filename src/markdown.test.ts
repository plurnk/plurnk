// Client-side Markdown projection (plurnk#15): tables, fences, and Mermaid
// project for the terminal; the wire stays semantic/raw. NO_COLOR keeps the
// assertions ANSI-free.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NO_COLOR = "1";
const { renderMarkdownDocument, renderTable, renderMermaid, parseMermaidFlowchart, looksLikeMarkdown, WIDTH_TARGET } = await import("./markdown.ts");

test("[§cli-markdown-projection] a pipe table projects as aligned box-drawn columns", () => {
    const out = renderTable([
        "| Name | Role |",
        "| --- | --- |",
        "| ada | engineer |",
        "| bo | ops |",
    ]);
    assert.deepEqual(out, [
        "┌──────┬──────────┐",
        "│ Name │ Role     │",
        "├──────┼──────────┤",
        "│ ada  │ engineer │",
        "│ bo   │ ops      │",
        "└──────┴──────────┘",
    ]);
});

test("[§cli-markdown-projection] a wide table shrinks its widest columns to the 80-column target with cell truncation", () => {
    const wide = "x".repeat(120);
    const out = renderTable([
        `| Key | ${wide} |`,
        "| --- | --- |",
        `| a | ${wide} |`,
    ]);
    for (const line of out) {
        assert.ok(line.length <= WIDTH_TARGET, `line within the target: ${line.length}`);
    }
    assert.match(out[3]!, /…/, "over-budget cells truncate visibly");
});

test("[§cli-markdown-projection] a fenced block renders as a labeled gutter without inline styling", () => {
    const out = renderMarkdownDocument("before\n```json\n{\"a\": **1**}\n```\nafter");
    assert.deepEqual(out.split("\n"), [
        "before",
        "◇ json",
        "│ {\"a\": **1**}",
        "after",
    ], "fence bodies stay verbatim — no markdown applied inside");
});

test("[§cli-markdown-projection] a simple Mermaid chain projects as vertical boxes with labeled arrows", () => {
    const out = renderMermaid([
        "graph TD",
        "  start[Start] -->|yes| work[Do the work]",
        "  work --> done[Done]",
    ].join("\n"));
    assert.deepEqual(out, [
        "┌───────┐",
        "│ Start │",
        "└───────┘",
        "    │ yes",
        "    ▼",
        "┌─────────────┐",
        "│ Do the work │",
        "└─────────────┘",
        "       │",
        "       ▼",
        "┌──────┐",
        "│ Done │",
        "└──────┘",
    ]);
});

test("[§cli-markdown-projection] a branching Mermaid graph projects as a labeled edge list, never a half-drawn diagram", () => {
    const out = renderMermaid([
        "flowchart LR",
        "  a[Gate] -->|pass| b[Ship]",
        "  a -->|fail| c[Fix]",
        "  c --> a",
    ].join("\n"));
    assert.equal(out[0], "◇ mermaid graph");
    assert.deepEqual(out.slice(1), [
        "  Gate ─▶ Ship (pass)",
        "  Gate ─▶ Fix (fail)",
        "  Fix ─▶ Gate",
    ]);
});

test("[§cli-markdown-projection] non-flowchart Mermaid falls back to its verbatim source under a mermaid gutter", () => {
    const source = "sequenceDiagram\n  A->>B: hi";
    const out = renderMermaid(source);
    assert.deepEqual(out, ["◇ mermaid", "│ sequenceDiagram", "│   A->>B: hi"]);
    assert.equal(parseMermaidFlowchart(source), null);
});

test("[§cli-markdown-projection] the document projector composes prose, tables, and mermaid fences", () => {
    const out = renderMarkdownDocument([
        "# Result",
        "The **plan**:",
        "",
        "| a | b |",
        "| - | - |",
        "| 1 | 2 |",
        "",
        "```mermaid",
        "graph TD",
        "  x[One] --> y[Two]",
        "```",
    ].join("\n"));
    const lines = out.split("\n");
    assert.equal(lines[0], "Result", "heading renders without the #");
    assert.match(out, /│ a │ b │/);
    assert.match(out, /│ One │/);
    assert.match(out, /▼/);
    assert.equal(looksLikeMarkdown("| a | b |\n| - | - |"), true, "a bare table is markdown enough");
});
