import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "./render-filter.ts";

describe("renderMarkdown", () => {
    it("{§cli-markdown-projection} renders a heading as underlined text", () => {
        const out = renderMarkdown("# Hello", 60);
        assert.equal(out.trimEnd(), "Hello\n=====");
    });

    it("{§cli-markdown-projection} strips bold and italic markers", () => {
        const out = renderMarkdown("This is **bold** and *italic*.", 60);
        assert.equal(out.trimEnd(), "This is bold and italic.");
    });

    it("{§cli-markdown-projection} renders unordered list items with bullet", () => {
        const out = renderMarkdown("- one\n- two", 60);
        assert.equal(out.trimEnd(), "• one\n• two");
    });

    it("{§cli-markdown-projection} indents code blocks", () => {
        const out = renderMarkdown("```\nlet x = 1;\n```", 60);
        assert.equal(out.trimEnd(), "  let x = 1;");
    });

    it("{§cli-markdown-projection} renders blockquotes with │ prefix", () => {
        const out = renderMarkdown("> A quote", 60);
        assert.equal(out.trimEnd(), "│ A quote");
    });

    it("{§cli-markdown-projection} wraps long lines to the given width", () => {
        const long = "a".repeat(100);
        const out = renderMarkdown(long, 40);
        for (const line of out.split("\n")) {
            assert.ok(line.length <= 40);
        }
    });

    it("{§cli-markdown-projection} renders mermaid as indented source", () => {
        const out = renderMarkdown("```mermaid\ngraph TD\n  A-->B\n```", 60);
        assert.ok(out.includes("  [diagram]"));
        assert.ok(out.includes("  graph TD"));
    });

    it("{§cli-markdown-projection} renders tables as aligned columns", () => {
        const md = "| A | B |\n|---|---|\n| 1 | 2 |";
        const out = renderMarkdown(md, 60);
        assert.ok(out.includes("A"));
        assert.ok(out.includes("1"));
    });

    it("{§cli-markdown-projection} handles empty input", () => {
        assert.equal(renderMarkdown("", 60).trim(), "");
    });
});
