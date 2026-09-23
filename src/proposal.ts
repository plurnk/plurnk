// Proposal review — receives loop/proposal notifications, presents the user
// with an accept/edit/reject/cancel choice, and returns the resolution to send
// back via loop.resolve. Shared between CLI (one-shot) and TUI modes; mode-
// specific terminal handoff lives in the caller.
//
// Wire shape per plurnk-service Daemon.ts: loop/proposal carries an op kind,
// a target {scheme, pathname}, a body string (udiff for EDIT, command summary
// for an execution), and an opaque attrs object. loop.resolve takes {logEntryId,
// decision, body?, outcome?}.

import ModelText from "./model-text.ts";
import { paint } from "./color.ts";
import { spawn } from "node:child_process";
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoopPolicy } from "@plurnk/plurnk-contracts";

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
    policy: LoopPolicy;
}

export interface Resolution {
    decision: "accept" | "reject" | "cancel";
    body?: string;
    outcome?: string;
}

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

// {plurnk#104} — the body is a window about the reasoning lane's height, a third of the terminal
// at most, never the whole diff; the editor shows the rest.
export const bodyWindow = (text: string, rows: number): string => {
    const max = Math.max(3, Math.floor(rows / 3));
    const all = text.split("\n");
    if (all.length <= max) return text;
    return [...all.slice(0, max), paint(`… ${all.length - max} more lines · e opens the whole body in the editor`, "dim")].join("\n");
};

// The rendered diff + key menu as a string. Shared by the CLI (writes it to
// stderr) and the non-blocking TUI review (writes it to stdout). No I/O here.
// The body window stands apart: a blank row above and below it (plurnk#104).
export const renderProposalMenu = (params: ProposalParams, rows: number = process.stdout.rows ?? 24): string => {
    const body = ModelText.plain(params.body).replace(/\n$/u, "");   // plurnk#35 — the body is the model's
    return `\n${paint(`── proposal ${params.op} ${formatTarget(ModelText.plainFields(params.target), params.op)} ──`, "bold")}\n\n`
        + renderBody(params.op, bodyWindow(body, rows)) + "\n\n"
        + `${paint("[a]ccept · [e]dit · [r]eject · [c]ancel", "dim")} `;
};

// ─── request-user-input questions ({§question-tool}) ──────────────────
// The question tool's body is the MCP2 form-elicitation shape — { message,
// requestedSchema } — and the answer is the standard ElicitResult payload
// { action, content }. The client renders the message plus the schema's
// single-property enum choices as a numbered menu.

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

// The question menu: the question, numbered choices, and the always-present
// literal-value alternative. An open question (no choices) is just "type your answer".
export const renderQuestionMenu = (question: string, choices: string[]): string => {
    const lines = [`\n${paint("── question ──", "bold")}`, `  ${ModelText.plain(question)}`];
    choices.forEach((c, i) => lines.push(`  ${paint(`${i + 1}.`, "dim")} ${ModelText.plain(c)}`));
    lines.push(choices.length > 0
        ? `${paint(`  type 1–${choices.length} to pick, or enter a listed value`, "dim")} `
        : `${paint("  type your answer", "dim")} `);
    lines.push(paint("  /cancel cancels the question", "dim"));
    return lines.join("\n");
};

// Map a single review key to a resolution. `e` runs $EDITOR (async — caller
// must own the terminal during the spawn). Returns null for non-review keys, so
// callers can pass them through (the TUI lets them reach its editor) or default
// (the CLI cancels for safety).
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
    process.stderr.write(renderProposalMenu(params));
    const key = (await readSingleKey()).toLowerCase();
    process.stderr.write(`${key}\n`);
    // Unknown key (incl. ctrl-c = \x03) → cancel for safety.
    return (await keyToResolution(key, params)) ?? { decision: "cancel", outcome: "unknown_key" };
};
