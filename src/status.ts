import type { Notice } from "./diagnostics.ts";
import { ProblemError, clientTransportStateInvalid } from "./diagnostics.ts";
import { Validator, type ModelRoute } from "@plurnk/plurnk-contracts";

export type StatusLifecycle = "idle" | "running" | "parked" | "completed" | "cancelled" | "failed";

export interface StatusActivity {
    label: string;
    percent: number | null;
}

export interface ClientStatus {
    lifecycle: StatusLifecycle;
    model: string | null;
    packetCount: number | null;
    activity: StatusActivity | null;
}

export interface RuntimeStatusGauge {
    lifecycle: string;
    model: ModelRoute | null;
    loopId: number | null;
    packetCount: number;
    activity: unknown;
}

export interface StatusGaugeEnvelope {
    plurnk: { status: RuntimeStatusGauge };
    budget: Record<string, unknown>;
}

const LIFECYCLES: ReadonlySet<string> = new Set<StatusLifecycle>([
    "idle", "running", "parked", "completed", "cancelled", "failed",
]);

export const projectStatusGauge = (value: RuntimeStatusGauge): ClientStatus => {
    if (!LIFECYCLES.has(value.lifecycle)) throw new TypeError(`Unknown runtime lifecycle '${value.lifecycle}'.`);
    if (!Number.isSafeInteger(value.packetCount) || value.packetCount < 0) {
        throw new TypeError(`Invalid runtime packet count '${value.packetCount}'.`);
    }
    const model = value.model === null ? null : Validator.assertModelRoute(value.model);
    let activity: StatusActivity | null = null;
    if (value.activity !== null) {
        if (typeof value.activity !== "object") throw new TypeError("Invalid runtime activity.");
        const raw = value.activity as { kind?: unknown; phase?: unknown; percent?: unknown };
        if (raw.kind !== "derivation" || typeof raw.phase !== "string") {
            throw new TypeError("Unsupported runtime activity.");
        }
        const percent = Number(raw.percent);
        activity = {
            label: raw.phase === "failed" ? "indexing failed" : raw.phase === "preparing" ? "preparing" : "indexing",
            percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.floor(percent))) : null,
        };
    }
    return {
        lifecycle: value.lifecycle as StatusLifecycle,
        model: model === null ? null : model.alias ?? `${model.provider}/${model.model}`,
        packetCount: value.packetCount,
        activity,
    };
};

export const reduceStatusGauge = (
    current: StatusGaugeEnvelope | null,
    event: { type: string; snapshot?: unknown; delta?: unknown },
): { handled: false; gauge: StatusGaugeEnvelope | null } | { handled: true; gauge: StatusGaugeEnvelope } => {
    if (event.type !== "STATE_SNAPSHOT" && event.type !== "STATE_DELTA") {
        return { handled: false, gauge: current };
    }
    let next: StatusGaugeEnvelope;
    if (event.type === "STATE_SNAPSHOT") {
        if (event.snapshot === null || typeof event.snapshot !== "object") {
            throw new ProblemError(clientTransportStateInvalid("STATE_SNAPSHOT is not an object"));
        }
        next = structuredClone(event.snapshot) as StatusGaugeEnvelope;
    } else {
        if (current === null) throw new ProblemError(clientTransportStateInvalid("STATE_DELTA before any STATE_SNAPSHOT"));
        if (!Array.isArray(event.delta)) throw new ProblemError(clientTransportStateInvalid("STATE_DELTA delta is not an array"));
        next = structuredClone(current);
        for (const op of event.delta as Array<{ op?: unknown; path?: unknown; value?: unknown }>) {
            if (op.op !== "replace" || typeof op.path !== "string") {
                throw new ProblemError(clientTransportStateInvalid(`unsupported patch op ${JSON.stringify(op.op)} at ${JSON.stringify(op.path)}`));
            }
            const segments = op.path.split("/").slice(1).map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
            const leaf = segments.pop();
            const parent = segments.reduce<unknown>(
                (node, segment) => node !== null && typeof node === "object"
                    ? (node as Record<string, unknown>)[segment]
                    : undefined,
                next,
            );
            if (leaf === undefined || parent === null || typeof parent !== "object") {
                throw new ProblemError(clientTransportStateInvalid(`no parent for ${op.path}`));
            }
            (parent as Record<string, unknown>)[leaf] = op.value;
        }
    }
    if (next.plurnk?.status === undefined || next.budget === null || typeof next.budget !== "object") {
        throw new ProblemError(clientTransportStateInvalid("STATE is missing plurnk.status or budget"));
    }
    projectStatusGauge(next.plurnk.status);
    return { handled: true, gauge: next };
};

const finitePercent = (value: unknown): number | null => {
    const percent = Number(value);
    return Number.isFinite(percent)
        ? Math.max(0, Math.min(100, Math.floor(percent)))
        : null;
};

// Derivation Notices are an ephemeral activity source, not durable trace rows.
// `undefined` means "not this Notice family"; `null` is the terminal clear.
export const derivationActivity = (notice: Notice): StatusActivity | null | undefined => {
    if (notice.source !== "engine:derivation" || notice.kind !== "embed_progress") return undefined;
    const phase = typeof notice.phase === "string" ? notice.phase : null;
    if (phase === "complete") return null;
    if (phase === "failed") return { label: "indexing failed", percent: null };

    const completed = Number(notice.completed);
    const total = Number(notice.total);
    if (Number.isFinite(completed) && Number.isFinite(total) && total > 0 && completed >= total) return null;
    const explicit = finitePercent(notice.percent);
    const derived = Number.isFinite(completed) && Number.isFinite(total) && total > 0
        ? finitePercent((completed / total) * 100)
        : null;
    return { label: "indexing", percent: explicit ?? derived };
};

const lifecycleGlyph = (value: StatusLifecycle, idleGlyph: string): string => value === "running" ? "⌛︎"
    : value === "parked" ? "💤"
        : value === "completed" ? "⏹️"
            : value === "cancelled" ? "✋"
            : value === "failed" ? "❌"
                : idleGlyph;

export const renderStatusLine = (
    value: ClientStatus,
    options: { idleGlyph?: string } = {},
): string => {
    const parts = [lifecycleGlyph(value.lifecycle, options.idleGlyph ?? "")];
    if (value.model !== null) parts.push(`🤖 ${value.model}`);
    if (value.packetCount !== null) parts.push(`P${value.packetCount}`);
    if (value.activity !== null) {
        parts.push(value.activity.percent === null
            ? value.activity.label
            : `${value.activity.label}${value.activity.label.length > 0 ? " " : ""}${value.activity.percent}%`);
    }
    return parts.filter((part) => part.length > 0).join(" · ");
};

// One mutable human status row. Routine progress repaints at most once per
// interval; lifecycle/state changes and terminal progress remain immediate.
// Non-TTY output never receives ephemeral status history.
export default class TerminalStatusLine {
    #current: string | null = null;
    #lastRoutinePaint: number | null = null;
    #status: ClientStatus;
    #visible = false;
    readonly #enabled: boolean;
    readonly #intervalMs: number;
    readonly #now: () => number;
    readonly #write: (value: string) => void;

    constructor(
        write: (value: string) => void,
        enabled: boolean,
        initial: ClientStatus,
        options: { intervalMs?: number; now?: () => number } = {},
    ) {
        this.#write = write;
        this.#enabled = enabled;
        this.#status = initial;
        this.#intervalMs = options.intervalMs ?? 15_000;
        this.#now = options.now ?? Date.now;
    }

    update(patch: Partial<ClientStatus>, options: { routine?: boolean } = {}): void {
        const priorActivity = this.#status.activity;
        this.#status = { ...this.#status, ...patch };
        const rendered = renderStatusLine(this.#status);
        if (rendered === this.#current) return;
        this.#current = rendered;
        if (!this.#enabled) return;

        if (options.routine === true) {
            const now = this.#now();
            const terminal = this.#status.activity === null
                || this.#status.activity.label === "indexing failed";
            const starting = priorActivity === null && this.#status.activity !== null;
            if (!terminal && !starting && this.#lastRoutinePaint !== null
                && now - this.#lastRoutinePaint < this.#intervalMs) return;
            this.#lastRoutinePaint = now;
        }
        this.#paint();
    }

    durable(value: string): void {
        if (this.#visible) this.#write("\r\x1b[2K");
        this.#visible = false;
        this.#write(value);
        if (value.endsWith("\n")) this.#paint();
    }

    product(value: string, write: (value: string) => void, sharedTerminal: boolean): void {
        if (!this.#enabled || !sharedTerminal) {
            write(value);
            return;
        }
        if (this.#visible) this.#write("\r\x1b[2K");
        this.#visible = false;
        write(value);
        if (value.endsWith("\n")) this.#paint();
    }

    settle(): void {
        if (this.#visible) this.#write("\n");
        this.#visible = false;
        this.#current = null;
    }

    #paint(): void {
        if (!this.#enabled || this.#current === null || this.#current.length === 0) return;
        this.#write(`\r\x1b[2K${this.#current}`);
        this.#visible = true;
    }
}
