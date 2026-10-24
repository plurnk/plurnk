// Client-side Markdown projection (plurnk#15, plurnk#177): tables, fences, LaTeX math,
// and Mermaid project for the terminal; wire text stays semantic/raw. NO_COLOR keeps
// assertions ANSI-free.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Script } from "node:vm";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";

process.env.NO_COLOR = "1";
const { displayWidth, renderMarkdownDocument, renderMermaid } = await import("./markdown.ts");

const nativeTheme: MarkdownTheme = {
    heading: (text) => text, link: (text) => text, linkUrl: (text) => text,
    code: (text) => text, codeBlock: (text) => text, codeBlockBorder: (text) => text,
    quote: (text) => text, quoteBorder: (text) => text, hr: (text) => text,
    listBullet: (text) => text, bold: (text) => text, italic: (text) => text,
    strikethrough: (text) => text, underline: (text) => text,
};

test("[§cli-markdown-adapter] Plurnk's Mermaid override leaves native Markdown instances and their prototype unchanged", () => {
    const source = "```mermaid\ngraph TD\nA[Start] --> B[Finish]\n```";
    const prototype = Object.getOwnPropertyDescriptors(Markdown.prototype);
    const native = () => new Markdown(source, 0, 0, nativeTheme).render(80);
    const before = native();
    const projected = renderMarkdownDocument(source, 80);
    assert.match(projected, /┌/);
    assert.doesNotMatch(projected, /graph TD/);
    assert.deepEqual(native(), before, "unrelated components still show the source as ordinary code");
    assert.deepEqual(Object.getOwnPropertyDescriptors(Markdown.prototype), prototype, "no global method replacement");
});

test("[§cli-markdown-adapter] ordinary Markdown and math retain native parsing and layout", () => {
    for (const source of [
        "Plain words.\nAnother line.", "# A heading with `code` and *emphasis*",
        "*italic*, **bold**, ~~removed~~, and `literal`.", "A $\\leftrightarrow$ B.",
        "```text\n$\\rightarrow$ **not bold**\n```", "> A quote.\n>\n> Another paragraph.",
        "1. Parent\n   - Child\n\n2. Another parent", "| a | b |\n| - | - |\n| c | d |",
    ]) {
        const expected = new Markdown(source, 0, 0, nativeTheme, undefined, { preserveOrderedListMarkers: true, renderLatex: true })
            .render(40).map((line) => line.trimEnd()).join("\n").trimEnd();
        assert.equal(renderMarkdownDocument(source, 40), expected, source);
    }
});

test("{§cli-markdown-projection} pathological layout returns labeled source and leaves later responses usable", () => {
    // An external deadline and heap ceiling contain a regression in the synchronous renderer.
    const result = spawnSync(process.execPath, ["--max-old-space-size=256", "--input-type=module", "-e", `
        import assert from "node:assert/strict";
        import { readFileSync } from "node:fs";
        import TurnDisplay from ${JSON.stringify(new URL("./turn.ts", import.meta.url).href)};
        import { displayWidth } from ${JSON.stringify(new URL("./markdown.ts", import.meta.url).href)};
        const source = readFileSync(${JSON.stringify(new URL("../test/fixtures/mermaid-fan-in.md", import.meta.url).pathname)}, "utf8");
        const row = (raw) => ({
            message: { id: "1/1/1", role: "assistant" },
            id: 1, loop_seq: 1, turn_seq: 1, sequence: 1, op: "SEND", origin: "model",
            signal: null, target: null, lineMarker: null,
            tx: { body: { raw } }, rx: { status: 200, answers: ["acp://anonymous/threads/t/messages/m1"] }, status_rx: 200, tags: [],
        });
        const view = new TurnDisplay();
        view.addResponse(row(source));
        const first = view.render(135);
        assert.match(first.join("\\n"), /mermaid — diagram failed to render/);
        assert.ok(first.every((line) => displayWidth(line) <= 135));
        const renderedSource = first.slice(first.findIndex((line) => line.startsWith("│ "))).map((line) => line.replace(/^│ ?/u, "")).join("\\n");
        assert.equal(renderedSource.trimEnd(), source.split("\\n").slice(1, -2).join("\\n"));
        for (let index = 0; index < 5; index++) assert.deepEqual(view.render(135), first);
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
    assert.deepEqual(out.split("\n"), [
        "2. Addressable Context: Everything in the agent environment is an addressable URI resource:",
        "    * file:/// / project relative paths: Local project source code.",
        "    * worker:///: Extended worker context and sub-worker communication.",
    ]);
    assert.ok(out.split("\n").every((line) => displayWidth(line) <= 135));
});

for (const [name, block, body] of [
    ["code", "  ```js\n  console.log(42);\n  ```", "console.log(42);"],
    ["quotation", "  > A nested quotation.", "│ A nested quotation."],
    ["numbered list", "  1. A nested numbered item.", "1. A nested numbered item."],
] as const) {
    test(`[§cli-markdown-projection] list text does not absorb a nested ${name}`, () => {
        const out = renderMarkdownDocument(`- Parent paragraph.\n${block}`, 40);
        const lines = out.split("\n");
        assert.match(lines[0]!, /^[-*] Parent paragraph\.$/);
        assert.ok(lines.slice(1).some((line) => line.trim() === body && line.startsWith("  ")),
            `the complete nested ${name} starts on its own indented line: ${out}`);
        assert.ok(out.split("\n").every((line) => displayWidth(line) <= 40));
    });
}

test("[§cli-markdown-projection] long code and fallback source wrap without losing content", () => {
    const code = "abcdefghijklmnopqrstuvwxyz".repeat(4);
    for (const language of ["text", "mermaid"]) {
        const out = renderMarkdownDocument(`\`\`\`${language}\n${code}\n\`\`\``, 32);
        const lines = out.split("\n");
        assert.ok(lines.every((line) => displayWidth(line) <= 32));
        assert.ok(lines[0]!.startsWith(language === "text" ? "```text" : "💻 mermaid"));
        const firstBodyLine = lines.findIndex((line) => line.replace(/^(?:│ ?|  )/u, "").startsWith("abc"));
        assert.ok(firstBodyLine > 0, "the complete source follows its header");
        const body = lines.slice(firstBodyLine, language === "text" ? -1 : undefined);
        assert.equal(body.map((line) => line.replace(/^(?:│ ?|  )/u, "")).join(""), code, "every source character survives wrapping");
    }
});

test("{§cli-markdown-projection} wrapped code retains literal words and its surrounding document", () => {
    const code = "Every word here remains literal even when the line wraps and **bold** is just code.";
    const lines = renderMarkdownDocument(`# Before\n\n- Parent\n  \`\`\`text\n  ${code}\n  \`\`\`\n\nAfter.`, 35).split("\n");
    assert.ok(lines.every((line) => displayWidth(line) <= 35));
    const opening = lines.indexOf("  ```text");
    const closing = lines.indexOf("  ```");
    assert.ok(opening > 0 && closing > opening);
    assert.deepEqual(lines.slice(0, opening), ["Before", "", "- Parent"]);
    assert.equal(lines.slice(opening + 1, closing).map((line) => line.trim()).join(" "), code);
    assert.deepEqual(lines.slice(closing + 1), ["", "After."]);
});

test("[§cli-markdown-adapter] nested Mermaid uses the actual block width before choosing its layout", () => {
    const source = "graph LR\nA[First]-->B[Second]";
    const horizontal = renderMermaid(source, 80);
    const width = Math.max(...horizontal.map(displayWidth));
    const fence = `\`\`\`mermaid\n${source}\n\`\`\``;
    for (const [prefix, leading] of [["", ""], ["> ", ""], ["  ", "- Parent\n\n"], ["  > ", "- Parent\n\n"]]) {
        const document = leading + fence.split("\n").map((line) => prefix + line).join("\n");
        const lines = renderMarkdownDocument(document, width).split("\n");
        const container = prefix.replace(">", "│");
        const diagram = lines.slice(leading ? 2 : 0);
        const expected = renderMermaid(source, width - container.length);
        assert.doesNotMatch(expected.join("\n"), /💻 mermaid/);
        assert.deepEqual(diagram, expected.map((line) => (container + line).trimEnd()));
        assert.ok(lines.every((line) => displayWidth(line) <= width));
        if (container) assert.notDeepEqual(expected, horizontal, "container indentation forces the alternate layout");
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
    assert.ok(out.some((line) => /^│ ┌.*┐$/.test(line)), "the table border stays intact inside the quotation");
    assert.ok(out.includes("│ ---"), "the rule remains inside the quotation");
    const description = out.filter((line) => line.startsWith("│ │") && !line.includes("Description"))
        .map((line) => line.split("│")[3]?.trim() ?? "").filter(Boolean).join(" ");
    assert.equal(description, "Every word in this table remains present.");
});

test("[§cli-markdown-projection] GFM task lists project each checkbox exactly once", () => {
    const out = renderMarkdownDocument([
        "- [x] Boot the terminal",
        "- [x] Render headings",
        "- [ ] Convince yourself it's real",
    ].join("\n"), 80);
    assert.deepEqual(out.split("\n"), [
        "- [x] Boot the terminal", "- [x] Render headings", "- [ ] Convince yourself it's real",
    ]);
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
        "    C -- \"ACP+ (sole client surface)\" --> D[plurnk-service daemon]",
        "    D --> W[(real workspaces)]",
        "    D --> M[model loop]",
    ].join("\n"));
    assert.doesNotMatch(out.join("\n"), /💻 mermaid/, "valid standard Mermaid must not fall back to source");
    assert.match(out.join("\n"), /You at the terminal/);
    assert.match(out.join("\n"), /ACP\+/);
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
    const drawn = Math.min(...[source, source.replace("flowchart TB", "flowchart LR")].map((attempt) => Math.max(...renderMermaid(attempt, 1000).map(displayWidth))));
    assert.equal(tooNarrow[0], `💻 mermaid — rendered width ${drawn} exceeds 10`, "the fallback names the narrower attempt's width and the viewport's");
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
    assert.equal(out, [
        "Title", "", "Introductory prose before the table.", "",
        renderMarkdownDocument("| Operation | Purpose |\n| --- | --- |\n| FIND | locate paths |\n| READ | inspect content |", 80),
        "", ...renderMermaid("graph LR\n  a[Author] --> b[Reviewer]", 80),
        "", "Trailing prose after the diagram.",
    ].join("\n"));
});
