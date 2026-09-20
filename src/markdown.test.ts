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
    assert.match(out, /^💻 json$/m, "the code glyph and language are separated by one space");
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

test("[§cli-markdown-projection] a nested list starts below its parent and retains every word", () => {
    const out = renderMarkdownDocument([
        "2. **Addressable Context**: Everything in the agent environment is an addressable URI resource:",
        "   * `file:///` / project relative paths: Local project source code.",
        "   * `worker:///`: Extended worker context and sub-worker communication.",
    ].join("\n"), 135);
    assert.deepEqual(out.split("\n"), [
        "2. Addressable Context: Everything in the agent environment is an addressable URI resource:",
        "   * file:/// / project relative paths: Local project source code.",
        "   * worker:///: Extended worker context and sub-worker communication.",
    ]);
    assert.ok(out.split("\n").every((line) => displayWidth(line) <= 135));
});

for (const [name, block, expected] of [
    ["code", "  ```js\n  console.log(42);\n  ```", "  💻 js\n  │ console.log(42);"],
    ["quotation", "  > A nested quotation.", "  │ A nested quotation."],
    ["numbered list", "  1. A nested numbered item.", "  1. A nested numbered item."],
] as const) {
    test(`[§cli-markdown-projection] list text does not absorb a nested ${name}`, () => {
        const out = renderMarkdownDocument(`- Parent paragraph.\n${block}`, 40);
        assert.equal(out, `* Parent paragraph.\n${expected}`);
        assert.ok(out.split("\n").every((line) => displayWidth(line) <= 40));
    });
}

test("[§cli-markdown-projection] long code and fallback source wrap without losing content", () => {
    const code = "abcdefghijklmnopqrstuvwxyz".repeat(4);
    for (const language of ["text", "mermaid"]) {
        const out = renderMarkdownDocument(`\`\`\`${language}\n${code}\n\`\`\``, 32);
        const lines = out.split("\n");
        assert.equal(lines[0], `💻 ${language}`);
        assert.ok(lines.every((line) => displayWidth(line) <= 32));
        // Every row of a block carries the gutter, wrapped rows included ({§cli-markdown-projection}).
        assert.ok(lines.slice(1).filter((line) => line.length > 0).every((line) => line.startsWith("│ ")));
        assert.equal(lines.slice(1).map((line) => line.replace(/^│ /u, "")).join(""), code);
    }
});

// The operator's report (#96): a reply whose code block holds a line wider than the terminal
// rendered with the gutter on its first row only, so every continuation sat at column zero.
test("[§cli-markdown-projection] a wrapped code line keeps its gutter, and prose around it stays prose", () => {
    const sentence = "Whether searching a codebase, inspecting targeted lines, or applying precise diffs, the model interacts through one grammar.";
    const out = renderMarkdownDocument([
        "Syntax:", "", "```text", sentence, "```", "", "### A heading after", "* a list item",
    ].join("\n"), 48).split("\n");

    const opens = out.indexOf("💻 text") + 1;
    const block = out.slice(opens, out.findIndex((line, index) => index >= opens && !line.startsWith("│ ")));
    assert.ok(block.length > 1, "the sentence must have wrapped for this witness to mean anything");
    assert.ok(block.every((line) => line.startsWith("│ ")), "every wrapped row carries the gutter");
    assert.ok(out.every((line) => displayWidth(line) <= 48), "the gutter is inside the viewport, not past it");
    assert.equal(block.map((line) => line.replace(/^│ /u, "")).join(" "), sentence);
    assert.ok(out.includes("* a list item"), "prose after the block is still prose");
});

test("[§cli-markdown-projection] nested tables and rules reserve their container indentation", () => {
    const out = renderMarkdownDocument([
        "> | Name | Description |",
        "> | --- | --- |",
        "> | Example | Every word in this table remains present. |",
        ">",
        "> ---",
    ].join("\n"), 48).split("\n");
    assert.ok(out.every((line) => displayWidth(line) <= 48));
    assert.ok(out.some((line) => /^│ ┌.*┐$/.test(line)), "the table border stays intact inside the quotation");
    assert.ok(out.includes(`│ ${"─".repeat(46)}`), "the rule fits inside the quotation");
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
    assert.doesNotMatch(out.join("\n"), /💻 mermaid/);
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
    assert.doesNotMatch(out.join("\n"), /💻 mermaid/);
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
    assert.doesNotMatch(out.join("\n"), /💻 mermaid/, "valid standard Mermaid must not fall back to source");
    assert.match(out.join("\n"), /You at the terminal/);
    assert.match(out.join("\n"), /AG-UI\+/);
    assert.ok(out.every((line) => displayWidth(line) <= 80), "the projected diagram fits the supplied viewport");
});

test("[§cli-markdown-projection] standard sequence diagrams also project for the terminal", () => {
    const source = "sequenceDiagram\n  A->>B: hi";
    const out = renderMermaid(source);
    assert.doesNotMatch(out.join("\n"), /💻 mermaid/);
    assert.match(out.join("\n"), /A/);
    assert.match(out.join("\n"), /B/);
    assert.match(out.join("\n"), /hi/);
});

test("[§cli-markdown-projection] invalid Mermaid quietly projects its source as a code block", () => {
    const source = "notMermaid\n  A->>B: hi";
    assert.deepEqual(renderMermaid(source), ["💻 mermaid", "│ notMermaid", "│   A->>B: hi"]);
});

for (const direction of ["TD", "TB", "BT"]) {
    test(`[§cli-markdown-projection] a wide ${direction} fan-out tries horizontal layout without losing labels or edges`, () => {
        const body = [
            "    root[Project documentation] --> a[Language contract]",
            "    root --> b[Public APIs]",
            "    root --> c[Configuration]",
            "    root --> d[Verification]",
            "    a --> aa[Describe language syntax and recovery behavior]",
            "    b --> bb[Document stable interfaces and their guarantees]",
            "    c --> cc[Explain environment layering and sensible defaults]",
            "    d --> dd[Cover behavior boundaries and regression cases]",
        ].join("\n");
        const source = `graph ${direction}\n${body}`;
        const authored = renderMermaid(source, 1000);
        assert.ok(authored.some((line) => displayWidth(line) > 132), "the authored fan-out really exceeds the viewport");
        assert.deepEqual(renderMermaid(source, Math.max(...authored.map(displayWidth))), authored, "an exactly fitting viewport preserves the authored layout");
        const horizontal = renderMermaid(`graph LR\n${body}`, 1000);
        assert.ok(horizontal.every((line) => displayWidth(line) <= 132), "the alternate layout fits");
        assert.deepEqual(renderMermaid(source, 132), horizontal, "the complete alternate diagram survives, not its source");
    });
}

for (const direction of ["LR", "RL"]) {
    test(`[§cli-markdown-projection] a wide ${direction} chain still tries vertical layout`, () => {
        const body = "a[First stage of the process] --> b[Second stage of the process] --> c[Final stage of the process]";
        const source = `flowchart ${direction}\n${body}`;
        const authored = renderMermaid(source, 1000);
        assert.ok(authored.some((line) => displayWidth(line) > 60));
        const vertical = renderMermaid(`flowchart TD\n${body}`, 1000);
        assert.ok(vertical.every((line) => displayWidth(line) <= 60));
        assert.deepEqual(renderMermaid(source, 60), vertical);
    });
}

test("[§cli-markdown-projection] alternate layout transposes explicit subgraph directions too", () => {
    const body = [
        "subgraph details[Details]",
        "    direction TB",
        "    root[Root] --> a[First detailed topic]",
        "    root --> b[Second detailed topic]",
        "    root --> c[Third detailed topic]",
        "    root --> d[Fourth detailed topic]",
        "end",
    ].join("\n");
    const source = `flowchart TB\n${body}`;
    const authored = renderMermaid(source, 1000);
    assert.ok(authored.some((line) => displayWidth(line) > 70));
    const horizontal = renderMermaid(`flowchart LR\n${body.replace("direction TB", "direction LR")}`, 1000);
    assert.ok(horizontal.every((line) => displayWidth(line) <= 70));
    assert.deepEqual(renderMermaid(source, 70), horizontal);
    assert.deepEqual(renderMermaid(source.replaceAll("\n", "\r\n"), 70), horizontal, "CRLF source follows the same fallback");
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
    const tooNarrow = renderMermaid(source, 10);
    assert.equal(tooNarrow[0], "💻 mermaid");
    assert.deepEqual(tooNarrow.slice(1), source.split("\n").map((line) => `│ ${line}`), "source fallback remains verbatim when neither orientation fits");
    const narrow = renderMermaid(source, 120);
    assert.doesNotMatch(narrow.join("\n"), /💻 mermaid/);
    assert.ok(narrow.every((line) => displayWidth(line) <= 120));
    const roomy = renderMermaid(source, 140);
    assert.doesNotMatch(roomy.join("\n"), /💻 mermaid/);
    assert.ok(roomy.every((line) => displayWidth(line) <= 140));
    assert.deepEqual(roomy, renderMermaid(source, 1000), "do not rotate an authored layout that already fits");
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

test("[§cli-markdown-projection] admission recognizes the same structural GFM in both clients", () => {
    assert.equal(looksLikeMarkdown("1. first\n2. second"), true, "ordered lists are structural Markdown");
    assert.equal(looksLikeMarkdown("~~~json\n{}\n~~~"), true, "tilde fences are structural Markdown");
    assert.equal(looksLikeMarkdown("An ordinary sentence."), false, "ordinary prose stays ordinary prose");
});
