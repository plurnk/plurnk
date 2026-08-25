// Client rendering for PLURNK's two product-level diagnostic contracts:
//
// - RFC 9457 Problem Details are durable failures.
// - Notices are transient, nonterminal observations.
//
// They share a renderer, not a semantic envelope. Per SPEC.md §8.

import { colorEnabled } from "./color.ts";
import process from "node:process";
import {
    Problems,
    Validator,
    type ProblemDetails,
} from "@plurnk/plurnk-contracts";
import { userConfigFile } from "./paths.ts";

export type { ProblemDetails } from "@plurnk/plurnk-contracts";

export interface ContentOffset {
    type: "content-offset";
    line: number;
    column: number;
}

export interface LogCoordinate {
    type: "log-coordinate";
    coordinate: string;
    op?: string;
}

export type Position = ContentOffset | LogCoordinate;

export interface Notice {
    source: string;
    kind: string;
    level: "error" | "warn" | "info";
    message?: string | null;
    position?: Position | null;
    hints?: string[];
    [key: string]: unknown;
}

export type Diagnostic = ProblemDetails | Notice;

export class ProblemError extends Error {
    readonly problem: ProblemDetails;
    readonly exitCode: number;

    constructor(problem: ProblemDetails, exitCode: number = 64) {
        const exact = Validator.assertProblemDetails(problem);
        super(exact.detail);
        this.problem = exact;
        this.exitCode = exitCode;
        this.name = "ProblemError";
    }
}

const useColor = colorEnabled();
const code = (n: string): string => useColor ? `\x1b[${n}m` : "";
const RESET = code("0");
const DIM = code("2");
const RED = code("31");
const YELLOW = code("33");
const DIAGNOSTIC_GLYPH = "📡";

const isProblem = (diagnostic: Diagnostic): diagnostic is ProblemDetails =>
    "type" in diagnostic
    && "title" in diagnostic
    && "status" in diagnostic
    && "detail" in diagnostic;

const formatPosition = (position: Position | null | undefined): string => {
    if (position === null || position === undefined) return "";
    if (position.type === "content-offset") return `L${position.line} col${position.column}`;
    return position.op !== undefined ? `${position.coordinate} (${position.op})` : position.coordinate;
};

const sourceOf = (diagnostic: Diagnostic): string =>
    typeof diagnostic.source === "string" ? diagnostic.source : "problem";

const kindOf = (diagnostic: Diagnostic): string =>
    typeof diagnostic.kind === "string"
        ? diagnostic.kind
        : isProblem(diagnostic) ? diagnostic.title : "notice";

const messageOf = (diagnostic: Diagnostic): string =>
    isProblem(diagnostic)
        ? diagnostic.detail
        : typeof diagnostic.message === "string" ? diagnostic.message : "";

const positionOf = (diagnostic: Diagnostic): Position | null | undefined => {
    const position = diagnostic.position;
    if (position === null || position === undefined) return position;
    if (typeof position !== "object") return undefined;
    const type = (position as { type?: unknown }).type;
    if (type === "content-offset" || type === "log-coordinate") return position as Position;
    return undefined;
};

const colorOf = (diagnostic: Diagnostic): string => {
    if (isProblem(diagnostic)) return RED;
    if (diagnostic.level === "error") return RED;
    if (diagnostic.level === "warn") return YELLOW;
    return "";
};

const renderHeadline = (diagnostic: Diagnostic): string => {
    const discriminator = `${sourceOf(diagnostic)}:${kindOf(diagnostic)}`;
    const position = formatPosition(positionOf(diagnostic));
    const message = messageOf(diagnostic);
    const parts = [DIAGNOSTIC_GLYPH, discriminator];
    if (position.length > 0) parts.push(position);
    const color = colorOf(diagnostic);
    if (color.length > 0) {
        if (message.length > 0) parts.push(`"${message}"`);
        return `${color}${parts.join(" ")}${RESET}`;
    }
    if (message.length > 0) parts.push(`${DIM}"${message}"${RESET}`);
    return parts.join(" ");
};

const renderSnippet = (diagnostic: Diagnostic): string => {
    const snippet = typeof diagnostic.snippet === "string" ? diagnostic.snippet : "";
    if (snippet.length === 0) return "";
    return snippet.split("\n").map((line) => `   ${line}`).join("\n");
};

const renderHints = (diagnostic: Diagnostic): string => {
    if (!Array.isArray(diagnostic.hints) || diagnostic.hints.length === 0) return "";
    return diagnostic.hints
        .filter((hint): hint is string => typeof hint === "string")
        .map((hint) => `   ${DIM}${hint}${RESET}`)
        .join("\n");
};

const renderRecovery = (diagnostic: Diagnostic): string => {
    if (!isProblem(diagnostic) || typeof diagnostic.recovery !== "string") return "";
    return `   ${DIM}${diagnostic.recovery}${RESET}`;
};

export const renderDiagnostic = (diagnostic: Diagnostic): string => {
    const parts = [renderHeadline(diagnostic)];
    const snippet = renderSnippet(diagnostic);
    if (snippet.length > 0) parts.push(snippet);
    const recovery = renderRecovery(diagnostic);
    if (recovery.length > 0) parts.push(recovery);
    const hints = renderHints(diagnostic);
    if (hints.length > 0) parts.push(hints);
    return parts.join("\n");
};

export const report = (diagnostic: Diagnostic): void => {
    process.stderr.write(`${renderDiagnostic(diagnostic)}\n`);
};

export const clientProblem = (
    owner: string,
    code: string,
    status: number,
    detail: string,
    extensions: Record<string, unknown> = {},
): ProblemDetails => Problems.create(
    `client:${owner}`,
    code,
    status,
    detail,
    {
        source: `client:${owner}`,
        kind: code,
        ...extensions,
    },
);

export const clientDaemonStale = (missing: string[]): Notice => ({
    source: "client:connection",
    kind: "daemon_stale",
    level: "warn",
    message: `daemon is older than this client (missing: ${missing.join(", ")})`,
    missing,
    hints: ["Restart plurnk-service from a current checkout."],
});

export const clientConnectionRefused = (url: string, cause: unknown): ProblemDetails =>
    clientProblem(
        "connection",
        "refused",
        503,
        cause instanceof Error ? cause.message : String(cause),
        {
            url,
            hints: [
                "No daemon is running — the plurnk client connects to one.",
                "  Set your key:              export PLURNK_API_KEY=\"your-key\"",
                "  Quick start (no install):  npx @plurnk/plurnk-service start",
                "  Or install it:             npm i -g @plurnk/plurnk-service && plurnk-service",
            ],
        },
    );

const UNREACHABLE = /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EAI_AGAIN/;

export const isUnreachable = (cause: unknown): boolean => {
    if (!(cause instanceof Error)) return false;
    if (UNREACHABLE.test(String((cause.cause as { code?: string } | undefined)?.code ?? ""))) return true;
    return /fetch failed/i.test(cause.message);
};

export const clientRuntimeError = (cause: unknown): ProblemDetails =>
    clientProblem("runtime", "error", 500, cause instanceof Error ? cause.message : String(cause));

export const clientConnectionClosed = (cause: unknown): ProblemDetails =>
    clientProblem("connection", "closed", 502, cause instanceof Error ? cause.message : String(cause));

export const clientTransportCancelled = (): ProblemDetails =>
    clientProblem("transport", "cancelled", 499, "The client cancelled the active run.", {
        stage: "transport",
        retryable: false,
    });

export const clientTransportTerminalMissing = (): ProblemDetails =>
    clientProblem("transport", "terminal-missing", 502, "The AG-UI stream ended before reporting the run outcome.", {
        stage: "transport",
        retryable: false,
    });

export const clientTransportProblemMissing = (): ProblemDetails =>
    clientProblem("transport", "problem-missing", 502, "The AG-UI stream reported a failed run without its required Problem Details.", {
        stage: "transport",
        retryable: false,
    });

export const clientTransportProblemInvalid = (cause: unknown): ProblemDetails =>
    clientProblem("transport", "problem-invalid", 502, "The AG-UI stream contained invalid Problem Details.", {
        stage: "transport",
        reason: cause instanceof Error ? cause.message : String(cause),
        retryable: false,
    });

export const clientTransportResultInvalid = (cause: unknown): ProblemDetails =>
    clientProblem("transport", "result-invalid", 502, "The AG-UI stream contained an invalid operation result.", {
        stage: "transport",
        reason: cause instanceof Error ? cause.message : String(cause),
        retryable: false,
    });

export const clientTransportInterruptMismatch = (logEntryId: number): ProblemDetails =>
    clientProblem("transport", "interrupt-mismatch", 502, `Proposal ${logEntryId} ended without its matching AG-UI interrupt outcome.`, {
        stage: "proposal-resolution",
        logEntryId,
        retryable: false,
    });

export const clientTransportProposalInvalid = (logEntryId: number, cause: unknown): ProblemDetails =>
    clientProblem("transport", "proposal-invalid", 502, `Proposal ${logEntryId} contained invalid JSON arguments.`, {
        stage: "proposal-resolution",
        logEntryId,
        reason: cause instanceof Error ? cause.message : String(cause),
        retryable: false,
    });

export const clientActionResultInvalid = (reason: string): ProblemDetails =>
    clientProblem("action", "result-invalid", 502, "The AG-UI action result did not satisfy the Plurnk action-result contract.", {
        stage: "action-result",
        reason,
        retryable: false,
    });

export const clientActionResultMissing = (kind: string): ProblemDetails =>
    clientProblem("action", "result-missing", 502, `Action '${kind}' ended without a plurnk.action.result event.`, {
        stage: "action-result",
        action: kind,
        retryable: false,
    });

export const clientWorkspaceNameMissing = (): ProblemDetails =>
    clientProblem("workspace", "name-missing", 502, "workspace.create completed without a non-empty workspace name.", {
        stage: "action-result",
        retryable: false,
    });

export const clientWorkerNotFound = (name: string): ProblemDetails =>
    clientProblem("worker", "not-found", 404, `No worker named ${JSON.stringify(name)} exists in the workspace.`, {
        name,
        retryable: false,
    });

export const clientFlagInvalid = (flag: string, value: string, reason: string): ProblemDetails =>
    clientProblem("flag", "invalid", 400, reason, { flag, value });

export const clientFlagMissingDependency = (flag: string, requires: string): ProblemDetails =>
    clientProblem("flag", "missing-dependency", 400, `${flag} requires ${requires}`, { flag, requires });

export const clientSubcommandWorkspaceNotFound = (name: string): ProblemDetails =>
    clientProblem("subcommand", "workspace-not-found", 404, `no workspace named ${JSON.stringify(name)}`, { name });

export const clientSubcommandWorkspaceAmbiguous = (name: string, count: number): ProblemDetails =>
    clientProblem(
        "subcommand",
        "workspace-ambiguous",
        409,
        `${count} workspaces named ${JSON.stringify(name)}; pick a unique name`,
        { name, count },
    );

export const clientSubcommandUnknownVerb = (path: string, available?: string[]): ProblemDetails =>
    clientProblem(
        "subcommand",
        "unknown-verb",
        400,
        available !== undefined && available.length > 0
            ? `unknown subcommand '${path}'. Available: ${available.join(", ")}`
            : `unknown subcommand '${path}'`,
        { path, available },
    );

export const clientSubcommandMissingArgument = (path: string, argument: string): ProblemDetails =>
    clientProblem("subcommand", "missing-argument", 400, `${path}: missing ${argument}`, { path, argument });

export const clientSubcommandCoordinateInvalid = (coordinate: string): ProblemDetails =>
    clientProblem(
        "subcommand",
        "coordinate-invalid",
        400,
        `Log coordinate ${JSON.stringify(coordinate)} is not three non-negative integers in loop/turn/sequence order.`,
        {
            coordinate,
            recovery: "Use <loop>/<turn>/<sequence>.",
            retryable: false,
        },
    );

export const clientSubcommandEntryNotFound = (coordinate: string, workerId?: number): ProblemDetails =>
    clientProblem(
        "subcommand",
        "entry-not-found",
        404,
        `No log entry exists at coordinate ${coordinate} for the selected worker.`,
        {
            coordinate,
            ...(workerId === undefined ? {} : { workerId }),
            recovery: "Select the worker that owns the conversation or use an existing coordinate.",
            retryable: false,
        },
    );

export const clientProposalEditsBlocked = (): Notice => ({
    source: "client:proposal",
    kind: "edits_blocked",
    level: "warn",
    message: "edits and exec blocked: no review channel to approve them (run on a TTY, or pass --yolo)",
});

export const NO_MODEL_HINT = ` — configure a model in ${userConfigFile()} (see: plurnk-service config defaults)`;

export const clientRpcError = (method: string, cause: unknown): ProblemDetails =>
    clientProblem(
        "rpc",
        "error",
        502,
        cause instanceof Error ? cause.message : String(cause),
        { method },
    );

export const colors = { RESET, DIM, RED, YELLOW };
