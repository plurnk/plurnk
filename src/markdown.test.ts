// Client-side Markdown projection (plurnk#15): tables, fences, and Mermaid
// project for the terminal; the wire stays semantic/raw. NO_COLOR keeps the
// assertions ANSI-free.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NO_COLOR = "1";
const { displayWidth, renderMarkdownDocument, renderTable, renderMermaid, looksLikeMarkdown, WIDTH_TARGET } = await import("./markdown.ts");

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

test("[§cli-markdown-projection] table alignment measures projected inline content", () => {
    const out = renderTable([
        "| Surface | Use |",
        "| --- | --- |",
        "| CLI one-shot | `npx @plurnk/plurnk \"what is 2+2?\"` |",
        "| Interactive TUI | ongoing prompt sessions |",
        "| State commands | inspect and manage session state |",
    ]);
    const widths = out.map(displayWidth);
    assert.equal(new Set(widths).size, 1, `every border must align after inline Markdown projects: ${widths.join(", ")}`);
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

test("[§cli-markdown-projection] a simple Mermaid chain projects as a bounded diagram", () => {
    const out = renderMermaid([
        "graph TD",
        "  start[Start] -->|yes| work[Do the work]",
        "  work --> done[Done]",
    ].join("\n"));
    assert.doesNotMatch(out.join("\n"), /◇ mermaid/);
    assert.match(out.join("\n"), /Start/);
    assert.match(out.join("\n"), /yes/);
    assert.match(out.join("\n"), /Do the work/);
    assert.match(out.join("\n"), /Done/);
    assert.ok(out.every((line) => displayWidth(line) <= WIDTH_TARGET));
});

test("[§cli-markdown-projection] a branching Mermaid graph retains its topology and labels", () => {
    const out = renderMermaid([
        "flowchart LR",
        "  a[Gate] -->|pass| b[Ship]",
        "  a -->|fail| c[Fix]",
        "  c --> a",
    ].join("\n"));
    assert.doesNotMatch(out.join("\n"), /◇ mermaid/);
    assert.match(out.join("\n"), /Gate/);
    assert.match(out.join("\n"), /pass/);
    assert.match(out.join("\n"), /Ship/);
    assert.match(out.join("\n"), /fail/);
    assert.match(out.join("\n"), /Fix/);
    assert.ok(out.every((line) => displayWidth(line) <= WIDTH_TARGET));
});

test("[§cli-markdown-projection] standard Mermaid edge labels render within the terminal width", () => {
    const out = renderMermaid([
        "flowchart LR",
        "    U[You at the terminal] --> C[plurnk client<br/>CLI · TUI · state commands]",
        "    C -- \"AG-UI+ (sole client surface)\" --> D[plurnk-service daemon]",
        "    D --> W[(real workspaces)]",
        "    D --> M[model loop]",
    ].join("\n"));
    assert.doesNotMatch(out.join("\n"), /◇ mermaid/, "valid standard Mermaid must not fall back to source");
    assert.match(out.join("\n"), /You at the terminal/);
    assert.match(out.join("\n"), /AG-UI\+/);
    assert.ok(out.every((line) => displayWidth(line) <= WIDTH_TARGET), "the projected diagram fits the terminal target");
});

test("[§cli-markdown-projection] standard sequence diagrams also project for the terminal", () => {
    const source = "sequenceDiagram\n  A->>B: hi";
    const out = renderMermaid(source);
    assert.doesNotMatch(out.join("\n"), /◇ mermaid/);
    assert.match(out.join("\n"), /A/);
    assert.match(out.join("\n"), /B/);
    assert.match(out.join("\n"), /hi/);
});

test("[§cli-markdown-projection] invalid Mermaid falls back to its verbatim source under a mermaid gutter", () => {
    const source = "notMermaid\n  A->>B: hi";
    assert.deepEqual(renderMermaid(source), ["◇ mermaid", "│ notMermaid", "│   A->>B: hi"]);
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
    assert.match(out, /│\s*One\s*│/);
    assert.match(out, /▼/);
    assert.equal(looksLikeMarkdown("| a | b |\n| - | - |"), true, "a bare table is markdown enough");
});
