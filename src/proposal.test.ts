// Unit tests for src/proposal.ts pure helpers. The interactive bits
// (readSingleKey, editInEditor, reviewProposal) need stdin/$EDITOR
// mocking — covered by smoke, not here.

import { test } from "node:test";
import assert from "node:assert/strict";

// NO_COLOR=1 so coloring helpers emit empty strings; assertions stay textual.
process.env.NO_COLOR = "1";

const { renderBody, formatTarget, renderProposalMenu, keyToResolution, renderQuestionMenu, questionChoices } = await import("./proposal.ts");

const proposal = () => ({
    logEntryId: 1,
    loopId: 1,
    turnId: 1,
    op: "EDIT",
    target: { scheme: "file", pathname: "/tmp/x" },
    body: "",
    attrs: {},
    policy: { capabilities: {}, proposals: "review" as const },
});

// ─── request-user-input questions ({§question-tool}) ─────────────────
// The body's MCP2 form-elicitation shape drives the menu + the typed answer.

test("questionChoices: the schema's single-property enum choices surface", () => {
    assert.deepEqual(questionChoices({ properties: { branch: { type: "string", enum: ["main", "feat/x"] } } }), ["main", "feat/x"]);
    assert.deepEqual(questionChoices({ properties: {} }), []);
    assert.deepEqual(questionChoices({}), []);
});

test("renderQuestionMenu: numbers the choices + free-response hint; open question just prompts", () => {
    const mc = renderQuestionMenu("Which?", ["Alpha", "Beta"]);
    assert.match(mc, /1\. Alpha/);
    assert.match(mc, /2\. Beta/);
    assert.match(mc, /Free Response/);
    assert.match(renderQuestionMenu("Name?", []), /type your answer/);
});


// ─── keyToResolution + renderProposalMenu (non-blocking review primitives) ──

test("[§cli-proposal-review-boundaries][§cli-review-menu-interactive] keyToResolution: a/r/c → accept/reject/cancel; unknown key → null (pass-through)", async () => {
    const p = proposal();
    assert.deepEqual(await keyToResolution("a", p), { decision: "accept" });
    assert.deepEqual(await keyToResolution("r", p), { decision: "reject" });
    assert.deepEqual(await keyToResolution("c", p), { decision: "cancel" });
    assert.equal(await keyToResolution("/", p), null);   // typing /accept must NOT resolve
    assert.equal(await keyToResolution("x", p), null);
});

test("keyToResolution: case-insensitive (A == a)", async () => {
    assert.deepEqual(await keyToResolution("A", proposal()), { decision: "accept" });
});

test("[§cli-notification-shape] renderProposalMenu: shows the op, target, and the key menu", () => {
    const menu = renderProposalMenu({ ...proposal(), op: "EDIT", target: { scheme: "file", pathname: "/tmp/x" } });
    assert.match(menu, /proposal EDIT/);
    assert.match(menu, /\[a\]ccept/);
    assert.match(menu, /\[r\]eject/);
});

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

test("formatTarget: EXEC with no target → 'sh' (the default shell), not '(no target)'", () => {
    assert.equal(formatTarget({ scheme: null, pathname: null }, "EXEC"), "sh");
    // Non-EXEC ops with no target are genuinely targetless.
    assert.equal(formatTarget({ scheme: null, pathname: null }, "EDIT"), "(no target)");
});
