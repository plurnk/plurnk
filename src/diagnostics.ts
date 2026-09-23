// Client rendering for PLURNK's two product-level diagnostic contracts:
//
// - RFC 9457 Problem Details are durable failures.
// - Notices are transient, nonterminal observations.
//
// They share a renderer, not a semantic envelope. Per SPEC.md §8.

import { paint } from "./color.ts";
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

// {§cli-notice-rendering} — every diagnostic is an alert block (plurnk#97): a Problem or an error
// Notice is a caution, a warning Notice a warning, an informational Notice a note.
// Each glyph is two columns wide: a second space keeps the word off its shoulder (plurnk#104).
const ALERTS = Object.freeze({
    caution: "🛑  Caution",
    warning: "⚠️  Warning",
    note: "ℹ️  Note",
});
const GUTTER = "│";

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

const alertOf = (diagnostic: Diagnostic): keyof typeof ALERTS =>
    isProblem(diagnostic) || diagnostic.level === "error" ? "caution"
        : diagnostic.level === "warn" ? "warning"
        : "note";

const renderTitle = (diagnostic: Diagnostic, alert: keyof typeof ALERTS): string => {
    const position = formatPosition(positionOf(diagnostic));
    const discriminator = `${sourceOf(diagnostic)}:${kindOf(diagnostic)}${position.length > 0 ? ` ${position}` : ""}`;
    return `${paint(ALERTS[alert], alert, "bold")} ${paint(discriminator, "dim")}`;
};

const lines = (text: string): string[] => text.length === 0 ? [] : text.split("\n");

const renderSnippet = (diagnostic: Diagnostic): string[] =>
    lines(typeof diagnostic.snippet === "string" ? diagnostic.snippet : "").map((line) => `  ${line}`);

const renderHints = (diagnostic: Diagnostic): string[] =>
    (Array.isArray(diagnostic.hints) ? diagnostic.hints : [])
        .filter((hint): hint is string => typeof hint === "string")
        .map((hint) => paint(hint, "dim"));

const renderRecovery = (diagnostic: Diagnostic): string[] =>
    isProblem(diagnostic) && typeof diagnostic.recovery === "string" ? [paint(diagnostic.recovery, "dim")] : [];

// {plurnk#104} — the message rides the title line; only its further lines, a snippet, a
// recovery or hints take rows of their own.
export const renderDiagnostic = (diagnostic: Diagnostic): string => {
    const alert = alertOf(diagnostic);
    const [first, ...rest] = lines(messageOf(diagnostic));
    return [
        `${renderTitle(diagnostic, alert)}${first === undefined ? "" : ` — ${first}`}`,
        ...rest,
        ...renderSnippet(diagnostic),
        ...renderRecovery(diagnostic),
        ...renderHints(diagnostic),
    ].map((line) => `${paint(GUTTER, alert)} ${line}`).join("\n");
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

// {§cli-conversation-lost} — the daemon answered a bound name with no history at all: the worker
// behind it is new (a fresh database, a deleted worker), and the transcript above is this terminal's.
export const clientConversationLost = (workspace: string, worker: string): Notice => ({
    source: "client:conversation",
    kind: "conversation_lost",
    level: "warn",
    message: `the daemon holds no history for conversation ${worker} in workspace ${workspace}; this message starts a new one, and the turns above are this terminal's memory, not the model's`,
    workspace,
    worker,
    hints: ["The daemon restarted on a fresh database, or the worker was deleted."],
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

export const clientTransportStateInvalid = (reason: string): ProblemDetails =>
    clientProblem("transport", "state-invalid", 502, "The AG-UI stream contained an invalid state delta.", {
        stage: "transport",
        reason,
        retryable: false,
    });

export const clientTransportInterruptMismatch = (interruptId: string): ProblemDetails =>
    clientProblem("transport", "interrupt-mismatch", 502, `Tool call '${interruptId}' ended without its matching AG-UI interrupt outcome.`, {
        stage: "interrupt-resolution",
        interruptId,
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

export const clientWebNotInstalled = (): ProblemDetails =>
    clientProblem("web", "not-installed", 424, "The optional @plurnk/plurnk-web package is not installed.", {
        package: "@plurnk/plurnk-web",
        hints: ["Install it: npm install -g @plurnk/plurnk-web"],
        retryable: false,
    });

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
