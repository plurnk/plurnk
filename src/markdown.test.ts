// Client-side Markdown projection (plurnk#15): tables, fences, and Mermaid
// project for the terminal; the wire stays semantic/raw. NO_COLOR keeps the
// assertions ANSI-free.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NO_COLOR = "1";
const { displayWidth, renderMarkdownDocument, renderMermaid, looksLikeMarkdown } = await import("./markdown.ts");

test("[§cli-markdown-projection] a pipe table projects as aligned box-drawn columns", () => {
    const out = renderMarkdownDocument([
        "| Name | Role |",
        "| --- | --- |",
        "| ada | engineer |",
        "| bo | ops |",
    ].join("\n")).split("\n");
    assert.deepEqual(out, [
        "┌──────┬──────────┐",
        "│ Name │ Role     │",
        "├──────┼──────────┤",
        "│ ada  │ engineer │",
        "├──────┼──────────┤",
        "│ bo   │ ops      │",
        "└──────┴──────────┘",
    ]);
});

test("[§cli-markdown-projection] a wide table wraps complete cells within the supplied screen width", () => {
    const prose = "Every word survives while mature table machinery wraps the cell across physical rows.";
    const out = renderMarkdownDocument([
        "| Key | Description |",
        "| --- | --- |",
        `| a | ${prose} |`,
        "| b | short |",
    ].join("\n"), 48).split("\n");
    for (const line of out) {
        assert.ok(displayWidth(line) <= 48, `line within the supplied screen width: ${displayWidth(line)}`);
    }
    assert.doesNotMatch(out.join("\n"), /…/, "wrapping must not discard table content");
    const description = out
        .filter((line) => line.startsWith("│") && !line.includes("Description"))
        .map((line) => line.split("│")[2]?.trim() ?? "")
        .filter((cell) => cell.length > 0 && cell !== "short")
        .join(" ");
    assert.equal(description, prose, "every cell word remains present");
    assert.equal(out.filter((line) => line.startsWith("├")).length, 2, "every logical row has a horizontal separator");
});

test("[§cli-markdown-projection] table alignment measures projected inline content", () => {
    const out = renderMarkdownDocument([
        "| Surface | Use |",
        "| --- | --- |",
        "| CLI one-shot | `npx @plurnk/plurnk \"what is 2+2?\"` |",
        "| Interactive TUI | ongoing prompt sessions |",
        "| State commands | inspect and manage session state |",
    ].join("\n")).split("\n");
    const widths = out.map(displayWidth);
    assert.equal(new Set(widths).size, 1, `every border must align after inline Markdown projects: ${widths.join(", ")}`);
});

test("[§cli-markdown-projection] an unbroken table value hard-wraps without truncation", () => {
    const value = `https://example.com/${"abcdefghij".repeat(8)}`;
    const out = renderMarkdownDocument([
        "| Kind | Value |",
        "| --- | --- |",
        `| URL | ${value} |`,
    ].join("\n"), 48).split("\n");
    assert.ok(out.every((line) => displayWidth(line) <= 48));
    assert.doesNotMatch(out.join("\n"), /…/);
    const projected = out
        .filter((line) => line.startsWith("│") && !line.includes("Value"))
        .map((line) => line.split("│")[2]?.trim() ?? "")
        .join("");
    assert.equal(projected, value);
});

test("[§cli-markdown-projection] a fenced block uses the terminal renderer without styling its body as Markdown", () => {
    const out = renderMarkdownDocument("before\n```json\n{\"a\": **1**}\n```\nafter");
    assert.match(out, /\{\"a\": \*\*1\*\*\}/, "fence bodies stay verbatim — no Markdown applies inside");
    assert.doesNotMatch(out, /<pre>|<code>/, "the terminal renderer never leaks HTML projection");
});

test("[§cli-markdown-projection] list prose wraps within the supplied screen width", () => {
    const out = renderMarkdownDocument(
        "- Every word in this deliberately long list item remains visible within the terminal viewport.",
        40,
    );
    assert.ok(out.split("\n").every((line) => displayWidth(line) <= 40));
    assert.equal(out.replace(/^\* /, "").replace(/\n  /g, " "),
        "Every word in this deliberately long list item remains visible within the terminal viewport.");
});

test("[§cli-markdown-projection] GFM task lists project each checkbox exactly once", () => {
    const out = renderMarkdownDocument([
        "- [x] Boot the terminal",
        "- [x] Render headings",
        "- [ ] Convince yourself it's real",
    ].join("\n"), 80);
    assert.equal(out, [
        "* [x] Boot the terminal",
        "* [x] Render headings",
        "* [ ] Convince yourself it's real",
    ].join("\n"));
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
    assert.ok(out.every((line) => displayWidth(line) <= 80));
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
    assert.ok(out.every((line) => displayWidth(line) <= 80));
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
    assert.ok(out.every((line) => displayWidth(line) <= 80), "the projected diagram fits the supplied viewport");
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
    assert.deepEqual(renderMermaid(source), ["◇ mermaid source — unsupported or invalid", "│ notMermaid", "│   A->>B: hi"]);
});

test("[§cli-markdown-projection] Mermaid admission follows the supplied viewport rather than a fixed width", () => {
    const source = [
        "flowchart TB",
        "root[Root] --> a[Alpha surface]",
        "root --> b[Bravo surface]",
        "root --> c[Charlie surface]",
        "root --> d[Delta surface]",
        "root --> e[Echo surface]",
        "root --> f[Foxtrot surface]",
        "root --> g[Golf surface]",
        "root --> h[Hotel surface]",
    ].join("\n");
    assert.match(renderMermaid(source, 120)[0]!, /rendered width 129 exceeds 120/);
    const roomy = renderMermaid(source, 140);
    assert.doesNotMatch(roomy.join("\n"), /◇ mermaid source/);
    assert.ok(roomy.every((line) => displayWidth(line) <= 140));
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
