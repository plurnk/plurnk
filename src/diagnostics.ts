// Client rendering for PLURNK's two product-level diagnostic contracts:
//
// - RFC 9457 Problem Details are durable failures.
// - Notices are transient, nonterminal observations.
//
// They share a renderer, not a semantic envelope. Per SPEC.md §8.

import process from "node:process";

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

export interface ProblemDetails {
    type: string;
    title: string;
    status: number;
    detail: string;
    instance?: string;
    [key: string]: unknown;
}

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
        super(problem.detail);
        this.problem = problem;
        this.exitCode = exitCode;
        this.name = "ProblemError";
    }
}

const useColor = process.env.NO_COLOR !== "1" && process.env.NO_COLOR !== "true";
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
        return `  ${color}${parts.join(" ")}${RESET}`;
    }
    if (message.length > 0) parts.push(`${DIM}"${message}"${RESET}`);
    return `  ${parts.join(" ")}`;
};

const renderSnippet = (diagnostic: Diagnostic): string => {
    const snippet = typeof diagnostic.snippet === "string" ? diagnostic.snippet : "";
    if (snippet.length === 0) return "";
    return snippet.split("\n").map((line) => `     ${line}`).join("\n");
};

const renderHints = (diagnostic: Diagnostic): string => {
    if (!Array.isArray(diagnostic.hints) || diagnostic.hints.length === 0) return "";
    return diagnostic.hints
        .filter((hint): hint is string => typeof hint === "string")
        .map((hint) => `     ${DIM}${hint}${RESET}`)
        .join("\n");
};

export const renderDiagnostic = (diagnostic: Diagnostic): string => {
    const parts = [renderHeadline(diagnostic)];
    const snippet = renderSnippet(diagnostic);
    if (snippet.length > 0) parts.push(snippet);
    const hints = renderHints(diagnostic);
    if (hints.length > 0) parts.push(hints);
    return parts.join("\n");
};

export const report = (diagnostic: Diagnostic): void => {
    process.stderr.write(`${renderDiagnostic(diagnostic)}\n`);
};

const titleFor = (kind: string): string =>
    kind
        .split(/[-_]/u)
        .filter((part) => part.length > 0)
        .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
        .join(" ");

export const clientProblem = (
    owner: string,
    kind: string,
    status: number,
    detail: string,
    extensions: Record<string, unknown> = {},
): ProblemDetails => ({
    type: `https://problems.plurnk.dev/client/${owner}/${kind.replaceAll("_", "-")}`,
    title: titleFor(kind),
    status,
    detail,
    source: `client:${owner}`,
    kind,
    ...extensions,
});

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

export const clientFlagInvalid = (flag: string, value: string, reason: string): ProblemDetails =>
    clientProblem("flag", "invalid", 400, reason, { flag, value });

export const clientFlagMissingDependency = (flag: string, requires: string): ProblemDetails =>
    clientProblem("flag", "missing_dependency", 400, `${flag} requires ${requires}`, { flag, requires });

export const clientSubcommandWorkspaceNotFound = (name: string): ProblemDetails =>
    clientProblem("subcommand", "workspace_not_found", 404, `no workspace named ${JSON.stringify(name)}`, { name });

export const clientSubcommandWorkspaceAmbiguous = (name: string, count: number): ProblemDetails =>
    clientProblem(
        "subcommand",
        "workspace_ambiguous",
        409,
        `${count} workspaces named ${JSON.stringify(name)}; pick a unique name`,
        { name, count },
    );

export const clientSubcommandUnknownVerb = (path: string, available?: string[]): ProblemDetails =>
    clientProblem(
        "subcommand",
        "unknown_verb",
        400,
        available !== undefined && available.length > 0
            ? `unknown subcommand '${path}'. Available: ${available.join(", ")}`
            : `unknown subcommand '${path}'`,
        { path, available },
    );

export const clientSubcommandMissingArgument = (path: string, argument: string): ProblemDetails =>
    clientProblem("subcommand", "missing_argument", 400, `${path}: missing ${argument}`, { path, argument });

export const clientProposalEditsBlocked = (): Notice => ({
    source: "client:proposal",
    kind: "edits_blocked",
    level: "warn",
    message: "edits and exec blocked: no review channel to approve them (run on a TTY, or pass --yolo)",
});

export const NO_MODEL_HINT = " — configure a model: edit ~/.plurnk/.env and uncomment one option";

export const clientRpcError = (method: string, cause: unknown): ProblemDetails =>
    clientProblem(
        "rpc",
        "error",
        502,
        cause instanceof Error ? cause.message : String(cause),
        { method },
    );

export const colors = { RESET, DIM, RED, YELLOW };
