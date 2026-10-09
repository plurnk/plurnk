// Proposal review — presents a client-owned proposal (an AG-UI request_approval
// interrupt) with an accept/edit/reject/cancel choice and returns the resolution
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

// An execution's op is its lowercase runtime tag; operation keywords are uppercase (plurnk-service #659).
const isRuntimeOp = (op: string): boolean => /^[a-z]/.test(op);

export interface ProposalParams {
    logEntryId: number;
    loopId: number;
    turnId: number;
    op: string;
    target: { scheme: string | null; pathname: string | null };
    body: string;
    attrs: unknown;
    owner: string;
}

export type Resolution = ProposalResolution;

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
const readSingleKey = (): Promise<string> => new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (chunk: Buffer): void => {
        stdin.removeListener("data", onData);
        stdin.setRawMode(wasRaw);
        stdin.pause();
        resolve(chunk.toString("utf8")[0] ?? "");
    };
    stdin.on("data", onData);
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

// The one-shot TTY client's rendered diff and raw-key menu. No I/O here.
export const renderProposalMenu = (params: ProposalParams): string => {
    const body = ModelText.plain(params.body);   // plurnk#35 — the body is the model's
    const nl = body.endsWith("\n") ? "" : "\n";
    return `\n${paint(`── proposal ${params.op} ${formatTarget(ModelText.plainFields(params.target), params.op)} ──`, "bold")}\n`
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
export const reviewProposal = async (params: ProposalParams): Promise<Resolution> => {
    process.stderr.write(withColorOutput(process.stderr, () => renderProposalMenu(params)));
    const key = (await readSingleKey()).toLowerCase();
    process.stderr.write(`${key}\n`);
    // Unknown key (incl. ctrl-c = \x03) → cancel for safety.
    return (await keyToResolution(key, params)) ?? { decision: "cancel", outcome: "unknown_key" };
};
