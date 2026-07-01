// Unified error/telemetry shape across the plurnk stack.
//
// The grammar 0.17.0 TelemetryEvent schema (`source / kind / message? /
// position? / additional kind-specific fields`) is the vocabulary every
// producer in the ecosystem emits into — `grammar`, `engine:rail`,
// `scheme:*`, `provider:*` from the daemon side; `client:*` from us.
// This module owns the shape, the renderer, and the client-side emission
// helpers; everything user-facing routes through `report(event)`.
//
// Per SPEC.md §8.

import process from "node:process";

// ─── Shape ────────────────────────────────────────────────────────────

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

// Mirrors @plurnk/plurnk-grammar 0.17.0 schema/TelemetryEvent.json. The
// schema is open at the kind-specific field layer (`additionalProperties:
// true`); we model that by allowing arbitrary additional fields.
//
// `hints` is a client-side convention (not in the grammar schema): an
// optional list of actionable nudges the renderer shows as continuation
// lines after the headline. Used for things like "Is the daemon running?"
// on connection failure.
export interface TelemetryEvent {
    source: string;          // e.g. "grammar", "engine:rail", "client:connection"
    kind: string;            // e.g. "parse_error", "strike", "refused"
    // Severity, set by the PRODUCER at the emit site (grammar 0.74.29+, svc#276).
    // The client colors straight off this — never re-derives it from the kind
    // string. Optional only for a producer predating the field → neutral.
    level?: "error" | "warn" | "info";
    message?: string | null;
    position?: Position | null;
    hints?: string[];
    // Open vocabulary at the kind-specific field layer. Consumers pick the
    // fields they recognize; unknown fields are preserved verbatim by the
    // renderer when relevant (e.g. `snippet` on grammar:parse_error).
    [key: string]: unknown;
}

// Thrown across boundaries to carry a structured event through normal
// async error propagation. The global catch in main() unwraps these and
// renders the carried event verbatim; non-TelemetryError throws collapse
// to a generic `client:runtime:error` event.
//
// `exitCode` is the process exit code the global catch should propagate.
// Defaults to 64 (usage error) since most TelemetryError throws are flag/
// argument / subcommand validation. Runtime failures pass 1 explicitly.
export class TelemetryError extends Error {
    readonly event: TelemetryEvent;
    readonly exitCode: number;
    constructor(event: TelemetryEvent, exitCode: number = 64) {
        super(event.message ?? `${event.source}:${event.kind}`);
        this.event = event;
        this.exitCode = exitCode;
        this.name = "TelemetryError";
    }
}

// ─── Rendering ────────────────────────────────────────────────────────

const useColor = process.env.NO_COLOR !== "1" && process.env.NO_COLOR !== "true";
const code = (n: string): string => useColor ? `\x1b[${n}m` : "";
const RESET = code("0");
const DIM = code("2");
const RED = code("31");
const YELLOW = code("33");

const TELEMETRY_GLYPH = "📡";

// Format a Position inline as a compact suffix on the headline. ContentOffset
// becomes `L<line> col<column>`; LogCoordinate becomes `<coordinate>` (with op
// in parens when present).
const formatPosition = (pos: Position | null | undefined): string => {
    if (pos === null || pos === undefined) return "";
    if (pos.type === "content-offset") return `L${pos.line} col${pos.column}`;
    if (pos.type === "log-coordinate") return pos.op !== undefined ? `${pos.coordinate} (${pos.op})` : pos.coordinate;
    return "";
};

// Severity straight off the producer-set `level` (grammar 0.74.29+, svc#276 /
// client#110): error → RED headline, warn → YELLOW, everything else neutral
// (plain discriminator, dim message). No kind-string heuristic — severity is
// meaning the producer owns, not something we re-derive by pattern-matching.
const severityColor = (event: TelemetryEvent): string =>
    event.level === "error" ? RED : event.level === "warn" ? YELLOW : "";

// Format the headline: `<glyph> <source>:<kind> <position?> <message?>`. The
// caller is responsible for trailing newlines. Error/warning headlines render
// in their severity color (so an error reads as an error); neutral ones keep
// the plain discriminator + dim message.
const renderHeadline = (event: TelemetryEvent): string => {
    const discriminator = `${event.source}:${event.kind}`;
    const position = formatPosition(event.position);
    const message = typeof event.message === "string" && event.message.length > 0
        ? `"${event.message}"`
        : "";
    const parts = [TELEMETRY_GLYPH, discriminator];
    if (position.length > 0) parts.push(position);
    const color = severityColor(event);
    if (color.length > 0) {
        if (message.length > 0) parts.push(message);
        return `  ${color}${parts.join(" ")}${RESET}`;
    }
    if (message.length > 0) parts.push(`${DIM}${message}${RESET}`);
    return `  ${parts.join(" ")}`;
};

// Some kinds carry a rendered snippet (grammar:parse_error has `snippet`
// with `N:\t`-prefixed offending content). Render it as an indented block.
const renderSnippet = (event: TelemetryEvent): string => {
    const snippet = typeof event.snippet === "string" ? event.snippet : "";
    if (snippet.length === 0) return "";
    return snippet.split("\n").map((line) => `     ${line}`).join("\n");
};

// Render hints as indented continuation lines after the headline.
const renderHints = (event: TelemetryEvent): string => {
    if (!Array.isArray(event.hints) || event.hints.length === 0) return "";
    return event.hints.map((hint) => `     ${DIM}${hint}${RESET}`).join("\n");
};

// Full rendering: headline + optional snippet block + optional hints block.
// Used by `report` and by any other surface (TUI waterfall) that wants the
// same vocabulary.
export const renderTelemetryEvent = (event: TelemetryEvent): string => {
    const parts = [renderHeadline(event)];
    const snippet = renderSnippet(event);
    if (snippet.length > 0) parts.push(snippet);
    const hints = renderHints(event);
    if (hints.length > 0) parts.push(hints);
    return parts.join("\n");
};

// Write a rendered event to stderr. Single point of egress so the channel
// posture (stderr in CLI mode; same in TUI to keep the waterfall on stdout
// stream) stays consistent across emission sites.
export const report = (event: TelemetryEvent): void => {
    process.stderr.write(`${renderTelemetryEvent(event)}\n`);
};

// ─── Client-side emitters ────────────────────────────────────────────

// `client:connection:daemon_stale` — discover is missing wire markers this
// client depends on; the daemon predates the client (clients track HEAD per
// service SPEC §13.9).
export const clientDaemonStale = (missing: string[]): TelemetryEvent => ({
    source: "client:connection",
    kind: "daemon_stale",
    level: "warn",
    message: `daemon is older than this client (missing: ${missing.join(", ")})`,
    missing,
    hints: ["Restart plurnk-service from a current checkout."],
});

// `client:connection:refused` — WebSocket connection couldn't be established.
export const clientConnectionRefused = (url: string, cause: unknown): TelemetryEvent => ({
    source: "client:connection",
    kind: "refused",
    level: "error",
    message: cause instanceof Error ? cause.message : String(cause),
    url,
    hints: [
        "No daemon is running — the plurnk client connects to one.",
        "  Set your key:              export PLURNK_API_KEY=\"your-key\"",
        "  Quick start (no install):  npx @plurnk/plurnk-service start",
        "  Or install it:             npm i -g @plurnk/plurnk-service && plurnk-service",
    ],
});

// `client:runtime:error` — generic catch-all for thrown errors we don't have
// a more specific shape for. Used as a fallback in the global catch.
export const clientRuntimeError = (cause: unknown): TelemetryEvent => ({
    source: "client:runtime",
    kind: "error",
    level: "error",
    message: cause instanceof Error ? cause.message : String(cause),
});

// `client:connection:closed` — connection dropped while a call was in flight.
export const clientConnectionClosed = (cause: unknown): TelemetryEvent => ({
    source: "client:connection",
    kind: "closed",
    level: "error",
    message: cause instanceof Error ? cause.message : String(cause),
});

// `client:flag:invalid` — flag value didn't parse or violated a contract.
export const clientFlagInvalid = (flag: string, value: string, reason: string): TelemetryEvent => ({
    source: "client:flag",
    kind: "invalid",
    level: "error",
    message: reason,
    flag,
    value,
});

// `client:flag:missing_dependency` — flag X requires flag Y also be set.
export const clientFlagMissingDependency = (flag: string, requires: string): TelemetryEvent => ({
    source: "client:flag",
    kind: "missing_dependency",
    level: "error",
    message: `${flag} requires ${requires}`,
    flag,
    requires,
});

// `client:subcommand:session_not_found` — name resolution failed.
export const clientSubcommandSessionNotFound = (name: string): TelemetryEvent => ({
    source: "client:subcommand",
    kind: "session_not_found",
    level: "error",
    message: `no session named ${JSON.stringify(name)}`,
    name,
});

// `client:subcommand:session_ambiguous` — multiple sessions match.
export const clientSubcommandSessionAmbiguous = (name: string, count: number): TelemetryEvent => ({
    source: "client:subcommand",
    kind: "session_ambiguous",
    level: "error",
    message: `${count} sessions named ${JSON.stringify(name)}; pick a unique name`,
    name,
    count,
});

// `client:subcommand:unknown_verb` — unrecognized subcommand verb.
export const clientSubcommandUnknownVerb = (path: string, available?: string[]): TelemetryEvent => ({
    source: "client:subcommand",
    kind: "unknown_verb",
    level: "error",
    message: available !== undefined && available.length > 0
        ? `unknown subcommand '${path}'. Available: ${available.join(", ")}`
        : `unknown subcommand '${path}'`,
    path,
    available,
});

// `client:subcommand:missing_argument` — required positional or flag absent.
export const clientSubcommandMissingArgument = (path: string, argument: string): TelemetryEvent => ({
    source: "client:subcommand",
    kind: "missing_argument",
    level: "error",
    message: `${path}: missing ${argument}`,
    path,
    argument,
});

// `client:proposal:no_tty_review` — fail-closed in CLI without --yolo.
// `client:proposal:edits_blocked` — no review channel (non-TTY, no --yolo),
// so the loop runs with flags.noProposals: the server auto-rejects
// side-effecting ops (the model sees a plain 400, mode-blind). Only the
// client can say WHY, because the server is silent by design (plurnk #24 /
// #169 client half). Emitted once at loop start, not per proposal.
export const clientProposalEditsBlocked = (): TelemetryEvent => ({
    source: "client:proposal",
    kind: "edits_blocked",
    level: "warn",
    message: "edits and exec blocked: no review channel to approve them (run on a TTY, or pass --yolo)",
});

// `client:rpc:error` — RPC call rejected with a daemon-supplied error.
export const clientRpcError = (method: string, cause: unknown): TelemetryEvent => ({
    source: "client:rpc",
    kind: "error",
    level: "error",
    message: cause instanceof Error ? cause.message : String(cause),
    method,
});

// Color helpers exported for callers that want a colored marker without
// reimplementing the NO_COLOR check (e.g. the TUI's existing waterfall).
export const colors = { RESET, DIM, RED, YELLOW };
