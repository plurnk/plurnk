// Client-side Markdown projection (plurnk#15, plurnk#177): tables, fences, LaTeX math,
// and Mermaid project for the terminal; wire text stays semantic/raw. NO_COLOR keeps
// assertions ANSI-free.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Script } from "node:vm";

process.env.NO_COLOR = "1";
const { displayWidth, renderMarkdownDocument, renderMermaid, looksLikeMarkdown } = await import("./markdown.ts");

test("{§cli-markdown-projection} pathological layout returns labeled source and leaves later responses usable", () => {
    // An external deadline and heap ceiling contain a regression in the synchronous renderer.
    const result = spawnSync(process.execPath, ["--max-old-space-size=256", "--input-type=module", "-e", `
        import assert from "node:assert/strict";
        import { readFileSync } from "node:fs";
        import TurnDisplay from ${JSON.stringify(new URL("./turn.ts", import.meta.url).href)};
        import { displayWidth } from ${JSON.stringify(new URL("./markdown.ts", import.meta.url).href)};
        const source = readFileSync(${JSON.stringify(new URL("../test/fixtures/mermaid-fan-in.md", import.meta.url).pathname)}, "utf8");
        const row = (raw) => ({
            id: 1, loop_seq: 1, turn_seq: 1, sequence: 1, op: "SEND", origin: "model",
            signal: null, scheme: null, pathname: null, hostname: null, fragment: null, lineMarker: null,
            tx: { body: { raw } }, rx: { status: 200, answers: ["agui://anonymous/threads/t/messages/m1"] }, status_rx: 200, tags: [],
        });
        const view = new TurnDisplay();
        view.addResponse(row(source));
        const first = view.render(135);
        assert.match(first.join("\\n"), /mermaid — diagram failed to render/);
        assert.ok(first.every((line) => displayWidth(line) <= 135));
        view.addResponse(row("Still responsive."));
        assert.match(view.render(135).join("\\n"), /Still responsive/);
        const archived = view.take();
        assert.match(archived.render(135).join("\\n"), /diagram failed to render/);
        view.addResponse(row("\\x60\\x60\\x60mermaid\\ngraph TD\\nA-->B\\n\\x60\\x60\\x60"));
        assert.doesNotMatch(view.render(135).join("\\n"), /diagram failed to render/);
        console.log("responsive");
    `], { encoding: "utf8", timeout: 4000, killSignal: "SIGKILL", env: { ...process.env, NO_COLOR: "1", PLURNK_CLIENT_MERMAID_TIMEOUT_MS: "1000" } });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "responsive");
});

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
    assert.match(out, /```json/, "code fence preserves language header");
    assert.match(out, /\{\"a\": \*\*1\*\*\}/, "fence bodies stay verbatim — no Markdown applies inside");
    assert.doesNotMatch(out, /<pre>|<code>/, "the terminal renderer never leaks HTML projection");
});

test("[§cli-markdown-projection] list prose wraps within the supplied screen width", () => {
    const out = renderMarkdownDocument(
        "- Every word in this deliberately long list item remains visible within the terminal viewport.",
        40,
    );
    assert.ok(out.split("\n").every((line) => displayWidth(line) <= 40));
    assert.equal(out.replace(/^[-*] /, "").replace(/\n  /g, " "),
        "Every word in this deliberately long list item remains visible within the terminal viewport.");
});

test("[§cli-markdown-projection] a nested list starts below its parent and retains every word", () => {
    const out = renderMarkdownDocument([
        "2. **Addressable Context**: Everything in the agent environment is an addressable URI resource:",
        "   * `file:///` / project relative paths: Local project source code.",
        "   * `worker:///`: Extended worker context and sub-worker communication.",
    ].join("\n"), 135);
    assert.match(out, /2\. Addressable Context/);
    assert.match(out, /file:\/\/\//);
    assert.match(out, /worker:\/\/\//);
    assert.ok(out.split("\n").every((line) => displayWidth(line) <= 135));
});

for (const [name, block] of [
    ["code", "  ```js\n  console.log(42);\n  ```"],
    ["quotation", "  > A nested quotation."],
    ["numbered list", "  1. A nested numbered item."],
] as const) {
    test(`[§cli-markdown-projection] list text does not absorb a nested ${name}`, () => {
        const out = renderMarkdownDocument(`- Parent paragraph.\n${block}`, 40);
        assert.match(out, /Parent paragraph/);
        assert.ok(out.split("\n").every((line) => displayWidth(line) <= 40));
    });
}

test("[§cli-markdown-projection] long code and fallback source wrap without losing content", () => {
    const code = "abcdefghijklmnopqrstuvwxyz".repeat(4);
    for (const language of ["text", "mermaid"]) {
        const out = renderMarkdownDocument(`\`\`\`${language}\n${code}\n\`\`\``, 32);
        const lines = out.split("\n");
        assert.ok(lines.every((line) => displayWidth(line) <= 32));
        assert.match(out, /abcdefgh/);
    }
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
    assert.ok(out.some((line) => /┌.*┐/.test(line)), "the table border stays intact inside the quotation");
});

test("[§cli-markdown-projection] GFM task lists project checkboxes", () => {
    const out = renderMarkdownDocument([
        "- [x] Boot the terminal",
        "- [x] Render headings",
        "- [ ] Convince yourself it's real",
    ].join("\n"), 80);
    assert.match(out, /\[x\] Boot the terminal/);
    assert.match(out, /\[x\] Render headings/);
    assert.match(out, /\[ \] Convince yourself it's real/);
});

test("[§cli-markdown-projection] LaTeX math expressions render as Unicode terminal text (#177)", () => {
    assert.equal(renderMarkdownDocument("The relation is $A \\leftrightarrow B$."), "The relation is A ↔ B.");
    assert.equal(renderMarkdownDocument("Step A $\\rightarrow$ Step B."), "Step A → Step B.");
    assert.equal(renderMarkdownDocument("Step A $\\to$ Step B."), "Step A → Step B.");
    assert.equal(renderMarkdownDocument("When $x \\le y$ and $a \\ge b$."), "When x ≤ y and a ≥ b.");
    assert.equal(renderMarkdownDocument("Greek: $\\alpha + \\beta = \\gamma$."), "Greek: α + β = γ.");
    assert.match(renderMarkdownDocument("Equation:\n$$\nI = \\frac{C_e}{C_a + C_e}\n$$"), /I =[\s\S]*C/);
    assert.equal(renderMarkdownDocument("Currency: $50 and $100."), "Currency: $50 and $100.");
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

test("{§cli-markdown-projection} invalid Mermaid labels its failure and retains the original source", () => {
    const source = "notMermaid\n  A->>B: hi";
    assert.deepEqual(renderMermaid(source), ["💻 mermaid — diagram failed to render", "│ notMermaid", "│   A->>B: hi"]);
});

test("{§cli-markdown-projection} both orientations share the configured execution deadline", (t) => {
    const key = "PLURNK_CLIENT_MERMAID_TIMEOUT_MS";
    const before = process.env[key];
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
    process.env[key] = "1234";
    const bounded = t.mock.method(Script.prototype, "runInNewContext");
    const result = renderMermaid("graph LR\nA[Long first node]-->B[Long second node]", 22);
    assert.doesNotMatch(result.join("\n"), /💻 mermaid/);
    assert.ok(result.every((line) => displayWidth(line) <= 22));
    assert.equal(bounded.mock.callCount(), 1, "rotation must not obtain a second execution budget");
    assert.equal(bounded.mock.calls[0].arguments[1]?.timeout, 1234);
});

test("{§cli-markdown-projection} invalid deadline settings explain the problem without hiding the message", (t) => {
    const key = "PLURNK_CLIENT_MERMAID_TIMEOUT_MS";
    const before = process.env[key];
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
    for (const value of ["0", "-1", "nope", "1.5", ""]) {
        process.env[key] = value;
        const result = renderMarkdownDocument("Before.\n```mermaid\ngraph TD\nA-->B\n```\nAfter.", 160);
        assert.match(result, /diagram failed to render: PLURNK_CLIENT_MERMAID_TIMEOUT_MS must be/);
        assert.match(result, /Before\./);
        assert.match(result, /After\./);
        assert.match(result, /│ A-->B/);
    }
});

for (const direction of ["TD", "TB", "BT"]) {
    test(`[§cli-markdown-projection] a wide ${direction} fan-out tries horizontal layout without losing labels or edges`, () => {
        const source = `graph ${direction}\n  root[Root node] --> a[First detailed topic with a complete label]\n  root --> b[Second detailed topic with a complete label]\n  root --> c[Third detailed topic with a complete label]\n  root --> d[Fourth detailed topic with a complete label]`;
        const out = renderMermaid(source, 80);
        assert.doesNotMatch(out.join("\n"), /💻 mermaid/);
        assert.ok(out.every((line) => displayWidth(line) <= 80));
    });
}

for (const direction of ["LR", "RL"]) {
    test(`[§cli-markdown-projection] a wide ${direction} chain still tries vertical layout`, () => {
        const source = `graph ${direction}\n  a[Step one: input validation] --> b[Step two: database transaction]\n  b --> c[Step three: cache invalidation]\n  c --> d[Step four: notification dispatch]\n  d --> e[Step five: client acknowledgment]`;
        const out = renderMermaid(source, 48);
        assert.doesNotMatch(out.join("\n"), /💻 mermaid/);
        assert.ok(out.every((line) => displayWidth(line) <= 48));
    });
}

test("[§cli-markdown-projection] alternate layout transposes explicit subgraph directions too", () => {
    const source = `flowchart TD\n  subgraph cluster[Cluster]\n    direction TB\n    a[Left topic with full description] --> b[Right topic with full description]\n  end`;
    const out = renderMermaid(source, 60);
    assert.doesNotMatch(out.join("\n"), /💻 mermaid/);
    assert.ok(out.every((line) => displayWidth(line) <= 60));
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
    const doc = [
        "# Title",
        "",
        "Introductory prose before the table.",
        "",
        "| Operation | Purpose |",
        "| --- | --- |",
        "| FIND | locate paths |",
        "| READ | inspect content |",
        "",
        "```mermaid",
        "graph LR",
        "  a[Author] --> b[Reviewer]",
        "```",
        "",
        "Trailing prose after the diagram.",
    ].join("\n");
    const out = renderMarkdownDocument(doc, 80);
    assert.match(out, /Title/);
    assert.match(out, /FIND/);
    assert.match(out, /READ/);
    assert.match(out, /Author/);
    assert.match(out, /Reviewer/);
    assert.match(out, /Trailing prose after the diagram\./);
    assert.doesNotMatch(out, /💻 mermaid/);
});

test("[§cli-markdown-projection] admission recognizes the same structural GFM in both clients", () => {
    assert.equal(looksLikeMarkdown("| a | b |\n| - | - |"), true, "a bare table is markdown enough");
    assert.equal(looksLikeMarkdown("1. first\n2. second"), true, "ordered lists are structural Markdown");
    assert.equal(looksLikeMarkdown("~~~json\n{}\n~~~"), true, "tilde fences are structural Markdown");
    assert.equal(looksLikeMarkdown("An ordinary sentence."), false, "ordinary prose stays ordinary prose");
    assert.equal(looksLikeMarkdown("Relation: $A \\leftrightarrow B$."), true, "inline math is structural markdown");
});
