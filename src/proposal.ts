// Proposal review — presents a client-owned proposal (an AG-UI interrupt carrying the daemon's
// proposal projection) with an accept/edit/reject/cancel choice and returns the resolution
// the caller sends back as a standard AG-UI resume (proposalResume). Shared
// between CLI (one-shot) and TUI modes; mode-specific terminal handoff lives in
// the caller.
//
// A proposal carries an op kind, a target {scheme, pathname}, a body string (udiff
// for EDIT, command summary for an execution), and an opaque attrs object.

import ModelText from "./model-text.ts";
import { paint, withColorOutput } from "./color.ts";
import { spawn } from "node:child_process";
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProposalResolution } from "@plurnk/plurnk-contracts";
import type { ResumeEntry } from "@ag-ui/core";
import { clientTransportProposalInvalid, ProblemError } from "./diagnostics.ts";
import { objectOf } from "./render.ts";

// An execution's op is its lowercase runtime tag; operation keywords are uppercase (plurnk-service #659).
const isRuntimeOp = (op: string): boolean => /^[a-z]/.test(op);

export interface ProposalParams {
    logEntryId: number;
    // {§cli-review-attribution} the worker asking, and the deadline the operator set for the decision (ISO 8601).
    workerId: number;
    worker: string;
    expiresAt?: string;
    op: string;
    target: { scheme: string | null; pathname: string | null };
    body: string;
    attrs: unknown;
}

export type Resolution = ProposalResolution;

// plurnk-service `{§agui-proposal-resolve}`: a proposal is an interrupt carrying the daemon's projection as
// metadata.plurnk.proposal, whether or not it names the operation's call; any other interrupt carries none.
export const proposalOf = (interrupt: { readonly id: string; readonly metadata?: unknown }): ProposalParams | null => {
    const plurnk = objectOf(objectOf(interrupt.metadata)?.plurnk);
    if (plurnk === null || plurnk.proposal === undefined) return null;
    const proposal = objectOf(plurnk.proposal);
    const target = objectOf(proposal?.target);
    if (proposal === null || !Number.isSafeInteger(proposal.logEntryId) || typeof proposal.op !== "string" || typeof proposal.body !== "string"
        || target === null || !(target.scheme === null || typeof target.scheme === "string")
        || !(target.pathname === null || typeof target.pathname === "string")
        || !Number.isSafeInteger(proposal.workerId) || typeof proposal.worker !== "string"
        || !(proposal.expiresAt === undefined || typeof proposal.expiresAt === "string" && Number.isFinite(Date.parse(proposal.expiresAt)))) {
        throw new ProblemError(clientTransportProposalInvalid(interrupt.id, "metadata.plurnk.proposal lacks logEntryId, workerId, worker, op, body or target, or its expiresAt is no time."));
    }
    return proposal as unknown as ProposalParams;
};

// {§cli-proposal-review} Preserve the same resolution through every client run plane.
export const proposalResume = (interruptId: string, resolution: Resolution): ResumeEntry => {
    const { decision, body, outcome } = resolution;
    const reason = outcome === undefined ? {} : { outcome };
    return decision === "cancel"
        ? { interruptId, status: "cancelled", ...(outcome === undefined ? {} : { payload: reason }) }
        : { interruptId, status: "resolved", payload: { decision, ...(body === undefined ? {} : { body }), ...reason } };
};

// Color udiff lines for EDIT proposals. Anything else renders plain.
export const renderBody = (op: string, body: string): string => {
    if (op !== "EDIT") return body;
    return body.split("\n").map((line) => {
        if (line.startsWith("+++") || line.startsWith("---")) return paint(line, "bold");
        if (line.startsWith("+")) return paint(line, "added");
        if (line.startsWith("-")) return paint(line, "removed");
        if (line.startsWith("@@")) return paint(line, "reference");
        return line;
    }).join("\n");
};

// An execution with no explicit target is named by its runtime (`sh` is the default shell):
// don't render "(no target)" as if the proposal were malformed. Every other op
// without a target is genuinely targetless.
export const formatTarget = ({ scheme, pathname }: ProposalParams["target"], op?: string): string => {
    if (scheme === null) return op !== undefined && isRuntimeOp(op) ? op : "(no target)";
    return `${scheme}://${pathname ?? ""}`;
};

// Read one raw byte from stdin and return its char form. Caller is responsible
// after the caller relinquishes terminal custody.
// One keypress, or null once `signal` aborts first; stdin returns to its prior mode either way.
const readSingleKey = (signal?: AbortSignal): Promise<string | null> => new Promise((resolve) => {
    if (signal?.aborted === true) { resolve(null); return; }
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    const done = (key: string | null): void => {
        stdin.removeListener("data", onData);
        signal?.removeEventListener("abort", onAbort);
        stdin.setRawMode(wasRaw);
        stdin.pause();
        resolve(key);
    };
    const onData = (chunk: Buffer): void => { done(chunk.toString("utf8")[0] ?? ""); };
    const onAbort = (): void => { done(null); };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    signal?.addEventListener("abort", onAbort, { once: true });
});

// Drop a body into a tmpfile, spawn $EDITOR (or VISUAL, or vi) on it, wait
// for the editor to exit, read the result back. Empty file ⇒ null (git-commit
// convention). Shared by proposal review and prompt composition.
export const editInEditor = async (body: string, suffix: string): Promise<string | null> => {
    const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
    const dir = await mkdtemp(join(tmpdir(), "plurnk-edit-"));
    const path = join(dir, `buffer${suffix}`);
    try {
        await writeFile(path, body, "utf8");
        await new Promise<void>((resolve, reject) => {
            const proc = spawn(editor, [path], { stdio: "inherit" });
            proc.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${editor} exited with code ${code}`)));
            proc.on("error", reject);
        });
        const edited = await readFile(path, "utf8");
        return edited.trim().length === 0 ? null : edited;
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
};

// {§cli-review-attribution} A gate's heading: what it asks, the worker asking when it is not the bound one, and the
// deadline the operator set for the decision, as a local time (with its date when not today).
export const gateTitle = (what: string, asker: string | null, expiresAt: string | undefined, now = new Date()): string => {
    const two = (n: number): string => String(n).padStart(2, "0");
    const by = expiresAt === undefined ? null : new Date(expiresAt);
    const deadline = by === null ? null : `${by.toDateString() === now.toDateString() ? "" : `${by.getFullYear()}-${two(by.getMonth() + 1)}-${two(by.getDate())} `}${two(by.getHours())}:${two(by.getMinutes())}`;
    return [what, ...(asker === null ? [] : [`from ${ModelText.plain(asker)}`]), ...(deadline === null ? [] : [`decide by ${deadline}`])].join(" · ");
};

// The one-shot TTY client's rendered diff and raw-key menu. No I/O here.
export const renderProposalMenu = (params: ProposalParams, boundWorker?: string): string => {
    const body = ModelText.plain(params.body);   // plurnk#35 — the body is the model's
    const nl = body.endsWith("\n") ? "" : "\n";
    const what = `proposal ${params.op} ${formatTarget(ModelText.plainFields(params.target), params.op)}`;
    return `\n${paint(`── ${gateTitle(what, params.worker === boundWorker ? null : params.worker, params.expiresAt)} ──`, "bold")}\n`
        + renderBody(params.op, body) + nl
        + `${paint("[a]ccept · [e]dit · [r]eject · [c]ancel", "dim")} `;
};

// ─── request-user-input questions ({§question-tool}) ──────────────────

// The schema's single-property enum choices, if any. Multi-property or
// non-enum schemas yield []. QuestionForm calls this for each named field.
export const questionChoices = (schema: Record<string, unknown>): string[] => {
    const properties = schema.properties;
    if (typeof properties !== "object" || properties === null) return [];
    const keys = Object.keys(properties);
    if (keys.length !== 1) return [];
    const property = (properties as Record<string, Record<string, unknown>>)[keys[0]!];
    const enums = property?.enum;
    return Array.isArray(enums) ? enums.filter((c): c is string => typeof c === "string") : [];
};

// Map a single review key to a resolution. `e` runs $EDITOR (async — caller
// must own the terminal during the spawn). The one-shot CLI cancels on other keys.
export const keyToResolution = async (key: string, params: ProposalParams): Promise<Resolution | null> => {
    switch (key.toLowerCase()) {
        case "a":
            return { decision: "accept" };
        case "e": {
            const edited = await editInEditor(params.body, params.op === "EDIT" ? ".diff" : isRuntimeOp(params.op) ? ".sh" : ".txt");
            if (edited === null) return { decision: "cancel", outcome: "empty_editor_buffer" };
            return { decision: "accept", body: edited };
        }
        case "r":
            return { decision: "reject" };
        case "c":
            return { decision: "cancel" };
        default:
            return null;
    }
};

// Interactively review a proposal (CLI mode — blocking, owns stdin). Writes the
// diff + menu to stderr, reads one keypress, returns the resolution. The TUI
// uses the non-blocking renderProposalMenu + keyToResolution instead.
// plurnk-service {§agui-held-interrupts}: null when `signal` withdraws the menu before a key, its gate settled elsewhere.
export const reviewProposal = async (params: ProposalParams, signal?: AbortSignal, boundWorker?: string): Promise<Resolution | null> => {
    process.stderr.write(withColorOutput(process.stderr, () => renderProposalMenu(params, boundWorker)));
    const pressed = await readSingleKey(signal);
    if (pressed === null) {
        process.stderr.write("settled elsewhere\n");
        return null;
    }
    const key = pressed.toLowerCase();
    process.stderr.write(`${key}\n`);
    // Unknown key (incl. ctrl-c = \x03) → cancel for safety.
    return (await keyToResolution(key, params)) ?? { decision: "cancel", outcome: "unknown_key" };
};

// plurnk-service {§agui-held-interrupts}: a resume refused because its gate no longer waits, settled by another client or
// the daemon.
export const isUnpending = (problem: { readonly status: number; readonly type: string }): boolean =>
    problem.status === 409 && /\/(?:interrupt|proposal|interaction)-not-pending$/u.test(problem.type);
