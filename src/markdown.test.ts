// Client-side Markdown & Mermaid projection tests ({§cli-markdown-projection}, {§cli-color-policy}).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { Script } from "node:vm";
import { Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { withColorOutput } from "./color.ts";
import { displayWidth, renderMarkdownDocument, renderMermaid, renderModelReply } from "./markdown.ts";

const withUnstyledEnv = <T>(fn: () => T): T => {
    const prevColor = process.env.PLURNK_CLIENT_COLOR;
    const prevNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    delete process.env.PLURNK_CLIENT_COLOR;
    try {
        return fn();
    } finally {
        if (prevNoColor === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = prevNoColor;
        if (prevColor === undefined) delete process.env.PLURNK_CLIENT_COLOR;
        else process.env.PLURNK_CLIENT_COLOR = prevColor;
    }
};

const nativeTheme: MarkdownTheme = {
    heading: (text) => text,
    link: (text) => text,
    linkUrl: (text) => text,
    code: (text) => text,
    codeBlock: (text) => text,
    codeBlockBorder: (text) => text,
    quote: (text) => text,
    quoteBorder: (text) => text,
    hr: (text) => text,
    listBullet: (text) => text,
    bold: (text) => text,
    italic: (text) => text,
    strikethrough: (text) => text,
    underline: (text) => text,
};

test("{§cli-markdown-projection} instance-local Mermaid hook leaves native Markdown instances and prototype unchanged", () =>
    withUnstyledEnv(() => {
        const source = "```mermaid\ngraph TD\nA[Start] --> B[Finish]\n```";
        const prototype = Object.getOwnPropertyDescriptors(Markdown.prototype);
        const native = () => new Markdown(source, 0, 0, nativeTheme).render(80);
        const before = native();
        const projected = renderMarkdownDocument(source, 80);
        assert.match(projected, /┌/u);
        assert.doesNotMatch(projected, /graph TD/u);
        assert.deepEqual(native(), before, "unrelated components still show the source as ordinary code");
        assert.deepEqual(
            Object.getOwnPropertyDescriptors(Markdown.prototype),
            prototype,
            "no global method replacement",
        );
    }));

test("{§cli-markdown-projection} ordinary Markdown and LaTeX math retain native parsing and layout", () =>
    withUnstyledEnv(() => {
        for (const source of [
            "Plain words.\nAnother line.",
            "# A heading with `code` and *emphasis*",
            "*italic*, **bold**, ~~removed~~, and `literal`.",
            "A $\\leftrightarrow$ B.",
            "```text\n$\\rightarrow$ **not bold**\n```",
            "> A quote.\n>\n> Another paragraph.",
            "1. Parent\n   - Child\n\n2. Another parent",
            "| a | b |\n| - | - |\n| c | d |",
        ]) {
            const expected = new Markdown(source, 0, 0, nativeTheme, undefined, {
                preserveOrderedListMarkers: true,
                renderLatex: true,
            })
                .render(40)
                .map((line) => line.trimEnd())
                .join("\n")
                .trimEnd();
            assert.equal(renderMarkdownDocument(source, 40), expected, source);
        }
    }));

test("{§cli-markdown-projection} {§cli-color-policy} Markdown links emit OSC 8 hyperlinks only for http(s) when color is enabled", () => {
    const prevColor = process.env.PLURNK_CLIENT_COLOR;
    const prevNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
        process.env.PLURNK_CLIENT_COLOR = "always";
        const styledDoc = withColorOutput({ isTTY: true }, () =>
            renderMarkdownDocument(
                "Visit [docs](https://plurnk.xyz/docs) or [card](mcp:///plurnk/card.md).",
                100,
            ),
        );
        assert.match(styledDoc, /\x1b\]8;;https:\/\/plurnk\.xyz\/docs\x1b\\/u);
        assert.match(styledDoc, /\(https:\/\/plurnk\.xyz\/docs\)/u);
        assert.doesNotMatch(styledDoc, /\x1b\]8;;mcp:/u, "Plurnk schemes never wrap in OSC 8");

        process.env.PLURNK_CLIENT_COLOR = "never";
        const plainDoc = renderMarkdownDocument("Visit [docs](https://plurnk.xyz/docs).", 100);
        assert.equal(plainDoc, "Visit docs (https://plurnk.xyz/docs).");
        assert.doesNotMatch(plainDoc, /\x1b/u);
    } finally {
        if (prevNoColor === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = prevNoColor;
        if (prevColor === undefined) delete process.env.PLURNK_CLIENT_COLOR;
        else process.env.PLURNK_CLIENT_COLOR = prevColor;
    }
});

test("{§cli-markdown-projection} pathological Mermaid layout returns labeled source within deadline and leaves later responses usable", () => {
    const result = spawnSync(
        process.execPath,
        [
            "--max-old-space-size=256",
            "--input-type=module",
            "-e",
            `
            import assert from "node:assert/strict";
            import { readFileSync } from "node:fs";
            import { displayWidth, renderModelReply } from ${JSON.stringify(new URL("./markdown.ts", import.meta.url).href)};
            const source = readFileSync(${JSON.stringify(new URL("../test/fixtures/mermaid-fan-in.md", import.meta.url).pathname)}, "utf8");
            const first = renderModelReply(source, 135).split("\\n");
            assert.match(first.join("\\n"), /💻 mermaid — diagram failed to render/);
            assert.ok(first.every((line) => displayWidth(line) <= 135));
            const renderedSource = first
                .slice(first.findIndex((line) => line.startsWith("│ ")))
                .map((line) => line.replace(/^│ ?/u, ""))
                .join("\\n");
            assert.equal(renderedSource.trimEnd(), source.split("\\n").slice(1, -2).join("\\n"));
            const followUp = renderModelReply("Still responsive.", 135);
            assert.match(followUp, /Still responsive\\./);
            const simple = renderModelReply("\\x60\\x60\\x60mermaid\\ngraph TD\\nA-->B\\n\\x60\\x60\\x60", 135);
            assert.doesNotMatch(simple, /diagram failed to render/);
            assert.match(simple, /┌/);
            console.log("responsive");
            `,
        ],
        {
            encoding: "utf8",
            timeout: 8000,
            killSignal: "SIGKILL",
            env: {
                ...process.env,
                NO_COLOR: "1",
                PLURNK_CLIENT_MERMAID_TIMEOUT_MS: "250",
            },
        },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "responsive");
});

test("{§cli-markdown-projection} pipe tables project as aligned box-drawn columns and wrap cells without truncation", () =>
    withUnstyledEnv(() => {
        const simple = renderMarkdownDocument(
            ["| Name | Role |", "| --- | --- |", "| ada | engineer |", "| bo | ops |"].join("\n"),
        ).split("\n");
        assert.deepEqual(simple, [
            "┌──────┬──────────┐",
            "│ Name │ Role     │",
            "├──────┼──────────┤",
            "│ ada  │ engineer │",
            "├──────┼──────────┤",
            "│ bo   │ ops      │",
            "└──────┴──────────┘",
        ]);

        const prose = "Every word survives while mature table machinery wraps the cell across physical rows.";
        const wrapped = renderMarkdownDocument(
            ["| Key | Description |", "| --- | --- |", `| a | ${prose} |`, "| b | short |"].join("\n"),
            48,
        ).split("\n");
        assert.ok(wrapped.every((line) => displayWidth(line) <= 48));
        assert.doesNotMatch(wrapped.join("\n"), /…/u);
        const description = wrapped
            .filter((line) => line.startsWith("│") && !line.includes("Description"))
            .map((line) => line.split("│")[2]?.trim() ?? "")
            .filter((cell) => cell.length > 0 && cell !== "short")
            .join(" ");
        assert.equal(description, prose);

        const inlineCodeTable = renderMarkdownDocument(
            [
                "| Surface | Use |",
                "| --- | --- |",
                "| CLI one-shot | `npx @plurnk/plurnk \"what is 2+2?\"` |",
                "| Interactive Term | ongoing prompt sessions |",
                "| State commands | inspect and manage session state |",
            ].join("\n"),
        ).split("\n");
        assert.equal(new Set(inlineCodeTable.map(displayWidth)).size, 1);

        const urlValue = `https://example.com/${"abcdefghij".repeat(8)}`;
        const hardWrapped = renderMarkdownDocument(
            ["| Kind | Value |", "| --- | --- |", `| URL | ${urlValue} |`].join("\n"),
            48,
        ).split("\n");
        assert.ok(hardWrapped.every((line) => displayWidth(line) <= 48));
        const projectedUrl = hardWrapped
            .filter((line) => line.startsWith("│") && !line.includes("Value"))
            .map((line) => line.split("│")[2]?.trim() ?? "")
            .join("");
        assert.equal(projectedUrl, urlValue);
    }));

test("{§cli-markdown-projection} nested lists, quotations, code fences, rules, task lists, and LaTeX math project within container width", () =>
    withUnstyledEnv(() => {
        const fenced = renderMarkdownDocument('before\n```json\n{"a": **1**}\n```\nafter');
        assert.match(fenced, /```json/u);
        assert.match(fenced, /\{"a": \*\*1\*\*\}/u);
        assert.doesNotMatch(fenced, /<pre>|<code>/u);

        const nestedList = renderMarkdownDocument(
            [
                "2. **Addressable Context**: Everything in the agent environment is an addressable URI resource:",
                "   * `file:///` / project relative paths: Local project source code.",
                "   * `session:///`: Durable session state and cross-session communication.",
            ].join("\n"),
            135,
        );
        assert.deepEqual(nestedList.split("\n"), [
            "2. Addressable Context: Everything in the agent environment is an addressable URI resource:",
            "    * file:/// / project relative paths: Local project source code.",
            "    * session:///: Durable session state and cross-session communication.",
        ]);

        const quotedTableAndRule = renderMarkdownDocument(
            [
                "> | Name | Description |",
                "> | --- | --- |",
                "> | Example | Every word in this table remains present. |",
                ">",
                "> ---",
            ].join("\n"),
            48,
        ).split("\n");
        assert.ok(quotedTableAndRule.every((line) => displayWidth(line) <= 48));
        assert.ok(quotedTableAndRule.some((line) => /^│ ┌.*┐$/u.test(line)));
        assert.ok(quotedTableAndRule.some((line) => /^│ ─+$/u.test(line)));

        const tasks = renderMarkdownDocument(
            ["- [x] Boot the terminal", "- [x] Render headings", "- [ ] Verify projection"].join("\n"),
            80,
        );
        assert.deepEqual(tasks.split("\n"), [
            "- [x] Boot the terminal",
            "- [x] Render headings",
            "- [ ] Verify projection",
        ]);

        assert.equal(renderMarkdownDocument("The relation is $A \\leftrightarrow B$."), "The relation is A ↔ B.");
        assert.equal(renderMarkdownDocument("Step A $\\rightarrow$ Step B."), "Step A → Step B.");
        assert.equal(renderMarkdownDocument("When $x \\le y$ and $a \\ge b$."), "When x ≤ y and a ≥ b.");
        assert.equal(renderMarkdownDocument("Greek: $\\alpha + \\beta = \\gamma$."), "Greek: α + β = γ.");
        assert.equal(renderMarkdownDocument("Currency: $50 and $100."), "Currency: $50 and $100.");
    }));

test("{§cli-markdown-projection} nested Mermaid uses actual container block width before choosing layout", () =>
    withUnstyledEnv(() => {
        const source = "graph LR\nA[First]-->B[Second]";
        const horizontal = renderMermaid(source, 80);
        const width = Math.max(...horizontal.map(displayWidth));
        const fence = `\`\`\`mermaid\n${source}\n\`\`\``;
        for (const [prefix, leading] of [
            ["", ""],
            ["> ", ""],
            ["  ", "- Parent\n\n"],
            ["  > ", "- Parent\n\n"],
        ] as const) {
            const document = leading + fence.split("\n").map((line) => prefix + line).join("\n");
            const lines = renderMarkdownDocument(document, width).split("\n");
            const container = prefix.replace(">", "│");
            const diagram = lines.slice(leading ? 2 : 0);
            const expected = renderMermaid(source, width - container.length);
            assert.doesNotMatch(expected.join("\n"), /💻 mermaid/u);
            assert.deepEqual(diagram, expected.map((line) => (container + line).trimEnd()));
            assert.ok(lines.every((line) => displayWidth(line) <= width));
            if (container) {
                assert.notDeepEqual(expected, horizontal, "container indentation forces the alternate layout");
            }
        }
    }));

test("{§cli-markdown-projection} Mermaid preserves backticks inside box labels without misaligning borders", () =>
    withUnstyledEnv(() => {
        const doc = [
            "```mermaid",
            "flowchart LR",
            '  A["`plurnk-core` daemon"] --> B["`plurnk-acp` server"]',
            "```",
        ].join("\n");
        const rendered = renderMarkdownDocument(doc, 100);
        assert.doesNotMatch(rendered, /💻 mermaid/u);
        assert.match(rendered, /`plurnk-core` daemon/u);
        const boxLines = rendered.split("\n").filter((line) => line.startsWith("┌") || line.startsWith("│") || line.startsWith("└"));
        assert.equal(
            new Set(boxLines.map(displayWidth)).size,
            1,
            `box borders must stay aligned when labels contain inline Markdown syntax:\n${rendered}`,
        );
    }));

test("{§cli-markdown-projection} wide TD/TB/BT and LR/RL flowcharts transpose orientation including subgraph directions", () =>
    withUnstyledEnv(() => {
        for (const direction of ["TD", "TB", "BT"] as const) {
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
            assert.ok(authored.some((line) => displayWidth(line) > 132));
            assert.deepEqual(renderMermaid(source, Math.max(...authored.map(displayWidth))), authored);
            const horizontal = renderMermaid(`graph LR\n${body}`, 1000);
            assert.ok(horizontal.every((line) => displayWidth(line) <= 132));
            assert.deepEqual(renderMermaid(source, 132), horizontal);
        }

        for (const direction of ["LR", "RL"] as const) {
            const body =
                "a[First stage of the process] --> b[Second stage of the process] --> c[Final stage of the process]";
            const source = `flowchart ${direction}\n${body}`;
            const authored = renderMermaid(source, 1000);
            assert.ok(authored.some((line) => displayWidth(line) > 60));
            const vertical = renderMermaid(`flowchart TD\n${body}`, 1000);
            assert.ok(vertical.every((line) => displayWidth(line) <= 60));
            assert.deepEqual(renderMermaid(source, 60), vertical);
        }

        const subgraphBody = [
            "subgraph details[Details]",
            "    direction TB",
            "    root[Root] --> a[First detailed topic]",
            "    root --> b[Second detailed topic]",
            "    root --> c[Third detailed topic]",
            "    root --> d[Fourth detailed topic]",
            "end",
        ].join("\n");
        const subgraphSource = `flowchart TB\n${subgraphBody}`;
        const subgraphHorizontal = renderMermaid(
            `flowchart LR\n${subgraphBody.replace("direction TB", "direction LR")}`,
            1000,
        );
        assert.deepEqual(renderMermaid(subgraphSource, 70), subgraphHorizontal);
        assert.deepEqual(renderMermaid(subgraphSource.replaceAll("\n", "\r\n"), 70), subgraphHorizontal);

        // Multi-subgraph architecture diagram shape from Term dogfooding (wide TB fits 120 cols when transposed to LR)
        const multiSubgraph = [
            "flowchart TB",
            '  subgraph Client["External Clients"]',
            '    CLI["Terminal / Web Client"]',
            "  end",
            '  subgraph Protocol["Protocol Boundary"]',
            '    ACP["plurnk-acp (/acp)"]',
            '    AUTH["plurnk-auth (/oauth/*)"]',
            "  end",
            '  subgraph Core["plurnk-core Daemon"]',
            '    LOOP["Session & Loop Engine"]',
            '    DB[("SQLite WAL Store")]',
            "  end",
            '  subgraph Ext["Extension Frameworks"]',
            '    PROV["plurnk-providers*"]',
            '    MCP["plurnk-mcp"]',
            '    EXEC["plurnk-execs*"]',
            "  end",
            "  CLI --> ACP",
            "  CLI --> AUTH",
            "  ACP --> LOOP",
            "  LOOP --> DB",
            "  LOOP --> PROV",
            "  LOOP --> MCP",
            "  LOOP --> EXEC",
        ].join("\n");
        const multiSubgraphFit = renderMermaid(multiSubgraph, 120);
        assert.doesNotMatch(multiSubgraphFit.join("\n"), /💻 mermaid/u);
        assert.ok(multiSubgraphFit.every((line) => displayWidth(line) <= 120));
    }));

test("{§cli-markdown-projection} invalid, overwide, and misconfigured Mermaid deadlines label the failure and preserve source", (t) =>
    withUnstyledEnv(() => {
        assert.deepEqual(renderMermaid("notMermaid\n  A->>B: hi"), [
            "💻 mermaid — diagram failed to render",
            "│ notMermaid",
            "│   A->>B: hi",
        ]);

        const fanout = [
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
        const tooNarrow = renderMermaid(fanout, 10);
        const drawn = Math.min(
            ...[fanout, fanout.replace("flowchart TB", "flowchart LR")].map((attempt) =>
                Math.max(...renderMermaid(attempt, 1000).map(displayWidth)),
            ),
        );
        assert.equal(tooNarrow[0], `💻 mermaid — rendered width ${String(drawn)} exceeds 10`);
        assert.deepEqual(tooNarrow.slice(1), fanout.split("\n").map((line) => `│ ${line}`));

        const key = "PLURNK_CLIENT_MERMAID_TIMEOUT_MS";
        const before = process.env[key];
        t.after(() => {
            if (before === undefined) delete process.env[key];
            else process.env[key] = before;
        });

        process.env[key] = "1234";
        const bounded = t.mock.method(Script.prototype, "runInNewContext");
        const rotated = renderMermaid("graph LR\nA[Long first node]-->B[Long second node]", 22);
        assert.doesNotMatch(rotated.join("\n"), /💻 mermaid/u);
        assert.ok(rotated.every((line) => displayWidth(line) <= 22));
        assert.equal(bounded.mock.callCount(), 1, "both orientations share one execution deadline");
        assert.equal(bounded.mock.calls[0]?.arguments[1]?.timeout, 1234);
        bounded.mock.restore();

        for (const value of ["0", "-1", "nope", "1.5", ""]) {
            process.env[key] = value;
            const result = renderMarkdownDocument("Before.\n```mermaid\ngraph TD\nA-->B\n```\nAfter.", 160);
            assert.match(result, /diagram failed to render: PLURNK_CLIENT_MERMAID_TIMEOUT_MS must be a positive integer\./u);
            assert.match(result, /Before\./u);
            assert.match(result, /After\./u);
            assert.match(result, /│ A-->B/u);
        }
    }));
