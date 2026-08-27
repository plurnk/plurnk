// Proposal review — receives loop/proposal notifications, presents the user
// with an accept/edit/reject/cancel choice, and returns the resolution to send
// back via loop.resolve. Shared between CLI (one-shot) and TUI modes; mode-
// specific terminal handoff lives in the caller.
//
// Wire shape per plurnk-service Daemon.ts: loop/proposal carries an op kind,
// a target {scheme, pathname}, a body string (udiff for EDIT, command summary
// for EXEC), and an opaque attrs object. loop.resolve takes {logEntryId,
// decision, body?, outcome?}.

import { colorEnabled } from "./color.ts";
import { spawn } from "node:child_process";
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ProposalFlags {
    auto?: boolean;
    mode?: string;
    noWeb?: boolean;
    noInteraction?: boolean;
    noProposals?: boolean;
}

export interface ProposalParams {
    logEntryId: number;
    loopId: number;
    turnId: number;
    op: string;
    target: { scheme: string | null; pathname: string | null };
    body: string;
    attrs: unknown;
    flags: ProposalFlags;
}

// Server-resolved proposals: flags.auto resolves inside the loop, while
// flags.noProposals rejects inside the service. In both cases the
// daemon resolves the entry in-process before any human can react. Review UI
// and a client loop.resolve would race an already-settled proposal.
export const isServerResolved = ({ flags }: ProposalParams): boolean =>
    flags?.auto === true || flags?.noProposals === true;

export interface Resolution {
    decision: "accept" | "reject" | "cancel";
    body?: string;
    outcome?: string;
}

const useColor = colorEnabled();
const ansi = (code: string): string => useColor ? `\x1b[${code}m` : "";
const RESET = ansi("0");
const BOLD = ansi("1");
const DIM = ansi("2");
const GREEN = ansi("32");
const RED = ansi("31");
const CYAN = ansi("36");

// Color udiff lines for EDIT proposals. Anything else renders plain.
export const renderBody = (op: string, body: string): string => {
    if (op !== "EDIT") return body;
    return body.split("\n").map((line) => {
        if (line.startsWith("+++") || line.startsWith("---")) return `${BOLD}${line}${RESET}`;
        if (line.startsWith("+")) return `${GREEN}${line}${RESET}`;
        if (line.startsWith("-")) return `${RED}${line}${RESET}`;
        if (line.startsWith("@@")) return `${CYAN}${line}${RESET}`;
        return line;
    }).join("\n");
};

// EXEC with no explicit target runs in the default shell (`sh`) — name it,
// don't render "(no target)" as if the proposal were malformed. Every other op
// without a target is genuinely targetless.
export const formatTarget = ({ scheme, pathname }: ProposalParams["target"], op?: string): string => {
    if (scheme === null) return op === "EXEC" ? "sh" : "(no target)";
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

// The rendered diff + key menu as a string. Shared by the CLI (writes it to
// stderr) and the non-blocking TUI review (writes it to stdout). No I/O here.
export const renderProposalMenu = (params: ProposalParams): string => {
    const nl = params.body.endsWith("\n") ? "" : "\n";
    return `\n${BOLD}── proposal ${params.op} ${formatTarget(params.target, params.op)} ──${RESET}\n`
        + renderBody(params.op, params.body) + nl
        + `${DIM}[a]ccept · [e]dit · [r]eject · [c]ancel${RESET} `;
};

// ─── request-user-input questions ({§question-tool}) ──────────────────
// The question tool's body is the MCP2 form-elicitation shape — { message,
// requestedSchema } — and the answer is the standard ElicitResult payload
// { action, content }. The client renders the message plus the schema's
// single-property enum choices as a numbered menu with a free-response escape.

// The schema's single-property enum choices, if any. Multi-property or
// non-enum schemas yield [] (the user types a JSON answer).
export const questionChoices = (schema: Record<string, unknown>): string[] => {
    const properties = schema.properties;
    if (typeof properties !== "object" || properties === null) return [];
    const keys = Object.keys(properties);
    if (keys.length !== 1) return [];
    const property = (properties as Record<string, Record<string, unknown>>)[keys[0]!];
    const enums = property?.enum;
    return Array.isArray(enums) ? enums.filter((c): c is string => typeof c === "string") : [];
};

// Map a typed line to the standard answer payload for a single-property schema:
// a digit picks that enum choice; anything else is the property's free-text
// value. Multi-property schemas expect raw JSON. Empty → null (re-prompt).
export const answerForQuestion = (line: string, schema: Record<string, unknown>): Record<string, unknown> | null => {
    const t = line.trim();
    if (t.length === 0) return null;
    const properties = schema.properties;
    if (typeof properties !== "object" || properties === null) return null;
    const keys = Object.keys(properties);
    const choices = questionChoices(schema);
    if (keys.length === 1) {
        const key = keys[0]!;
        const n = Number(t);
        const value = choices.length > 0 && Number.isInteger(n) && n >= 1 && n <= choices.length
            ? choices[n - 1]
            : t;
        return { [key]: value };
    }
    try {
        const parsed = JSON.parse(t) as unknown;
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
};

// The question menu: the question, numbered choices, and the always-present
// free-response escape. An open question (no choices) is just "type your answer".
export const renderQuestionMenu = (question: string, choices: string[]): string => {
    const lines = [`\n${BOLD}── question ──${RESET}`, `  ${question}`];
    choices.forEach((c, i) => lines.push(`  ${DIM}${i + 1}.${RESET} ${c}`));
    lines.push(choices.length > 0
        ? `${DIM}  type 1–${choices.length} to pick, or type your own answer (Free Response)${RESET} `
        : `${DIM}  type your answer${RESET} `);
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
            const edited = await editInEditor(params.body, params.op === "EDIT" ? ".diff" : params.op === "EXEC" ? ".sh" : ".txt");
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
