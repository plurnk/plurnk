import { ProblemError, clientTransportStateInvalid } from "./diagnostics.ts";
import { Validator, type FunctionalityPreparationActivity, type JsonSchema, type ModelRoute, type ProviderUsage } from "@plurnk/plurnk-contracts";
import preparationSchema from "@plurnk/plurnk-contracts/schema/FunctionalityPreparationActivity.json" with { type: "json" };
import type { LoopUsage } from "./render.ts";
import { abbreviatedCount, money } from "./figures.ts";
import ModelText from "./model-text.ts";

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

export interface StatusOutcome { turns: number; wallMs: number; usage?: LoopUsage; descendants?: TurnAccounting | null }

export const tallyOutcome = (tally: SessionTally, outcome: StatusOutcome): SessionTally => {
    const aggregate = outcome.usage?.accounting.usage;
    const cost = outcome.usage?.accounting.costUsd ?? null;
    const concluded = {
        turns: tally.turns + outcome.turns,
        wallMs: tally.wallMs + outcome.wallMs,
        inputTokens: addNullable(tally.inputTokens, aggregate?.inputTokens),
        outputTokens: addNullable(tally.outputTokens, aggregate?.outputTokens),
        costUsd: cost === null ? tally.costUsd : tally.costUsd === null ? cost : addDecimal(tally.costUsd, cost),
    };
    return outcome.descendants == null ? concluded : { ...concluded, ...accrueTurnAccounting(concluded, outcome.descendants) };
};

// What the status line knows beyond the gauge: where it is, and the session so far.
export interface StatusContext {
    workspace: string | null;
    worker: string | null;
    place?: string;
    // {§cli-workers-topology} — the bound worker's place among its siblings, newest first.
    position?: { index: number; count: number } | null;
    child: string | null;
    tally: SessionTally;
    // Running-loop accrual from turn_generated notices (#465); concluded totals
    // stay in tally, so the two never double-count.
    accrued?: TurnAccounting | null;
    runningSince: number | null;
    now?: number;
    doing?: WorkerDoing | null;
}

// {plurnk#91} — what the worker is doing this moment, from notices and log rows the daemon already
// sends: waiting on the model, or the operation that just resolved. A busy turn must not look like
// a hang, and neither needs new telemetry to tell apart.
export interface WorkerDoing {
    readonly phase: "awaiting" | "working";
    readonly since: number;
    readonly op: string | null;
    readonly target: string | null;
}

// The end of an address is the part that tells files apart.
const tail = (text: string, width: number): string => text.length <= width ? text : `…${text.slice(-(width - 1))}`;

const doingText = ({ phase, since, op, target }: WorkerDoing, now: number): string => {
    if (phase === "awaiting") return `awaiting model ${formatDuration(Math.max(0, now - since))}`;
    if (op === null) return "working";
    return target === null ? op : `${op} ${tail(target, 40)}`;
};

export type StatusLifecycle = "idle" | "queued" | "running" | "parked" | "completed" | "cancelled" | "failed";

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
// durable effort; when absent (older daemon, or a model with no reasoning
// dimension) the identity renders bare. Structural input so both contract eras format.
// {§cli-identity-effort} — effort is identity-grade: `alias[low]` is a chosen level, `alias(low)`
// a provider default the daemon seeded (brackets read as chosen, parentheses as given); bare when
// the model has no effort dimension. The daemon states the source; the client never infers it.
export const formatRouteIdentity = (route: {
    alias?: string;
    provider: string;
    model: string;
    effort?: string;
    effortSource?: "default" | "explicit";
}): string => {
    const name = route.alias ?? `${route.provider}/${route.model}`;
    if (route.effort === undefined) return name;
    return route.effortSource === "default"
        ? `${name}(${route.effort})`
        : `${name}[${route.effort}]`;
};

export interface ClientStatus {
    preparation?: readonly FunctionalityPreparationActivity[];
    lifecycle: StatusLifecycle;
    model: string | null;
    // {§cli-status-project-root} — the daemon's bound folder, never create-time client options.
    projectRoot?: string | null;
    // {plurnk#58} — the prompt prefix names the place as workspace/loop/turn; the gauge owns both numbers.
    loopId: number | null;
    packetCount: number | null;
    activity: StatusActivity | null;
    // {§cli-status-children} — the daemon's count of the bound worker's alive direct children; null
    // when the transport carries no gauge.
    children: number | null;
    descendants?: TurnAccounting | null;
}

// {§cli-conversation-lost} — the gauge reports no loop where the previous gauge on the same binding
// reported one: the daemon minted the conversation anew under its old name.
export const conversationLost = (previousLoopId: number | null, loopId: number | null): boolean =>
    previousLoopId !== null && loopId === null;

export interface RuntimeStatusGauge {
    preparation?: unknown;
    lifecycle: string;
    model: ModelRoute | null;
    loopId: number | null;
    packetCount: number;
    activity: unknown;
    children?: unknown;
    descendants?: unknown;
}

// The service owns the tree and cumulative accounting. This is only its human
// projection, sharing the published usage schema and exact decimal arithmetic.
const descendantAccounting = (value: unknown): TurnAccounting | null => {
    const fail = (): never => { throw new TypeError("Invalid runtime descendant accounting."); };
    if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
    const { requests, usage, costUsd } = value as { requests?: unknown; usage?: unknown; costUsd?: unknown };
    if (!Number.isSafeInteger(requests) || (requests as number) < 0) return fail();
    if (costUsd !== null && (typeof costUsd !== "string" || !/^[0-9]+(?:\.[0-9]+)?$/u.test(costUsd))) return fail();
    if (usage !== null) {
        const schema = Validator.schemaByRef("https://schemas.plurnk.xyz/ProviderUsage.json");
        if (schema === null) throw new Error("The contracts package is missing ProviderUsage.");
        if (!Validator.validateJsonSchemaInstance(schema as JsonSchema, usage).valid) return fail();
    }
    if (requests === 0) return null;
    const totals = usage as ProviderUsage | null;
    return { inputTokens: totals?.inputTokens ?? null, outputTokens: totals?.outputTokens ?? null, costUsd };
};

export interface StatusGaugeEnvelope {
    plurnk: { status: RuntimeStatusGauge; workspace?: { projectRoot?: string | null } };
    budget: Record<string, unknown>;
}

const LIFECYCLES: ReadonlySet<string> = new Set<StatusLifecycle>([
    "idle", "queued", "running", "parked", "completed", "cancelled", "failed",
]);

export const projectStatusGauge = (value: RuntimeStatusGauge, projectRoot?: string | null): ClientStatus => {
    if (projectRoot !== undefined && projectRoot !== null && typeof projectRoot !== "string") {
        throw new TypeError("Invalid workspace project root.");
    }
    if (!LIFECYCLES.has(value.lifecycle)) throw new TypeError(`Unknown runtime lifecycle '${value.lifecycle}'.`);
    if (!Number.isSafeInteger(value.packetCount) || value.packetCount < 0) {
        throw new TypeError(`Invalid runtime packet count '${value.packetCount}'.`);
    }
    const model = value.model === null ? null : Validator.assertModelRoute(value.model);
    if (value.preparation !== undefined && (!Array.isArray(value.preparation)
        || value.preparation.some((item) => !Validator.validateJsonSchemaInstance(preparationSchema, item).valid))) {
        throw new TypeError("Invalid runtime preparation.");
    }
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
    let children: number | null = null;
    if (value.children !== undefined) {
        if (!Number.isSafeInteger(value.children) || (value.children as number) < 0) {
            throw new TypeError(`Invalid runtime children count '${String(value.children)}'.`);
        }
        children = value.children as number;
    }
    return {
        lifecycle: value.lifecycle as StatusLifecycle,
        model: model === null ? null : formatRouteIdentity(model),
        loopId: value.loopId,
        packetCount: value.packetCount,
        activity,
        children,
        ...(value.preparation === undefined ? {} : { preparation: value.preparation as FunctionalityPreparationActivity[] }),
        ...(value.descendants === undefined ? {} : { descendants: descendantAccounting(value.descendants) }),
        ...(projectRoot === undefined ? {} : { projectRoot }),
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
    projectStatusGauge(next.plurnk.status, next.plurnk.workspace?.projectRoot);
    return { handled: true, gauge: next };
};

const lifecycleGlyph = (value: StatusLifecycle, idleGlyph: string): string => value === "running" ? "⌛︎"
    : value === "queued" ? "⏳"
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

// {plurnk#58} — thousands separators; an unknown count stays "?".

// The summary line's shape, aggregated over the session: the running loop adds
// its packets as turns, elapsed time, and settled per-turn accounting.
export const renderStatusLine = (
    value: ClientStatus,
    context: StatusContext,
    options: { yolo?: boolean } = {},
): string => {
    // {plurnk#58} — the glyph IS the lifecycle; the word beside it said the same thing twice, and
    // the turn count moved into the prompt prefix where the place is named.
    // {plurnk#104} — YOLO sits beside the lifecycle glyph, and the model precedes live counters.
    const glyph = lifecycleGlyph(value.lifecycle, "");
    const glyphs = [...(options.yolo === true ? ["🔥"] : []), ...(glyph.length > 0 ? [glyph] : [])];
    const head = glyphs.length > 0 ? glyphs.join(" ") : value.lifecycle;
    const parts: string[] = [];
    if (value.model !== null) parts.push(`🎲 ${value.model}`);
    const running = value.lifecycle === "running";
    const unfinished = running || value.lifecycle === "parked" || value.lifecycle === "queued";
    const clockActive = unfinished && context.runningSince !== null;
    const elapsed = clockActive ? Math.max(0, (context.now ?? Date.now()) - context.runningSince!) : 0;
    if (context.tally.turns > 0 || running || clockActive) parts.push(formatDuration(context.tally.wallMs + elapsed));
    const own = context.accrued ?? null;
    const accrued = !unfinished ? null : value.descendants == null ? own : accrueTurnAccounting(own, value.descendants);
    const combined = accrued === null ? context.tally : accrueTurnAccounting({
        costUsd: context.tally.costUsd,
        inputTokens: context.tally.inputTokens,
        outputTokens: context.tally.outputTokens,
    }, accrued);
    const { inputTokens, outputTokens, costUsd } = combined;
    if (inputTokens !== null || outputTokens !== null) parts.push(`↓${abbreviatedCount(inputTokens)} ↑${abbreviatedCount(outputTokens)}`);
    if (costUsd !== null && !/^0(?:\.0+)?$/.test(costUsd)) parts.push(`$${money(costUsd)}`);
    if (running && context.doing) parts.push(doingText(context.doing, context.now ?? Date.now()));
    // {§cli-status-children} — a known zero hides the child segment, including its model override.
    const ant = [...(value.children === null ? [] : [String(value.children)]), ...(context.child === null ? [] : [context.child])];
    if (value.children !== 0 && ant.length > 0) parts.push(`🐜 ${ant.join(" ")}`);
    if (value.activity !== null) parts.push(activityText(value.activity));
    for (const { family, alias, phase, since } of value.preparation ?? []) {
        const capability = ModelText.plain(alias === null ? family : `${family}/${alias}`);
        parts.push(`${phase} ${capability} ${formatDuration(Math.max(0, (context.now ?? Date.now()) - Date.parse(since)))}`);
    }
    // A glyph is two columns wide: a second space keeps the first dot off its shoulder.
    const activity = parts.length === 0 ? head : `${head}${glyphs.length > 0 ? " " : ""} · ${parts.join(" · ")}`;
    const folder = value.projectRoot == null ? "" : ModelText.plain(value.projectRoot).replaceAll("\n", "\\n").replaceAll("\t", "\\t");
    return [folder, context.place ?? "", activity].filter((part) => part.length > 0).join(" ");
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

    settle(outcome?: Omit<StatusOutcome, "descendants">): void {
        if (outcome !== undefined) {
            this.#context = {
                ...this.#context,
                tally: tallyOutcome(this.#context.tally, { ...outcome, descendants: this.#status.descendants }),
                accrued: null, runningSince: null,
            };
            this.update({});
        }
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
