// Proposal review — receives loop/proposal notifications, presents the user
// with an accept/edit/reject/cancel choice, and returns the resolution to send
// back via loop.resolve. Shared between CLI (one-shot) and TUI modes; mode-
// specific wiring (TTY check, readline pause) lives in the caller.
//
// Wire shape per plurnk-service Daemon.ts: loop/proposal carries an op kind,
// a target {scheme, pathname}, a body string (udiff for EDIT, command summary
// for EXEC), and an opaque attrs object. loop.resolve takes {logEntryId,
// decision, body?, outcome?}.

import { spawn } from "node:child_process";
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ProposalFlags {
    yolo?: boolean;
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

// Server-resolved proposals: when the loop carries flags.yolo (server-side
// YOLO auto-accept) or flags.noProposals (server-side auto-reject), the
// daemon resolves the entry in-process before any human can react. Review UI
// and a client loop.resolve would race an already-settled proposal.
export const isServerResolved = ({ flags }: ProposalParams): boolean =>
    flags?.yolo === true || flags?.noProposals === true;

// A broadcast SEND (op SEND, no target) is the model SPEAKING — not a
// side-effecting op to accept/reject. It reaches the proposal path only via the
// SEND[202]-parked vs proposal-202 collision (svc#255). Auto-accept it (the
// only sensible resolution for speech) rather than freeze on a bogus review UI.
export const isBroadcastProposal = (p: ProposalParams): boolean =>
    p.op === "SEND" && (p.target == null || p.target.scheme === null);

export interface Resolution {
    decision: "accept" | "reject" | "cancel";
    body?: string;
    outcome?: string;
}

const useColor = process.env.NO_COLOR !== "1" && process.env.NO_COLOR !== "true";
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

export const formatTarget = ({ scheme, pathname }: ProposalParams["target"]): string => {
    if (scheme === null) return "(no target)";
    return `${scheme}://${pathname ?? ""}`;
};

// Read one raw byte from stdin and return its char form. Caller is responsible
// for pausing any reader (readline) that competes for stdin first.
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

// Drop the proposal body into a tmpfile, spawn $EDITOR (or VISUAL, or vi) on
// it, wait for the editor to exit, read the result back. Empty file ⇒ cancel
// (git-commit convention). Non-empty ⇒ the new body to accept with.
const editInEditor = async (body: string, op: string): Promise<string | null> => {
    const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
    const dir = await mkdtemp(join(tmpdir(), "plurnk-proposal-"));
    const suffix = op === "EDIT" ? ".diff" : op === "EXEC" ? ".sh" : ".txt";
    const path = join(dir, `proposal${suffix}`);
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

// Interactively review a proposal. Writes the rendered diff + menu to stderr
// (telemetry, not product); reads the user's single keypress; returns the
// resolution. Caller sends loop.resolve.
export const reviewProposal = async (params: ProposalParams): Promise<Resolution> => {
    process.stderr.write(`\n${BOLD}── proposal ${params.op} ${formatTarget(params.target)} ──${RESET}\n`);
    process.stderr.write(renderBody(params.op, params.body));
    if (!params.body.endsWith("\n")) process.stderr.write("\n");
    process.stderr.write(`${DIM}[a]ccept · [e]dit · [r]eject · [c]ancel${RESET} `);

    const key = (await readSingleKey()).toLowerCase();
    process.stderr.write(`${key}\n`);

    switch (key) {
        case "a":
            return { decision: "accept" };
        case "e": {
            const edited = await editInEditor(params.body, params.op);
            if (edited === null) return { decision: "cancel", outcome: "empty_editor_buffer" };
            return { decision: "accept", body: edited };
        }
        case "r":
            return { decision: "reject" };
        case "c":
            return { decision: "cancel" };
        default:
            // Anything else (including ctrl-c = \x03) → cancel for safety.
            return { decision: "cancel", outcome: "unknown_key" };
    }
};
