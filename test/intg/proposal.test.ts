// Integration tests for the proposal lifecycle. Driven by op.parse (no model
// needed) — we craft EDIT statements directly and assert that the propose →
// resolve → apply flow behaves correctly for accept, reject, cancel, and
// accept-with-body-override.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import Rpc from "../../src/rpc.ts";
import { locateDaemon, bootDaemon, type Daemon } from "./harness.ts";

let daemon: Daemon | null = null;
let skipReason: string | null = null;

before(async () => {
    const bin = await locateDaemon();
    if (bin === null) { skipReason = "plurnk-service binary not found"; return; }
    try { daemon = await bootDaemon(bin); }
    catch (err) { skipReason = `daemon boot failed: ${err instanceof Error ? err.message : String(err)}`; }
});

after(async () => { if (daemon !== null) await daemon.cleanup(); });

const guard = (t: { skip: (reason: string) => void }): boolean => {
    if (skipReason !== null) { t.skip(skipReason); return true; }
    return false;
};

// Helper: connect a session with project_root pointing at the workspace,
// register a handler that auto-resolves the first proposal with the supplied
// decision, then dispatch the EDIT and await both sides.
interface ProposalResolution {
    decision: "accept" | "reject" | "cancel";
    body?: string;
    outcome?: string;
}

const dispatchEditAndResolve = async (
    targetPath: string,
    body: string,
    resolution: ProposalResolution,
): Promise<{ proposalLogEntryId: number }> => {
    const rpc = new Rpc({ url: daemon!.url });
    await rpc.connect();
    try {
        await rpc.call("session.create", { projectRoot: daemon!.workspace });
        let proposalLogEntryId = -1;
        const proposalReceived = new Promise<void>((resolveProposal) => {
            rpc.onNotification("loop/proposal", (params) => {
                const p = params as { logEntryId: number };
                proposalLogEntryId = p.logEntryId;
                void rpc.call("loop.resolve", { logEntryId: p.logEntryId, ...resolution })
                    .then(() => resolveProposal());
            });
        });
        // Fire op.parse; the daemon's dispatch pauses awaiting resolution.
        // We must let the proposal notification land + be resolved before
        // op.parse can return.
        const parsePromise = rpc.call("op.parse", { text: `<<EDIT(file://${targetPath}):${body}:EDIT` });
        await Promise.all([parsePromise, proposalReceived]);
        return { proposalLogEntryId };
    } finally { await rpc.close(); }
};

// ─── Accept path: file is written with the proposed body ─────────────

test("proposal accept writes the file with the proposed body", async (t) => {
    if (guard(t)) return;
    const target = join(daemon!.workspace, "accept.txt");
    await dispatchEditAndResolve(target, "the proposed body", { decision: "accept" });
    const written = await readFile(target, "utf8");
    assert.equal(written, "the proposed body");
});

// ─── Reject path: file is NOT created ────────────────────────────────

test("proposal reject does not write the file", async (t) => {
    if (guard(t)) return;
    const target = join(daemon!.workspace, "reject.txt");
    await dispatchEditAndResolve(target, "should not be written", { decision: "reject" });
    await assert.rejects(access(target), /ENOENT/);
});

// ─── Cancel path: file is NOT created ────────────────────────────────

test("proposal cancel does not write the file", async (t) => {
    if (guard(t)) return;
    const target = join(daemon!.workspace, "cancel.txt");
    await dispatchEditAndResolve(target, "should not be written", { decision: "cancel" });
    await assert.rejects(access(target), /ENOENT/);
});

// ─── Accept with body override: file gets the OVERRIDDEN body ────────

test("proposal accept with body override writes the override, not the original", async (t) => {
    if (guard(t)) return;
    const target = join(daemon!.workspace, "override.txt");
    await dispatchEditAndResolve(target, "original body", {
        decision: "accept",
        body: "OVERRIDDEN by client",
    });
    const written = await readFile(target, "utf8");
    assert.equal(written, "OVERRIDDEN by client");
});

// ─── Wire shape: the loop/proposal notification carries the fields the client reads ──

test("loop/proposal notification carries logEntryId, op, target, body, attrs", async (t) => {
    if (guard(t)) return;
    const target = join(daemon!.workspace, "shape.txt");
    const rpc = new Rpc({ url: daemon!.url });
    await rpc.connect();
    try {
        await rpc.call("session.create", { projectRoot: daemon!.workspace });
        let captured: Record<string, unknown> | null = null;
        const got = new Promise<void>((resolveCaptured) => {
            rpc.onNotification("loop/proposal", (params) => {
                captured = params as Record<string, unknown>;
                // Resolve so dispatch can unpause + op.parse returns.
                void rpc.call("loop.resolve", { logEntryId: (params as { logEntryId: number }).logEntryId, decision: "cancel" })
                    .then(() => resolveCaptured());
            });
        });
        await Promise.all([
            rpc.call("op.parse", { text: `<<EDIT(file://${target}):shape probe:EDIT` }),
            got,
        ]);
        assert.ok(captured !== null);
        const c = captured as Record<string, unknown>;
        assert.equal(typeof c.logEntryId, "number");
        assert.equal(typeof c.op, "string");
        assert.equal(c.op, "EDIT");
        assert.ok(c.target !== undefined && typeof c.target === "object");
        assert.equal(typeof c.body, "string");
        assert.ok((c.body as string).includes("shape probe") || (c.body as string).includes("+shape"));
        assert.ok(typeof c.attrs === "object");
    } finally { await rpc.close(); }
});

// ─── 5-min timeout escape hatch verification ──────────────────────────
// Skipped by default — the timeout default is PLURNK_PROPOSAL_TIMEOUT_MS=300000.
// Test takes 5 minutes if enabled; gated by an opt-in env var.

test("proposal auto-cancels after PLURNK_PROPOSAL_TIMEOUT_MS (gated; needs env override on daemon)", { skip: process.env.RUN_TIMEOUT_TEST !== "1" }, async (t) => {
    if (guard(t)) return;
    const target = join(daemon!.workspace, "timeout.txt");
    const rpc = new Rpc({ url: daemon!.url });
    await rpc.connect();
    try {
        await rpc.call("session.create", { projectRoot: daemon!.workspace });
        // Don't subscribe — let the daemon's timeout fire.
        const parsePromise = rpc.call("op.parse", { text: `<<EDIT(file://${target}):timeout probe:EDIT` });
        await parsePromise;
        await assert.rejects(access(target), /ENOENT/);
    } finally { await rpc.close(); }
});
