import { ProblemError, clientTransportStateInvalid } from "./diagnostics.ts";
import { Validator, type ModelRoute } from "@plurnk/plurnk-contracts";
import type { LoopUsage } from "./render.ts";

// The session's running total in the summary line's shape — every concluded
// loop adds its turns, wall time, and exact accounting.
export interface SessionTally {
    turns: number;
    wallMs: number;
    inputTokens: number | null;
    outputTokens: number | null;
    costUsd: string | null;
}

export const EMPTY_TALLY: SessionTally = Object.freeze({ turns: 0, wallMs: 0, inputTokens: null, outputTokens: null, costUsd: null });

// Exact decimal addition on the daemon's decimal strings — never a float.
const addDecimal = (a: string, b: string): string => {
    const [ai, af = ""] = a.split(".");
    const [bi, bf = ""] = b.split(".");
    const scale = Math.max(af.length, bf.length);
    const sum = BigInt(`${ai}${af.padEnd(scale, "0")}`) + BigInt(`${bi}${bf.padEnd(scale, "0")}`);
    const digits = sum.toString().padStart(scale + 1, "0");
    return scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
};

const addNullable = (a: number | null, b: number | null | undefined): number | null =>
    b === null || b === undefined ? a : (a ?? 0) + b;

export const tallyOutcome = (tally: SessionTally, outcome: { turns: number; wallMs: number; usage?: LoopUsage }): SessionTally => {
    const aggregate = outcome.usage?.accounting.usage;
    const cost = outcome.usage?.accounting.costUsd ?? null;
    return {
        turns: tally.turns + outcome.turns,
        wallMs: tally.wallMs + outcome.wallMs,
        inputTokens: addNullable(tally.inputTokens, aggregate?.inputTokens),
        outputTokens: addNullable(tally.outputTokens, aggregate?.outputTokens),
        costUsd: cost === null ? tally.costUsd : tally.costUsd === null ? cost : addDecimal(tally.costUsd, cost),
    };
};

// What the status line knows beyond the gauge: where it is, and the session so far.
export interface StatusContext {
    workspace: string | null;
    worker: string | null;
    child: string | null;
    tally: SessionTally;
    // Running-loop accrual from turn_generated notices (#465); concluded totals
    // stay in tally, so the two never double-count.
    accrued?: TurnAccounting | null;
    runningSince: number | null;
    now?: number;
}

export type StatusLifecycle = "idle" | "running" | "parked" | "completed" | "cancelled" | "failed";

export interface StatusActivity {
    label: string;
    percent: number | null;
}

// {§turn-accounting-notice} (#465) — the engine's turn_generated notice carries the
// turn's exact settled wire accounting; the client accrues it into a running
// loop figure so mid-run kill decisions never fly blind on price.
export interface TurnAccounting {
    costUsd: string | null;
    inputTokens: number | null;
    outputTokens: number | null;
}

export const turnAccountingFromNotice = (notice: {
    source?: unknown;
    kind?: unknown;
    accounting?: unknown;
}): TurnAccounting | null => {
    if (notice.source !== "engine:turn" || notice.kind !== "turn_generated") return null;
    const accounting = notice.accounting;
    if (typeof accounting !== "object" || accounting === null) return null;
    const a = accounting as { costUsd?: unknown; inputTokens?: unknown; outputTokens?: unknown };
    return {
        costUsd: typeof a.costUsd === "string" ? a.costUsd : null,
        inputTokens: typeof a.inputTokens === "number" ? a.inputTokens : null,
        outputTokens: typeof a.outputTokens === "number" ? a.outputTokens : null,
    };
};

export const accrueTurnAccounting = (
    accrued: TurnAccounting | null,
    turn: TurnAccounting,
): TurnAccounting => accrued === null ? turn : {
    costUsd: accrued.costUsd === null ? turn.costUsd : turn.costUsd === null ? accrued.costUsd : addDecimal(accrued.costUsd, turn.costUsd),
    inputTokens: accrued.inputTokens === null ? turn.inputTokens : turn.inputTokens === null ? accrued.inputTokens : accrued.inputTokens + turn.inputTokens,
    outputTokens: accrued.outputTokens === null ? turn.outputTokens : turn.outputTokens === null ? accrued.outputTokens : accrued.outputTokens + turn.outputTokens,
};

// {plurnk#41} — effort is identity-grade: contracts ≥1.14 routes carry the worker's
// durable reasoning policy; when absent (older daemon, or a model with no reasoning
// dimension) the identity renders bare. Structural input so both contract eras format.
export const formatRouteIdentity = (route: {
    alias?: string;
    provider: string;
    model: string;
    reasoningPolicy?: string;
}): string => {
    const name = route.alias ?? `${route.provider}/${route.model}`;
    return route.reasoningPolicy === undefined ? name : `${name}[${route.reasoningPolicy}]`;
};

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
        model: model === null ? null : formatRouteIdentity(model),
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

const lifecycleGlyph = (value: StatusLifecycle, idleGlyph: string): string => value === "running" ? "⌛︎"
    : value === "parked" ? "💤"
        : value === "completed" ? "⏹️"
            : value === "cancelled" ? "✋"
            : value === "failed" ? "❌"
                : idleGlyph;

export const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${(ms / 1000).toFixed(1)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
    return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
};

const activityText = ({ label, percent }: StatusActivity): string => {
    const indexing = label === "indexing" || label === "preparing" || label === "indexing failed";
    if (!indexing) return percent === null ? label : `${label} ${percent}%`;
    if (label === "indexing failed") return "🧮 failed";
    if (percent !== null) return `🧮 ${percent}%`;
    return `🧮 ${label}`;
};

// The summary line's shape, aggregated over the session: the running loop adds
// its packets as turns and its elapsed time; tokens and cost are concluded totals.
export const renderStatusLine = (
    value: ClientStatus,
    context: StatusContext,
    options: { idleGlyph?: string } = {},
): string => {
    const glyph = lifecycleGlyph(value.lifecycle, options.idleGlyph ?? "");
    const parts = [glyph.length > 0 ? `${glyph} ${value.lifecycle}` : value.lifecycle];
    const running = value.lifecycle === "running";
    const turns = context.tally.turns + (running ? value.packetCount ?? 0 : 0);
    const elapsed = running && context.runningSince !== null ? Math.max(0, (context.now ?? Date.now()) - context.runningSince) : 0;
    if (turns > 0 || running) parts.push(`${turns} turn${turns === 1 ? "" : "s"}`, formatDuration(context.tally.wallMs + elapsed));
    const accrued = running ? context.accrued ?? null : null;
    const combined = accrued === null ? context.tally : accrueTurnAccounting({
        costUsd: context.tally.costUsd,
        inputTokens: context.tally.inputTokens,
        outputTokens: context.tally.outputTokens,
    }, accrued);
    const { inputTokens, outputTokens, costUsd } = combined;
    if (inputTokens !== null || outputTokens !== null) parts.push(`↓${inputTokens ?? "?"} ↑${outputTokens ?? "?"}`);
    if (costUsd !== null && !/^0(?:\.0+)?$/.test(costUsd)) parts.push(`$${costUsd}`);
    if (value.model !== null) parts.push(`🎲 ${value.model}`);
    if (context.child !== null) parts.push(`🐜 ${context.child}`);
    if (context.workspace !== null) parts.push(context.workspace);
    if (context.worker !== null) parts.push(`worker://${context.worker}/`);
    if (value.activity !== null) parts.push(activityText(value.activity));
    return parts.join(" · ");
};

// One mutable human status row. Routine progress repaints at most once per
// interval; lifecycle/state changes and terminal progress remain immediate.
// Non-TTY output never receives ephemeral status history.
export default class TerminalStatusLine {
    #current: string | null = null;
    #lastRoutinePaint: number | null = null;
    #status: ClientStatus;
    #context: StatusContext;
    #visible = false;
    readonly #enabled: boolean;
    readonly #intervalMs: number;
    readonly #now: () => number;
    readonly #write: (value: string) => void;

    constructor(
        write: (value: string) => void,
        enabled: boolean,
        initial: ClientStatus,
        context: StatusContext,
        options: { intervalMs?: number; now?: () => number } = {},
    ) {
        this.#write = write;
        this.#enabled = enabled;
        this.#status = initial;
        this.#context = context;
        this.#intervalMs = options.intervalMs ?? 15_000;
        this.#now = options.now ?? Date.now;
    }

    update(patch: Partial<ClientStatus>): void {
        const prior = this.#status;
        this.#status = { ...this.#status, ...patch };
        const rendered = renderStatusLine(this.#status, this.#context);
        if (rendered === this.#current) return;
        this.#current = rendered;
        if (!this.#enabled) return;

        if (Object.hasOwn(patch, "activity") && prior.lifecycle === this.#status.lifecycle
            && prior.model === this.#status.model && prior.packetCount === this.#status.packetCount) {
            const now = this.#now();
            const terminal = this.#status.activity === null
                || this.#status.activity.label === "indexing failed";
            const starting = prior.activity === null && this.#status.activity !== null;
            if (!terminal && !starting && this.#lastRoutinePaint !== null
                && now - this.#lastRoutinePaint < this.#intervalMs) return;
            this.#lastRoutinePaint = now;
        }
        this.#paint();
    }

    // (#465) Accrue one turn's settled wire accounting into the running figure.
    accrue(turn: TurnAccounting): void {
        this.#context = { ...this.#context, accrued: accrueTurnAccounting(this.#context.accrued ?? null, turn) };
        this.update({});
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
