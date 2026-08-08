// Read-only subcommands: `plurnk models`, `plurnk workspace list`, `plurnk log read`.
// Each is a thin wrapper around a daemon RPC plus a small renderer; output
// goes to stdout (the product), trace/errors to stderr — same posture as CLI
// mode per SPEC.md §2.1.

// The minimal wire surface: any transport's verb caller satisfies it (AG-UI+
// actions or — until deletion day — the legacy WS Rpc).
export interface Caller { call(method: string, params?: object): Promise<unknown> }
import { formatPlain, JSON_SCHEMA_VERSION } from "./cli.ts";
import type { LogEntryWire } from "./render.ts";
import {
    ProblemError,
    clientSubcommandCoordinateInvalid,
    clientSubcommandEntryNotFound,
    clientSubcommandWorkspaceAmbiguous,
    clientSubcommandWorkspaceNotFound,
} from "./diagnostics.ts";

// ─── Shared rendering helpers ─────────────────────────────────────────

const useColor = process.env.NO_COLOR !== "1" && process.env.NO_COLOR !== "true";
const BOLD = useColor ? "\x1b[1m" : "";
const RESET = useColor ? "\x1b[0m" : "";

// Simple column-aligned table. Header row is bold; rows plain. No borders.
const renderTable = (headers: string[], rows: string[][]): string => {
    const widths = headers.map((h, i) =>
        Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
    const fmt = (cells: string[]) =>
        cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
    return [`${BOLD}${fmt(headers)}${RESET}`, ...rows.map(fmt)].join("\n");
};

// ─── plurnk models ────────────────────────────────────────────────────

interface ProviderAlias {
    alias: string;
    provider: string;
    model: string;
    active: boolean;
}

export const runModels = async (rpc: Caller, opts: { json: boolean }): Promise<number> => {
    const { aliases } = await rpc.call("providers.list") as { aliases: ProviderAlias[] };
    if (opts.json) {
        process.stdout.write(`${JSON.stringify(aliases)}\n`);
        return 0;
    }
    if (aliases.length === 0) {
        process.stdout.write("(no model aliases configured; set PLURNK_MODEL_<alias>=<provider>/<model> on the daemon)\n");
        return 0;
    }
    const rows = aliases.map((a) => [
        a.alias,
        a.provider,
        a.model,
        a.active ? "*" : "",
    ]);
    process.stdout.write(`${renderTable(["alias", "provider", "model", "active"], rows)}\n`);
    return 0;
};

// ─── plurnk workspace list ──────────────────────────────────────────────

interface WorkspaceRow {
    id: number;
    name: string;
    project_root: string | null;
    created_at: string;
    cost_usd: number | null;
}

const formatCost = (costUsd: number | null): string => {
    if (costUsd === null) return "unknown";
    if (costUsd === 0) return "0";
    if (costUsd < 0.01) return `${(costUsd * 100).toFixed(4)}¢`;
    return `$${costUsd.toFixed(4)}`;
};

export const runWorkspaceList = async (rpc: Caller, opts: { json: boolean }): Promise<number> => {
    const { workspaces } = await rpc.call("workspace.list") as { workspaces: WorkspaceRow[] };
    if (opts.json) {
        process.stdout.write(`${JSON.stringify(workspaces)}\n`);
        return 0;
    }
    if (workspaces.length === 0) {
        process.stdout.write("(no workspaces; run `plurnk` to create one)\n");
        return 0;
    }
    const rows = workspaces.map((s) => [
        s.name,
        s.project_root ?? "(headless)",
        s.created_at,
        formatCost(s.cost_usd),
    ]);
    process.stdout.write(`${renderTable(["name", "project_root", "created", "cost"], rows)}\n`);
    return 0;
};

// ─── plurnk workspace runs <name> ───────────────────────────────────────

interface WorkerRow {
    id: number;
    name: string;
    created_at: string;
    cost_usd: number | null;
}

export const runWorkspaceWorkers = async (
    rpc: Caller,
    workspaceName: string,
    opts: { json: boolean },
): Promise<number> => {
    // Look up the workspace id by name without attaching — workspace.workers accepts
    // an explicit id, so we don't need to spend an attach on a read-only call.
    const { workspaces } = await rpc.call("workspace.list") as { workspaces: WorkspaceRow[] };
    const matches = workspaces.filter((s) => s.name === workspaceName);
    if (matches.length === 0) {
        throw new ProblemError(clientSubcommandWorkspaceNotFound(workspaceName), 1);
    }
    if (matches.length > 1) {
        throw new ProblemError(clientSubcommandWorkspaceAmbiguous(workspaceName, matches.length), 1);
    }
    const { workers } = await rpc.call("workspace.workers", { id: matches[0].id }) as { workers: WorkerRow[] };
    if (opts.json) {
        process.stdout.write(`${JSON.stringify(workers)}\n`);
        return 0;
    }
    if (workers.length === 0) {
        process.stdout.write(`(workspace ${JSON.stringify(workspaceName)} has no workers)\n`);
        return 0;
    }
    const rows = workers.map((r) => [r.name, r.created_at, formatCost(r.cost_usd)]);
    process.stdout.write(`${renderTable(["name", "created", "cost"], rows)}\n`);
    return 0;
};

// ─── plurnk workspace rename ────────────────────────────────────────────

// workspace.rename mutates the ATTACHED workspace's name (a workspace is the world;
// its name is a mutable handle — unlike a run, which is immutable history).
// Resolve <name> by list, attach, rename. svc#248.
export const runWorkspaceRename = async (
    rpc: Caller,
    workspaceName: string,
    newName: string,
    opts: { json: boolean },
): Promise<number> => {
    const { workspaces } = await rpc.call("workspace.list") as { workspaces: WorkspaceRow[] };
    const matches = workspaces.filter((s) => s.name === workspaceName);
    if (matches.length === 0) {
        throw new ProblemError(clientSubcommandWorkspaceNotFound(workspaceName), 1);
    }
    if (matches.length > 1) {
        throw new ProblemError(clientSubcommandWorkspaceAmbiguous(workspaceName, matches.length), 1);
    }
    await rpc.call("workspace.attach", { id: matches[0].id });
    const result = await rpc.call("workspace.rename", { name: newName }) as { id: number; name: string };
    if (opts.json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return 0;
    }
    process.stdout.write(`renamed ${JSON.stringify(workspaceName)} → ${JSON.stringify(result.name)}\n`);
    return 0;
};

// ─── plurnk log read ──────────────────────────────────────────────────

// Caller has already attached the workspace via attachOrCreateSession; we just
// call log.read on the attached run. Filters thread through to the RPC.

interface LogReadResult {
    status: number;
    entries: LogEntryWire[];
}

export interface LogReadFilters {
    workerId?: number;   // pin a run by id (AG-UI+: no connection state — the pin rides params)
    loopId?: number;
    turnId?: number;
    sinceId?: number;
    limit?: number;
}

export const runLogRead = async (
    rpc: Caller,
    opts: { json: boolean; filters: LogReadFilters },
): Promise<number> => {
    const params: LogReadFilters = {};
    if (opts.filters.loopId !== undefined) params.loopId = opts.filters.loopId;
    if (opts.filters.turnId !== undefined) params.turnId = opts.filters.turnId;
    if (opts.filters.sinceId !== undefined) params.sinceId = opts.filters.sinceId;
    if (opts.filters.limit !== undefined) params.limit = opts.filters.limit;
    const { entries } = await rpc.call("log.read", params) as LogReadResult;
    if (opts.json) {
        process.stdout.write(`${JSON.stringify(entries)}\n`);
        return 0;
    }
    if (entries.length === 0) {
        process.stdout.write("(no entries match)\n");
        return 0;
    }
    for (const entry of entries) {
        process.stdout.write(`${formatPlain(entry)}\n`);
    }
    return 0;
};

// ─── plurnk read <L/T/S> ──────────────────────────────────────────────

// Drill into ONE log entry by its L/T/S coordinate — the address on every
// waterfall line. The CLEAN contract (svc#271): hand the display coordinate to
// log.read({loopSeq,turnSeq,sequence}); the daemon resolves it and returns the
// SINGLE entry's full shape (tx + rx). No fetch-all, no client-side coordinate
// match — the service owns resolution. The client renders the entry it's handed
// (picking the meaningful content per op is display logic, the client's job).
// Run-relative, so target the conversation's run with `--worker <model-run>`. Accepts
// zero-padded display form (03/01/02) or bare (3/1/2) alike.
export const parseCoord = (raw: string): [number, number, number] | null => {
    const parts = raw.split("/");
    if (parts.length !== 3) return null;
    const nums = parts.map((p) => (/^\d+$/.test(p.trim()) ? Number(p) : NaN));
    if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
    return [nums[0], nums[1], nums[2]];
};

// The human-readable body of an entry: a READ's result content, else the op's
// own body (SEND/PLAN/EDIT carry it on tx.body). Pure DISPLAY logic — the
// service already resolved the coordinate; this just picks what to show.
const extractEntryContent = (entry: LogEntryWire): string | null => {
    const rx = entry.rx as { content?: unknown } | null;
    const tx = entry.tx as { body?: unknown } | null;
    if (typeof rx?.content === "string" && rx.content.length > 0) return rx.content;
    const body = tx?.body;
    if (typeof body === "string" && body.length > 0) return body;
    // SEND/broadcast bodies arrive as { raw, json } — surface the raw text.
    if (body !== null && typeof body === "object") {
        const raw = (body as { raw?: unknown }).raw;
        if (typeof raw === "string" && raw.length > 0) return raw;
    }
    return null;
};

export const runRead = async (rpc: Caller, coord: string, opts: { json: boolean; workerId?: number }): Promise<number> => {
    const parsed = parseCoord(coord);
    if (parsed === null) {
        throw new ProblemError(clientSubcommandCoordinateInvalid(coord), 64);
    }
    const [loop, turn, seq] = parsed;
    // One clean call (svc#271): the daemon resolves the coordinate, returns the
    // single full entry (tx + rx). No fetch-all, no client-side coordinate match.
    const { entries } = await rpc.call("log.read", { loopSeq: loop, turnSeq: turn, sequence: seq, ...(opts.workerId !== undefined ? { workerId: opts.workerId } : {}) }) as LogReadResult;
    const entry = entries[0];
    if (entry === undefined) {
        throw new ProblemError(
            clientSubcommandEntryNotFound(`${loop}/${turn}/${seq}`, opts.workerId),
            4,
        );
    }
    if (opts.json) {
        process.stdout.write(`${JSON.stringify({ schemaVersion: JSON_SCHEMA_VERSION, coord: `${loop}/${turn}/${seq}`, entry })}\n`);
        return 0;
    }
    // Text mode: the entry's content if it has a body, else the entry structure.
    process.stdout.write(`${extractEntryContent(entry) ?? JSON.stringify(entry, null, 2)}\n`);
    return 0;
};
