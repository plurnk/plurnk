// Unit tests for src/proposal.ts pure helpers. The interactive bits
// (readSingleKey, editInEditor, reviewProposal) need stdin/$EDITOR
// mocking — covered by smoke, not here.

import { test } from "node:test";
import assert from "node:assert/strict";

// NO_COLOR=1 so coloring helpers emit empty strings; assertions stay textual.
process.env.NO_COLOR = "1";

const { renderBody, formatTarget, gateTitle, proposalOf, renderProposalMenu, keyToResolution, questionChoices, proposalResume } = await import("./proposal.ts");

test("[§cli-proposal-review]: resolution bodies and outcomes survive standard ACP resume", () => {
    for (const decision of ["accept", "reject"] as const) {
        assert.deepEqual(proposalResume("gate-7", { decision }), {
            interruptId: "gate-7", status: "resolved", payload: { decision },
        });
        for (const outcome of ["", "reviewed"]) {
            assert.deepEqual(proposalResume("gate-7", { decision, body: "", outcome }), {
                interruptId: "gate-7", status: "resolved", payload: { decision, body: "", outcome },
            });
        }
    }
    assert.deepEqual(proposalResume("gate-7", { decision: "cancel" }), { interruptId: "gate-7", status: "cancelled" });
    assert.deepEqual(proposalResume("gate-7", { decision: "cancel", outcome: "client_cancelled" }), {
        interruptId: "gate-7", status: "cancelled", payload: { outcome: "client_cancelled" },
    });
});

const proposal = () => ({
    logEntryId: 1,
    workerId: 1,
    worker: "main",
    op: "EDIT",
    target: { scheme: "file", pathname: "/tmp/x" },
    body: "",
    attrs: {},
});

// ─── request-user-input questions ({§question-tool}) ─────────────────
// The body's MCP2 form-elicitation shape drives the menu + the typed answer.

test("questionChoices: the schema's single-property enum choices surface", () => {
    assert.deepEqual(questionChoices({ properties: { branch: { type: "string", enum: ["main", "feat/x"] } } }), ["main", "feat/x"]);
    assert.deepEqual(questionChoices({ properties: {} }), []);
    assert.deepEqual(questionChoices({}), []);
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
    assert.equal(renderBody("sh", body), body);
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

test("formatTarget: an execution with no target → its runtime, not '(no target)'", () => {
    assert.equal(formatTarget({ scheme: null, pathname: null }, "sh"), "sh");
    // Keyword ops with no target are genuinely targetless.
    assert.equal(formatTarget({ scheme: null, pathname: null }, "EDIT"), "(no target)");
});

// {§cli-review-attribution} plurnk-service {§proposal-projection}: a proposal names the worker asking and any decision deadline.
test("[§cli-review-attribution] a gate's heading names the worker asking when it is not the bound one, and the deadline for the decision", () => {
    const now = new Date(2026, 9, 21, 9, 0);
    const today = new Date(2026, 9, 21, 14, 32).toISOString();
    const later = new Date(2026, 9, 23, 8, 5).toISOString();
    assert.equal(gateTitle("proposal EDIT a.ts", null, undefined, now), "proposal EDIT a.ts", "the bound worker's own, untimed");
    assert.equal(gateTitle("proposal EDIT a.ts", "helper", undefined, now), "proposal EDIT a.ts · from helper");
    assert.equal(gateTitle("proposal EDIT a.ts", null, today, now), "proposal EDIT a.ts · decide by 14:32", "a deadline today is its time");
    assert.equal(gateTitle("question", "helper", later, now), "question · from helper · decide by 2026-10-23 08:05", "another day carries its date");
    const menu = renderProposalMenu({ ...proposal(), worker: "helper", workerId: 4, expiresAt: today }, "main");
    // The menu reads the clock: its deadline is a time today or a dated one, the forms the titles above pin.
    assert.match(menu, /proposal EDIT \S*\/tmp\/x · from helper · decide by (?:\d{4}-\d\d-\d\d )?\d\d:\d\d/u, "the one-shot menu says the same");
    assert.doesNotMatch(renderProposalMenu(proposal(), "main"), /from main/u, "the bound worker's own names none");
});

test("[§cli-review-attribution] a proposal without its worker, or with a deadline that is no time, is a broken wire", () => {
    const interrupt = (over: Record<string, unknown>) => ({ id: "i1", metadata: { plurnk: { proposal: { ...proposal(), ...over } } } });
    assert.equal(proposalOf(interrupt({}))?.worker, "main");
    assert.equal(proposalOf(interrupt({ expiresAt: "2026-10-21T18:32:00.000Z" }))?.expiresAt, "2026-10-21T18:32:00.000Z");
    for (const broken of [{ worker: undefined }, { workerId: "1" }, { expiresAt: "soon" }, { expiresAt: 5 }]) {
        assert.throws(() => proposalOf(interrupt(broken)), (error: unknown) => (error as { problem?: { kind?: string } }).problem?.kind === "proposal-invalid", JSON.stringify(broken));
    }
});
