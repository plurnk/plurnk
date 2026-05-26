// Unit tests for src/proposal.ts pure helpers. The interactive bits
// (readSingleKey, editInEditor, reviewProposal) need stdin/$EDITOR
// mocking — covered by smoke, not here.

import { test } from "node:test";
import assert from "node:assert/strict";

// NO_COLOR=1 so coloring helpers emit empty strings; assertions stay textual.
process.env.NO_COLOR = "1";

const { renderBody, formatTarget } = await import("./proposal.ts");

// ─── renderBody ──────────────────────────────────────────────────────

test("renderBody: non-EDIT op → body unchanged (no diff coloring)", () => {
    const body = "ls -la /tmp";
    assert.equal(renderBody("EXEC", body), body);
});

test("renderBody: EDIT with udiff → coloring applied per line", () => {
    // With NO_COLOR=1, ANSI codes are empty — body text is preserved verbatim.
    const diff = "--- old\n+++ new\n@@ -1,1 +1,1 @@\n-foo\n+bar\n";
    const out = renderBody("EDIT", diff);
    // All lines preserved
    assert.ok(out.includes("--- old"));
    assert.ok(out.includes("+++ new"));
    assert.ok(out.includes("@@ -1,1 +1,1 @@"));
    assert.ok(out.includes("-foo"));
    assert.ok(out.includes("+bar"));
});

test("renderBody: EDIT with context lines → preserved unchanged", () => {
    const out = renderBody("EDIT", "context only");
    assert.equal(out, "context only");
});

test("renderBody: empty body → empty body", () => {
    assert.equal(renderBody("EDIT", ""), "");
});

// ─── formatTarget ────────────────────────────────────────────────────

test("formatTarget: null scheme → '(no target)'", () => {
    assert.equal(formatTarget({ scheme: null, pathname: null }), "(no target)");
});

test("formatTarget: null scheme even if pathname set → '(no target)'", () => {
    // This is by current design — the proposal target is reported as the parsed
    // form from the engine, which uses scheme as the discriminator.
    assert.equal(formatTarget({ scheme: null, pathname: "/tmp/x" }), "(no target)");
});

test("formatTarget: scheme + pathname → 'scheme://pathname'", () => {
    assert.equal(formatTarget({ scheme: "file", pathname: "/tmp/x" }), "file:///tmp/x");
});

test("formatTarget: scheme + null pathname → 'scheme://'", () => {
    assert.equal(formatTarget({ scheme: "exec", pathname: null }), "exec://");
});
