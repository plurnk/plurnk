import { ProblemError, clientTransportStateInvalid } from "./diagnostics.ts";
import { Validator, type FunctionalityPreparationActivity, type JsonSchema, type ModelRoute, type ProviderUsage } from "@plurnk/plurnk-contracts";
import preparationSchema from "@plurnk/plurnk-contracts/schema/FunctionalityPreparationActivity.json" with { type: "json" };
import type { LoopUsage } from "./render.ts";
import { countWithSubtotal, costWithSubtotal } from "./figures.ts";
import ModelText from "./model-text.ts";

// The session's running total of time — every concluded loop adds its turns and wall time. Spend is
// the daemon's ({§cli-status-spend}), never tallied here.
export interface SessionTally {
    turns: number;
    wallMs: number;
}

export const EMPTY_TALLY: SessionTally = Object.freeze({ turns: 0, wallMs: 0 });

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

export interface StatusOutcome { turns: number; wallMs: number }

export const tallyOutcome = (tally: SessionTally, outcome: StatusOutcome): SessionTally => ({
    turns: tally.turns + outcome.turns,
    wallMs: tally.wallMs + outcome.wallMs,
});

// What the status line knows beyond the gauge: where it is, and the session so far.
export interface StatusContext {
    workspace: string | null;
    worker: string | null;
    place?: string;
    child: string | null;
    tally: SessionTally;
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
    knownCostUsd: string | null;
    knownInputTokens: number | null;
    knownOutputTokens: number | null;
}

export const turnAccountingFromNotice = (notice: {
    source?: unknown;
    kind?: unknown;
    accounting?: unknown;
}): TurnAccounting | null => {
    if (notice.source !== "engine:turn" || notice.kind !== "turn_generated") return null;
    const accounting = notice.accounting;
    if (typeof accounting !== "object" || accounting === null) return null;
    const a = accounting as Partial<Record<keyof TurnAccounting, unknown>>;
    return {
        costUsd: typeof a.costUsd === "string" ? a.costUsd : null,
        inputTokens: typeof a.inputTokens === "number" ? a.inputTokens : null,
        outputTokens: typeof a.outputTokens === "number" ? a.outputTokens : null,
        knownCostUsd: typeof a.knownCostUsd === "string" ? a.knownCostUsd : typeof a.costUsd === "string" ? a.costUsd : null,
        knownInputTokens: typeof a.knownInputTokens === "number" ? a.knownInputTokens : typeof a.inputTokens === "number" ? a.inputTokens : null,
        knownOutputTokens: typeof a.knownOutputTokens === "number" ? a.knownOutputTokens : typeof a.outputTokens === "number" ? a.outputTokens : null,
    };
};

export const accrueTurnAccounting = (
    accrued: TurnAccounting | null,
    turn: TurnAccounting,
): TurnAccounting => accrued === null ? turn : {
    costUsd: accrued.costUsd === null || turn.costUsd === null ? null : addDecimal(accrued.costUsd, turn.costUsd),
    inputTokens: accrued.inputTokens === null || turn.inputTokens === null ? null : accrued.inputTokens + turn.inputTokens,
    outputTokens: accrued.outputTokens === null || turn.outputTokens === null ? null : accrued.outputTokens + turn.outputTokens,
    knownCostUsd: accrued.knownCostUsd === null ? turn.knownCostUsd : turn.knownCostUsd === null ? accrued.knownCostUsd : addDecimal(accrued.knownCostUsd, turn.knownCostUsd),
    knownInputTokens: addNullable(accrued.knownInputTokens, turn.knownInputTokens),
    knownOutputTokens: addNullable(accrued.knownOutputTokens, turn.knownOutputTokens),
};

// {§cli-identity-effort} — effort is identity-grade: `alias[low]` is a chosen level, `alias(low)`
// a provider default the daemon seeded (brackets read as chosen, parentheses as given); bare when
// the model has no effort dimension. The daemon states the source; the client never infers it.
export const formatRouteIdentity = (route: ModelRoute): string => {
    const name = route.alias ?? `${route.provider}/${route.model}`;
    if (route.effort === undefined) return name;
    return route.effortSource === "default"
        ? `${name}(${route.effort})`
        : `${name}[${route.effort}]`;
};

export interface ClientStatus {
    preparation?: readonly FunctionalityPreparationActivity[];
    waitUntil?: number | null;
    lifecycle: StatusLifecycle;
    model: string | null;
    // {§cli-status-project-root} — the daemon's bound folder, never create-time client options, and
    // its label for that folder, the only spelling shown.
    projectRoot?: string | null;
    projectLabel?: string | null;
    // {plurnk#58} — the prompt prefix names the place as workspace/loop/turn; the gauge owns both numbers.
    loopId: number | null;
    packetCount: number | null;
    activity: StatusActivity | null;
    // {§cli-status-children} — the bound worker's alive direct children, counted in the daemon's tree
    // beneath it; null when the transport carries no gauge.
    children: number | null;
    // {§cli-status-gated} — the workers anywhere in that tree waiting on a gate; null without a gauge.
    gated: number | null;
    // {§cli-workers-topology} — each of those workers' pending gates, by id; absent without a gauge.
    gates?: Readonly<Record<number, number>>;
    // {§cli-status-spend} — the daemon's spend of the bound worker and its descendants since the
    // worker began; null when nothing is spent or the transport carries no gauge.
    spend?: TurnAccounting | null;
    // {§cli-status-clock} — when the latest loop first ran and when it concluded, Unix milliseconds.
    claimedAt?: number | null;
    terminatedAt?: number | null;
    // {§cli-status-inbox} — the accepted messages the bound worker has not read; absent without a gauge.
    inbox?: readonly InboxMessage[];
    // {§cli-status-streams} — the addresses of the streams the bound worker holds open; absent without a gauge.
    openStreams?: readonly string[];
}

// {§cli-status-inbox} — plurnk-service {§agui-message-acceptance}: a message the daemon accepted for the bound worker,
// by its address, the id this client gave it when it sent it, and the lifecycle of the loop holding it.
export interface InboxMessage {
    readonly path: string;
    readonly id: string | null;
    readonly loopId: number;
    readonly lifecycle: StatusLifecycle;
}

// {§cli-status-clock} — a loop this client did not start runs on the daemon's clock: from when it first
// ran, else from when this client began observing it.
export const observedClockStart = (status: ClientStatus, now: number): number => status.claimedAt ?? now;

// {§cli-history-lost} — the gauge reports no loop where the previous gauge on the same binding
// reported one: the daemon minted the worker anew under its old name.
export const historyLost = (previousLoopId: number | null, loopId: number | null): boolean =>
    previousLoopId !== null && loopId === null;

export interface RuntimeStatusGauge {
    waitUntil: unknown;
    lifecycle: string;
    model: ModelRoute | null;
    loopId: number | null;
    packetCount: number;
    descendants: unknown;
    spend: unknown;
    claimedAt: unknown;
    terminatedAt: unknown;
    inbox: unknown;
    streams: unknown;
}

// The service owns the tree and cumulative accounting. This is only its human
// projection, sharing the published usage schema and exact decimal arithmetic.
const spendAccounting = (value: unknown): TurnAccounting | null => {
    const fail = (): never => { throw new TypeError("Invalid runtime spend."); };
    if (value === null || typeof value !== "object" || Array.isArray(value)) return fail();
    const { requests, usage, knownUsage, costUsd, knownCostUsd } = value as {
        requests?: unknown; usage?: unknown; knownUsage?: unknown; costUsd?: unknown; knownCostUsd?: unknown;
    };
    if (!Number.isSafeInteger(requests) || (requests as number) < 0) return fail();
    if (costUsd !== null && (typeof costUsd !== "string" || !/^[0-9]+(?:\.[0-9]+)?$/u.test(costUsd))) return fail();
    if (knownCostUsd !== null && (typeof knownCostUsd !== "string" || !/^[0-9]+(?:\.[0-9]+)?$/u.test(knownCostUsd))) return fail();
    for (const part of [usage, knownUsage]) {
        if (part === null) continue;
        const schema = Validator.schemaByRef("https://schemas.plurnk.xyz/ProviderUsage.json");
        if (schema === null) throw new Error("The contracts package is missing ProviderUsage.");
        if (!Validator.validateJsonSchemaInstance(schema as JsonSchema, part).valid) return fail();
    }
    if (requests === 0) return null;
    const totals = usage as ProviderUsage | null;
    const known = knownUsage as ProviderUsage | null;
    return { inputTokens: totals?.inputTokens ?? null, outputTokens: totals?.outputTokens ?? null, costUsd,
        knownInputTokens: known?.inputTokens ?? null, knownOutputTokens: known?.outputTokens ?? null, knownCostUsd };
};

// plurnk-service {§agui-action-binding}: `status` and `budget` are the bound worker's gauge, and a Run that
// binds no worker carries neither; every Run carries its workspace.
export interface StatusGaugeEnvelope {
    plurnk: { status?: RuntimeStatusGauge; workspace: WorkspaceState };
    budget?: Record<string, unknown>;
}

// A gauge from a Run that binds a worker.
export interface WorkerGauge extends StatusGaugeEnvelope {
    plurnk: { status: RuntimeStatusGauge; workspace: WorkspaceState };
    budget: Record<string, unknown>;
}

export const isWorkerGauge = (gauge: StatusGaugeEnvelope): gauge is WorkerGauge => gauge.plurnk.status !== undefined;

const LIFECYCLES: ReadonlySet<string> = new Set<StatusLifecycle>([
    "idle", "queued", "running", "parked", "completed", "cancelled", "failed",
]);

// {§cli-status-children} — a child that still owes a result is alive; a parked one still owes it.
const ALIVE: ReadonlySet<string> = new Set<StatusLifecycle>(["queued", "running", "parked"]);

// {§cli-status-children} {§cli-status-gated} — plurnk-service {§agui-status-descendants}: the daemon's tree beneath
// the bound worker, read for the two counts the status line shows. A direct child is one whose parent is not in the
// tree: every other parent is the one worker the tree hangs from.
const treeCounts = (value: unknown): { children: number; gated: number; gates: Record<number, number> } => {
    const fail = (): never => { throw new TypeError("Invalid runtime descendants."); };
    if (!Array.isArray(value)) return fail();
    const tree = value.map((entry: unknown) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return fail();
        const { id, name, parentWorkerId, kind, lifecycle, gates } = entry as Record<string, unknown>;
        if (!Number.isSafeInteger(id) || !Number.isSafeInteger(parentWorkerId) || typeof name !== "string"
            || typeof kind !== "string" || typeof lifecycle !== "string" || !LIFECYCLES.has(lifecycle)
            || !Number.isSafeInteger(gates) || (gates as number) < 0) return fail();
        return { id: id as number, parentWorkerId: parentWorkerId as number, lifecycle, gates: gates as number };
    });
    const ids = new Set(tree.map(({ id }) => id));
    const direct = tree.filter(({ parentWorkerId }) => !ids.has(parentWorkerId));
    if (ids.size !== tree.length || new Set(direct.map(({ parentWorkerId }) => parentWorkerId)).size > 1) return fail();
    return {
        children: direct.filter(({ lifecycle }) => ALIVE.has(lifecycle)).length,
        gated: tree.filter(({ gates }) => gates > 0).length,
        gates: Object.fromEntries(tree.filter(({ gates }) => gates > 0).map(({ id, gates }) => [id, gates])),
    };
};

// {§cli-status-inbox} — the daemon's word on what the bound worker has not read; every entry readable or a broken gauge.
const inboxMessages = (value: unknown): InboxMessage[] => {
    const fail = (): never => { throw new TypeError("Invalid runtime inbox."); };
    if (!Array.isArray(value)) return fail();
    return value.map((entry: unknown) => {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return fail();
        const { path, id, loopId, lifecycle } = entry as Record<string, unknown>;
        if (typeof path !== "string" || !(id === null || typeof id === "string") || !Number.isSafeInteger(loopId)
            || typeof lifecycle !== "string" || !LIFECYCLES.has(lifecycle)) return fail();
        return { path, id: id as string | null, loopId: loopId as number, lifecycle: lifecycle as StatusLifecycle };
    });
};

// {§cli-status-streams} — plurnk-service {§agui-status-streams}: the streams the bound worker holds open, by address.
const openStreamAddresses = (value: unknown): string[] => {
    const fail = (): never => { throw new TypeError("Invalid runtime streams."); };
    if (!Array.isArray(value)) return fail();
    return value.map((entry: unknown) => {
        const target = entry !== null && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>).target : undefined;
        return typeof target === "string" ? target : fail();
    });
};

// {§cli-status-inbox} — the messages a concluded loop held without reading them: nothing will read them now.
export const unreadMessages = (inbox: readonly InboxMessage[] | undefined): InboxMessage[] =>
    (inbox ?? []).filter(({ lifecycle }) => lifecycle === "completed" || lifecycle === "cancelled" || lifecycle === "failed");

// {§cli-identity-effort} {§cli-workspaces-and-workers} — a Run's state is a cache taken when it started, never the
// identity: a value it newly carries that differs from the one the session holds is a change made elsewhere, which
// only a readback applies.
export const changedElsewhere = (carried: string | null, previous: string | null, held: string | null): boolean =>
    carried !== previous && carried !== held;

// {§cli-status-project-root} {§cli-status-preparation} — the bound workspace's folder, a path the client uses,
// the daemon's label, and the activity that belongs to the workspace rather than to its worker.
export interface WorkspaceState {
    // plurnk-service {§agui-workspace-state}: the bound workspace's identity and its current name.
    readonly id?: number;
    readonly name?: string;
    readonly projectRoot?: string | null;
    readonly projectLabel?: string | null;
    readonly preparation: unknown;
    readonly activity: unknown;
}

export type WorkspaceStatus = Pick<ClientStatus, "preparation" | "activity" | "projectRoot" | "projectLabel">;

export const projectWorkspaceState = (workspace: WorkspaceState): WorkspaceStatus => {
    const { projectRoot, projectLabel } = workspace;
    if (projectRoot !== undefined && projectRoot !== null && typeof projectRoot !== "string") {
        throw new TypeError("Invalid workspace project root.");
    }
    if (projectLabel !== undefined && projectLabel !== null && typeof projectLabel !== "string") {
        throw new TypeError("Invalid workspace project label.");
    }
    if (!Array.isArray(workspace.preparation)
        || workspace.preparation.some((item) => !Validator.validateJsonSchemaInstance(preparationSchema, item).valid)) {
        throw new TypeError("Invalid workspace preparation.");
    }
    let activity: StatusActivity | null = null;
    if (workspace.activity !== null) {
        if (typeof workspace.activity !== "object") throw new TypeError("Invalid workspace activity.");
        const raw = workspace.activity as { kind?: unknown; phase?: unknown; percent?: unknown };
        if (raw.kind !== "derivation" || typeof raw.phase !== "string") {
            throw new TypeError("Unsupported workspace activity.");
        }
        const percent = Number(raw.percent);
        activity = {
            label: raw.phase === "failed" ? "indexing failed" : raw.phase === "preparing" ? "preparing" : "indexing",
            percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.floor(percent))) : null,
        };
    }
    return {
        activity,
        preparation: workspace.preparation as FunctionalityPreparationActivity[],
        ...(projectRoot === undefined ? {} : { projectRoot }),
        ...(projectLabel === undefined ? {} : { projectLabel }),
    };
};

export const projectStatusGauge = (value: RuntimeStatusGauge, workspace: WorkspaceState): ClientStatus => {
    const place = projectWorkspaceState(workspace);
    if (!LIFECYCLES.has(value.lifecycle)) throw new TypeError(`Unknown runtime lifecycle '${value.lifecycle}'.`);
    if (!Number.isSafeInteger(value.packetCount) || value.packetCount < 0) {
        throw new TypeError(`Invalid runtime packet count '${value.packetCount}'.`);
    }
    const model = value.model === null ? null : Validator.assertModelRoute(value.model);
    if (value.waitUntil !== null && (typeof value.waitUntil !== "number" || !Number.isFinite(value.waitUntil) || value.waitUntil < 0)) {
        throw new TypeError("Invalid runtime wait deadline.");
    }
    const { children, gated, gates } = treeCounts(value.descendants);
    for (const stamp of [value.claimedAt, value.terminatedAt]) {
        if (stamp !== null && (!Number.isSafeInteger(stamp) || (stamp as number) < 0)) throw new TypeError("Invalid runtime loop timing.");
    }
    return {
        lifecycle: value.lifecycle as StatusLifecycle,
        model: model === null ? null : formatRouteIdentity(model),
        loopId: value.loopId,
        packetCount: value.packetCount,
        children,
        gated,
        gates,
        waitUntil: value.waitUntil as number | null,
        spend: spendAccounting(value.spend),
        claimedAt: value.claimedAt as number | null,
        terminatedAt: value.terminatedAt as number | null,
        inbox: inboxMessages(value.inbox),
        openStreams: openStreamAddresses(value.streams),
        ...place,
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
    if (next.plurnk?.workspace === null || typeof next.plurnk?.workspace !== "object") {
        throw new ProblemError(clientTransportStateInvalid("STATE is missing plurnk.workspace"));
    }
    // plurnk-service {§agui-action-binding}: the worker's gauge is its status and budget together, or neither.
    const worker = next.plurnk.status !== undefined;
    if (worker !== (next.budget !== undefined) || (worker && (next.budget === null || typeof next.budget !== "object"))) {
        throw new ProblemError(clientTransportStateInvalid("STATE carries plurnk.status without budget, or budget without plurnk.status"));
    }
    if (isWorkerGauge(next)) projectStatusGauge(next.plurnk.status, next.plurnk.workspace);
    else projectWorkspaceState(next.plurnk.workspace);
    return { handled: true, gauge: next };
};

// {§cli-workers-topology} {§cli-loops} — a list marks what is under way or ended early; an idle or concluded one carries
// no mark.
export const lifecycleMark = (value: StatusLifecycle): string => value === "completed" ? "" : lifecycleGlyph(value, "");

const lifecycleGlyph = (value: StatusLifecycle, idleGlyph: string): string => value === "running" ? "⌛︎"
    : value === "queued" ? "⏳"
    : value === "parked" ? "💤"
        : value === "completed" ? "⏹️"
            : value === "cancelled" ? "🛑"
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
// {§cli-status-disconnected} — an observation that a failure ended, the daemon stopping, a revoked credential or a
// lost connection, leaves the session disconnected; the client's own cancellation does not.
export const disconnection = (failure: { readonly type: string } | null): boolean =>
    failure !== null && !failure.type.endsWith("/client/transport/cancelled");

export const renderStatusLine = (
    value: ClientStatus,
    context: StatusContext,
    options: { yolo?: boolean; disconnected?: boolean } = {},
): string => {
    // {plurnk#58} — the glyph IS the lifecycle; the word beside it said the same thing twice, and
    // the turn count moved into the prompt prefix where the place is named.
    // {plurnk#104} — YOLO sits beside the lifecycle glyph, and the model precedes live counters.
    const glyph = lifecycleGlyph(value.lifecycle, "");
    const glyphs = [...(options.disconnected === true ? ["🔌"] : []), ...(options.yolo === true ? ["🔥"] : []), ...(glyph.length > 0 ? [glyph] : [])];
    const head = glyphs.length > 0 ? glyphs.join(" ") : value.lifecycle;
    const parts: string[] = [];
    if (value.model !== null) parts.push(`🎲 ${value.model}`);
    const running = value.lifecycle === "running";
    const unfinished = running || value.lifecycle === "parked" || value.lifecycle === "queued";
    const clockActive = unfinished && context.runningSince !== null;
    const elapsed = clockActive ? Math.max(0, (context.now ?? Date.now()) - context.runningSince!) : 0;
    if (context.tally.turns > 0 || running || clockActive) parts.push(formatDuration(context.tally.wallMs + elapsed));
    // {§cli-status-spend} — the gauge's own figure, the highest cost that is not incorrect: the total, or
    // the known subtotal beside the unknown remainder.
    const spend = value.spend ?? null;
    if (spend !== null) {
        parts.push(`↓${countWithSubtotal(spend.inputTokens, spend.knownInputTokens)} ↑${countWithSubtotal(spend.outputTokens, spend.knownOutputTokens)}`);
        const cost = costWithSubtotal(spend.costUsd, spend.knownCostUsd);
        if (cost.length > 0) parts.push(cost);
    }
    if (running && context.doing) parts.push(doingText(context.doing, context.now ?? Date.now()));
    // {§cli-status-children} — a known zero hides the child segment, including its model override.
    const ant = [...(value.children === null ? [] : [String(value.children)]), ...(context.child === null ? [] : [context.child])];
    if (value.children !== 0 && ant.length > 0) parts.push(`🐜 ${ant.join(" ")}`);
    // {§cli-status-gated} — none waiting, or no gauge, shows nothing.
    if (value.gated !== null && value.gated > 0) parts.push(`🚦 ${value.gated}`);
    // {§cli-status-inbox} — the messages accepted for the worker that it has yet to read; none shows nothing.
    const waiting = (value.inbox ?? []).filter(({ lifecycle }) => ALIVE.has(lifecycle)).length;
    if (waiting > 0) parts.push(`📨 ${waiting}`);
    if (value.lifecycle === "parked" && value.waitUntil != null) {
        const seconds = Math.ceil(Math.max(0, value.waitUntil - (context.now ?? Date.now())) / 1000);
        parts.push(seconds === 0 ? "updates due" : `updates in ${formatDuration(seconds * 1000)}`);
    }
    if (value.activity !== null) parts.push(activityText(value.activity));
    for (const { family, alias, phase, since } of value.preparation ?? []) {
        const capability = ModelText.plain(alias === null ? family : `${family}/${alias}`);
        parts.push(`${phase} ${capability} ${formatDuration(Math.max(0, (context.now ?? Date.now()) - Date.parse(since)))}`);
    }
    // A glyph is two columns wide: a second space keeps the first dot off its shoulder.
    const activity = parts.length === 0 ? head : `${head}${glyphs.length > 0 ? " " : ""} · ${parts.join(" · ")}`;
    const label = value.projectLabel ?? "";
    const redundant = context.place !== undefined && context.workspace !== null && context.workspace === label;
    const folder = redundant ? "" : ModelText.plain(label).replaceAll("\n", "\\n").replaceAll("\t", "\\t");
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

    settle(outcome?: StatusOutcome): void {
        if (outcome !== undefined) {
            this.#context = {
                ...this.#context,
                tally: tallyOutcome(this.#context.tally, outcome),
                runningSince: null,
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
