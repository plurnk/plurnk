// Waterfall row grammar for the TUI ({§cli-log-entry-line-format}). An operation row is the
// authored heading, `OP (target) <scope> /pattern/ {n} aside — problem title`, rendered as
// literal text with this module's own styling and never through Markdown; only message
// bodies are Markdown ({§cli-broadcast-send-rendering}). Rows carry no bodies.

import { paint } from "./color.ts";
import { stripVTControlCharacters } from "node:util";
import ModelText from "./model-text.ts";
import type { OperationResult } from "@plurnk/plurnk-contracts";
import { abbreviatedCount, money } from "./figures.ts";

export interface LogEntryWire {
    id: number;
    worker_id?: number;
    // {§message-causal-source} — the causal actor's address; null is the worker's own doing.
    source?: string | null;
    inherited_history?: number;
    op: string;
    origin: string;
    signal: unknown;
    scheme: string | null;
    pathname: string | null;
    hostname: string | null;
    fragment: string | null;
    lineMarker: { marks: Array<number | string> } | null;
    status_rx: number;
    tx: unknown;
    rx: unknown;
    attrs?: unknown;
    tags: string[];
    // Logical coordinate (the model's log://L/T/S address) — every wire
    // log entry carries it (loops⋈turns JOIN, plurnk-service #208).
    loop_seq: number;
    turn_seq: number;
    sequence: number;
}

// A wire field that may arrive as JSON text or as the parsed object.
export const objectOf = (value: unknown): Record<string, unknown> | null => {
    const parsed = typeof value === "string"
        ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })()
        : value;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
};

export const entryAside = (entry: LogEntryWire): string | null => {
    const raw = objectOf(entry.tx)?.aside;
    if (typeof raw !== "string") return null;
    const plain = stripVTControlCharacters(raw)
        .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
    return plain.length === 0 ? null : plain;
};

// Machine acquisition is durable ambience, not a live action trace. It remains
// available through log/replay; interactive clients collapse it into the
// producer's aggregate progress signal instead of redrawing once per page.
export const isEntryMaterialization = (entry: LogEntryWire): boolean =>
    entry.origin === "_plurnk"
    && entry.op === "EDIT"
    && objectOf(entry.attrs)?.kind === "entry_materialized";

// Human output carries no coordinate gutter. Coordinates remain forensic
// truth on the wire and in --json; this label survives for machine-adjacent
// surfaces that still want one.
export const coordLabel = (loopSeq: number, turnSeq: number, sequence: number): string => {
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${paint(`${p(loopSeq)}/${p(turnSeq)}/${p(sequence)}`, "dim")} `;
};

// The active prompt only represents progress below completion in three cells.
export const progressLabel = (percent: number): string =>
    paint(`${Math.max(0, Math.min(99, Math.trunc(percent)))}%`.padStart(3, " "), "dim");

// Extract the authored SEND text without terminal interpretation ({§cli-presentation-loading}).
export const extractSendBody = (txUnknown: unknown): string => {
    const tx = txUnknown as { body?: string | { raw?: unknown } | null } | null;
    const body = tx?.body;
    const raw = typeof body === "string" ? body : body?.raw;
    return typeof raw === "string" ? raw : "";
};

// Provider reasoning is neither working memory nor speech. Give it one quiet visual lane
// without inventing a log coordinate or status it does not own.
export const renderReasoning = (content: string): string => ModelText.plain(content)
    .split("\n")
    .map((line, index) => `${index === 0 ? "💭 " : "   "}${paint(line, "dim")}`)
    .join("\n");

// {§message-arrival} — an arrival is an inbound SEND row the daemon published: the sender's
// statement, with the causal `source` when another actor caused it (plurnk-service #706).
export const isArrivalEntry = (entry: LogEntryWire): boolean =>
    entry.op === "SEND" && entry.origin === "_plurnk" && objectOf(entry.attrs)?.kind === "message";

// The viewer's own messages: the typed line at the prompt is already their record, so the
// arrivals the bridge sourced to this thread render nowhere else (#79).
export const isOwnArrival = (entry: LogEntryWire, threadId: string): boolean =>
    isArrivalEntry(entry) && typeof entry.source === "string"
    && entry.source.startsWith(`agui://anonymous/threads/${encodeURIComponent(threadId)}/`);

export const isResponseMessage = (entry: LogEntryWire, threadId?: string): boolean => {
    if ((entry.op !== "SEND" && entry.op !== "KILL") || entry.status_rx < 200 || entry.status_rx >= 300 || entry.inherited_history === 1) return false;
    const reply = objectOf(entry.attrs)?.kind === "reply";
    if (!reply && entry.source != null) return false;
    const answers = objectOf(entry.rx)?.answers;
    if (!Array.isArray(answers)) return false;
    const prefix = threadId === undefined ? "agui://anonymous/threads/"
        : `agui://anonymous/threads/${encodeURIComponent(threadId)}/messages/`;
    return !reply && entry.origin === "model" && answers.length === 0
        || answers.some((address) => typeof address === "string" && address.startsWith(prefix));
};

// The target URI a log entry addressed — `scheme://host/pathname#fragment`, or
// the bare pathname when scheme is null (the daemon's file:// shortcut). null
// when the entry has no path at all (a broadcast SEND). One source for both the
// waterfall render and the LOOK cycler — no synthesis, render what the daemon sent.
export const entryTarget = (entry: LogEntryWire): string | null => {
    if (entry.pathname === null) return null;
    return entry.scheme !== null
        ? `${entry.scheme}://${entry.hostname ?? ""}${entry.pathname}${entry.fragment !== null ? `#${entry.fragment}` : ""}`
        : entry.pathname;
};

export const entryScope = (entry: LogEntryWire): string | null =>
    entry.lineMarker === null ? null : `<${entry.lineMarker.marks.join(",")}>`;

// The row names the operation as the model wrote it: the row's `op` is the heading token, an
// operation keyword or an execution's runtime tag (plurnk-service #659).
export const operationIdentity = (entry: LogEntryWire): string => entry.op;

// The authored target text when the wire carries it; the daemon's address otherwise.
export const authoredTarget = (entry: LogEntryWire): string | null => {
    const raw = (objectOf(entry.tx)?.target as { raw?: unknown } | null | undefined)?.raw;
    return typeof raw === "string" ? raw : entryTarget(entry);
};

// The matcher as authored on the heading (`/regex/i`, `~query`, `&symbol`, a bare glob).
export const authoredPattern = (entry: LogEntryWire): string | null => {
    const raw = (objectOf(entry.tx)?.matcher as { raw?: unknown } | null | undefined)?.raw;
    return typeof raw === "string" && raw.length > 0 ? raw : null;
};

// One COPY/MOVE operand keeps its own target, scope, and matcher together.
const selectionText = (selection: unknown): string | null => {
    const operand = objectOf(selection);
    if (operand === null) return null;
    const raw = (operand.target as { raw?: unknown } | null | undefined)?.raw;
    const marks = (operand.lineMarker as { marks?: unknown } | null | undefined)?.marks;
    const matcher = (operand.matcher as { raw?: unknown } | null | undefined)?.raw;
    const parts = [typeof raw === "string" ? `(${raw})` : null, Array.isArray(marks) ? `<${marks.join(",")}>` : null, typeof matcher === "string" ? matcher : null];
    const text = parts.filter((part): part is string => part !== null).join(" ");
    return text.length === 0 ? null : text;
};

const spanLength = (returned: unknown): number | null => {
    if (!Array.isArray(returned) || returned.length !== 2) return null;
    const [start, end] = returned;
    if (typeof start !== "number" || typeof end !== "number") return null;
    return Math.max(0, end - start + 1);
};

// What the receipt returned, in the receipt's own unit: a FIND's returned items, a READ's
// returned lines (a pattern read carries its matched lines as `lineOrdinals`). Other
// operations return no countable thing. Never derived from a body.
export const receiptCount = (entry: LogEntryWire): number | null => {
    const rx = objectOf(entry.rx);
    if (rx === null) return null;
    const range = objectOf(rx.range);
    if (entry.op === "READ") {
        if (Array.isArray(rx.lineOrdinals)) return rx.lineOrdinals.length;
        return spanLength(range?.returned);
    }
    if (entry.op === "FIND") {
        const returned = spanLength(range?.returned);
        if (returned !== null) return returned;
        return typeof range?.total === "number" ? range.total : null;
    }
    return null;
};

// The structured result's own words for an unsuccessful outcome: the Problem title, else
// the detail, else the bare status. A 204 with nothing countable carries its detail too.
export const outcomeTitle = (entry: LogEntryWire): string | null => {
    const rx = objectOf(entry.rx);
    if (entry.status_rx >= 400) {
        const title = objectOf(rx?.problem)?.title;
        if (typeof title === "string" && title.length > 0) return title;
        return typeof rx?.detail === "string" && rx.detail.length > 0 ? rx.detail : String(entry.status_rx);
    }
    if (entry.status_rx === 204 && typeof rx?.detail === "string" && receiptCount(entry) === null) return rx.detail;
    return null;
};

// A collapsed fan-out or a concluded execution renders the row with facts the wire settled
// elsewhere than on this one entry.
export interface RowOverride {
    target?: string;
    count?: number | null;
    failed?: boolean;
    failure?: string | null;
}

const styledOutcome = (text: string, failed: boolean): string =>
    `— ${paint(ModelText.plain(text), failed ? "failure" : "dim")}`;

// An execution still open when the following turn begins: its row once, in grey, with no
// outcome yet; the conclusion renders it again ({§cli-what-is-not-rendered}).
export const renderPendingRow = (entry: LogEntryWire): string =>
    paint(stripVTControlCharacters(renderOperationRow(entry, { failed: false, failure: null })), "dim");

// {plurnk#104} — every body in the waterfall is a preview: at most a third of the terminal's rows,
// never fewer than three, and the rest is named with the address LOOK reads it at. This is
// scrollback; the reasoning lane ({§cli-provider-reasoning}) is a separate, live window.
export const previewRows = (rows: number): number => Math.max(3, Math.floor(rows / 3));

export const previewLines = (lines: readonly string[], rows: number, more: (remaining: number) => string): string[] => {
    const max = previewRows(rows);
    return lines.length <= max ? [...lines] : [...lines.slice(0, max), more(lines.length - max)];
};

export const entryAddress = (entry: LogEntryWire): string =>
    `log:///${entry.loop_seq}/${entry.turn_seq}/${entry.sequence}/${entry.op ?? "error"}`;

export const previewMore = (entry: LogEntryWire, remaining: number): string =>
    `… +${remaining} lines · /look ${entryAddress(entry)}`;

// A preview line: four columns in and dim, the reasoning lane's fade without its italic, so
// it competes with neither the operations nor the delivered answer.
export const PREVIEW_OFFSET = "    ";
export const previewLine = (line: string): string => `${PREVIEW_OFFSET}${paint(line, "dim")}`;

// The authored body beneath its row, previewed.
export const renderBodyPreview = (entry: LogEntryWire, rows: number): string | null => {
    const body = ModelText.plain(extractSendBody(entry.tx)).trimEnd();
    if (body.length === 0) return null;
    return previewLines(body.split("\n"), rows, (remaining) => previewMore(entry, remaining)).map(previewLine).join("\n");
};

// A row and, beneath it, the preview of its authored body. A spaced block closes with a blank
// row; an execution's block is left open because its output preview follows it.
export const renderOperationBlock = (entry: LogEntryWire, override: RowOverride = {}, rows: number = process.stdout.rows ?? 24, spaced = false): string => {
    const row = renderOperationRow(entry, override);
    const preview = renderBodyPreview(entry, rows);
    return preview === null ? row : `${row}\n${preview}${spaced ? "\n" : ""}`;
};

// `OP (target) <scope> /pattern/ {n} aside — problem title`, one line, literal text.
export const renderOperationRow = (entry: LogEntryWire, override: RowOverride = {}): string => {
    const failed = override.failed ?? (override.failure !== undefined && override.failure !== null || entry.status_rx >= 400);
    const parts = [paint(ModelText.plain(operationIdentity(entry)), "bold", failed ? "failure" : "success")];
    const tx = objectOf(entry.tx);
    if (entry.op === "COPY" || entry.op === "MOVE") {
        for (const operand of [selectionText(tx?.source), selectionText(tx?.destination)]) {
            if (operand !== null) parts.push(ModelText.plain(operand));
        }
    } else {
        const target = override.target ?? authoredTarget(entry);
        if (target !== null) parts.push(`(${ModelText.plain(target)})`);
        const scope = entryScope(entry);
        if (scope !== null) parts.push(scope);
        const pattern = authoredPattern(entry);
        if (pattern !== null) parts.push(ModelText.plain(pattern));
    }
    const count = override.count === undefined ? receiptCount(entry) : override.count;
    if (count !== null) parts.push(`{${count}}`);
    const aside = entryAside(entry);
    if (aside !== null) parts.push(paint(aside, "dim", "italic"));
    const outcome = override.failure === undefined ? outcomeTitle(entry) : override.failure;
    if (outcome !== null) parts.push(styledOutcome(outcome, failed));
    return parts.join(" ");
};

interface Fanout { target: string; matched: number; index: number; count: number }

const fanoutOf = (entry: LogEntryWire): Fanout | null => {
    const fanout = objectOf(objectOf(entry.attrs)?.fanout);
    if (fanout === null) return null;
    const { target, matched, index, count } = fanout;
    return typeof target === "string" && typeof matched === "number" && typeof index === "number" && typeof count === "number"
        ? { target, matched, index, count }
        : null;
};

export type FanoutVerdict =
    | { kind: "row" }
    | { kind: "suppressed" }
    | { kind: "collapsed"; override: RowOverride };

// A glob READ lands one receipt row per path ({§read-fan-out} in the service SPEC), each
// stamped with the authored glob. The waterfall shows the authored statement once, when its
// last row has arrived, counting the paths it read; a failed path names the collapsed row.
export class FanoutCollapse {
    #failures = new Map<string, string>();

    admit(entry: LogEntryWire): FanoutVerdict {
        const fanout = fanoutOf(entry);
        if (fanout === null) return { kind: "row" };
        const key = `${entry.loop_seq}/${entry.turn_seq}/${fanout.target}`;
        if (entry.status_rx >= 400 && !this.#failures.has(key)) {
            this.#failures.set(key, outcomeTitle(entry) ?? String(entry.status_rx));
        }
        if (fanout.index < fanout.count - 1) return { kind: "suppressed" };
        const failure = this.#failures.get(key) ?? null;
        this.#failures.delete(key);
        return { kind: "collapsed", override: { target: fanout.target, count: fanout.count, failed: failure !== null, failure } };
    }
}

export interface LoopUsage {
    // A deliberately narrow projection of the contracts-owned accounting schema.
    // This client renders aggregate input/output and exact USD without becoming a
    // second schema or accounting implementation; JSON output preserves the whole
    // envelope received from plurnk.terminated.
    accounting: {
        requests: readonly unknown[];
        usage: {
            inputTokens?: number;
            outputTokens?: number;
        } | null;
        costUsd: string | null;
    };
    // The daemon reports curation pressure and physical request occupancy as two
    // independent gauges. The client renders them verbatim and never compares
    // model-independent weight with provider tokens.
    curationWeight: number | null;
    curationBudget: number | null;
    contextTokens: number | null;
    contextCapacity: number | null;
    meta: Record<string, unknown>;
}

// Compact token count: 49152 → "49k", 980 → "980". The gauge stays terse.
const formatK = (n: number): string => n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;

const gauge = (label: "cur" | "ctx", used?: number | null, capacity?: number | null): string => {
    if (used === undefined || used === null
        || capacity === undefined || capacity === null || capacity <= 0) return "";
    const pct = Math.round((used / capacity) * 100);
    return ` · ${label} ${pct}%/${formatK(capacity)}`;
};

export const curationGauge = (weight?: number | null, budget?: number | null): string =>
    gauge("cur", weight, budget);

export const contextGauge = (tokens?: number | null, capacity?: number | null): string =>
    gauge("ctx", tokens, capacity);

// usage is absent for non-model ops (op.exec / op.parse have no provider
// call) — those render no token part. It is NOT a fallback for missing
// data: a model loop always carries real usage (plurnk-service #197).
const STRIKE_THRESHOLD = "https://problems.plurnk.xyz/engine/rails/strike-threshold";
const INVALID_EMISSION_EXHAUSTED = "https://problems.plurnk.xyz/engine/generation/invalid-emission-exhausted";

// The status class is not the verdict. Preserve the exact terminal Problem so
// unrelated engine failures do not masquerade as rail strike-outs.
export const terminalStatusLabel = (result: OperationResult): string => {
    const status = result.status ?? 0;
    if (status === 500) {
        if (result.problem?.type === STRIKE_THRESHOLD) return "strike-out";
        if (result.problem?.type === INVALID_EMISSION_EXHAUSTED) return "invalid emission";
        return "failed";
    }
    return status === 200 ? "done"
        : status === 413 ? "budget overflow"
            : status === 429 ? "turn ceiling"
                : status === 499 ? "cancelled"
                    : status === 508 ? "loop detected"
                        : `final ${status}`;
};

const isZeroDecimal = (value: string): boolean => /^0(?:\.0+)?$/.test(value);

export const renderSummary = (turns: number, wallMs: number, result: OperationResult, hitMaxTurns: boolean, usage?: LoopUsage): string => {
    const tag = hitMaxTurns ? "maxTurns" : terminalStatusLabel(result);
    const ms = wallMs >= 1000 ? `${(wallMs / 1000).toFixed(2)}s` : `${wallMs}ms`;
    let tokenPart = "";
    if (usage !== undefined) {
        const aggregate = usage.accounting.usage;
        tokenPart = ` · ↓${abbreviatedCount(aggregate?.inputTokens)} ↑${abbreviatedCount(aggregate?.outputTokens)}`;
        tokenPart += curationGauge(usage.curationWeight, usage.curationBudget);
        tokenPart += contextGauge(usage.contextTokens, usage.contextCapacity);
        const costUsd = usage.accounting.costUsd;
        if (costUsd !== null && !isZeroDecimal(costUsd)) {
            tokenPart += ` · loop $${money(costUsd)}`;
        }
    }
    return paint(`  ${tag} · ${turns} turn${turns === 1 ? "" : "s"} · ${ms}${tokenPart}`, "dim");
};
