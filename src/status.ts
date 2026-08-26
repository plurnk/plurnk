import type { Notice } from "./diagnostics.ts";

export type StatusLifecycle = "idle" | "running" | "parked" | "completed" | "cancelled" | "failed";

export interface StatusActivity {
    label: string;
    percent: number | null;
}

export interface ClientStatus {
    lifecycle: StatusLifecycle;
    model: string | null;
    turn: number | null;
    activity: StatusActivity | null;
}

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
    if (value.turn !== null) parts.push(`T${value.turn}`);
    if (value.activity !== null) {
        parts.push(value.activity.percent === null
            ? value.activity.label
            : `${value.activity.label}${value.activity.label.length > 0 ? " " : ""}${value.activity.percent}%`);
    }
    return parts.filter((part) => part.length > 0).join(" · ");
};

// One mutable human status row. Routine progress repaints at most once per
// interval; lifecycle/turn changes and terminal progress remain immediate.
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
