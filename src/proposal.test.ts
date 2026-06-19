// Unit tests for src/proposal.ts pure helpers. The interactive bits
// (readSingleKey, editInEditor, reviewProposal) need stdin/$EDITOR
// mocking — covered by smoke, not here.

import { test } from "node:test";
import assert from "node:assert/strict";

// NO_COLOR=1 so coloring helpers emit empty strings; assertions stay textual.
process.env.NO_COLOR = "1";

const { renderBody, formatTarget, isServerResolved, isBroadcastProposal } = await import("./proposal.ts");

const proposal = (flags: object): Parameters<typeof isServerResolved>[0] => ({
    logEntryId: 1,
    loopId: 1,
    turnId: 1,
    op: "EDIT",
    target: { scheme: "file", pathname: "/tmp/x" },
    body: "",
    attrs: {},
    flags,
});

// ─── isBroadcastProposal (don't review the model's speech — svc#255) ──────

test("isBroadcastProposal: SEND with no target → true (auto-accept, not reviewable)", () => {
    assert.equal(isBroadcastProposal({ ...proposal({}), op: "SEND", target: { scheme: null, pathname: null } }), true);
});

test("isBroadcastProposal: SEND with a null target object → true (defensive)", () => {
    assert.equal(isBroadcastProposal({ ...proposal({}), op: "SEND", target: null as unknown as { scheme: string | null; pathname: string | null } }), true);
});

test("isBroadcastProposal: a real EDIT proposal → false (must be reviewed)", () => {
    assert.equal(isBroadcastProposal(proposal({})), false);
});

test("isBroadcastProposal: a DIRECTED SEND (has a scheme target) → false", () => {
    assert.equal(isBroadcastProposal({ ...proposal({}), op: "SEND", target: { scheme: "wss", pathname: "/feed" } }), false);
});

// ─── isServerResolved ────────────────────────────────────────────────

test("isServerResolved: flags.yolo → true (server YOLO auto-accepts in-process)", () => {
    assert.equal(isServerResolved(proposal({ yolo: true })), true);
});

test("isServerResolved: flags.noProposals → true (server auto-rejects in-process)", () => {
    assert.equal(isServerResolved(proposal({ noProposals: true })), true);
});

test("isServerResolved: plain flags → false (client review proceeds)", () => {
    assert.equal(isServerResolved(proposal({})), false);
    assert.equal(isServerResolved(proposal({ yolo: false, noProposals: false })), false);
    assert.equal(isServerResolved(proposal({ noWeb: true, noInteraction: true })), false);
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
