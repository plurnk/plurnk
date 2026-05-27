// Read-only subcommands: `plurnk models`, `plurnk session list`, `plurnk log read`.
// Each is a thin wrapper around a daemon RPC plus a small renderer; output
// goes to stdout (the product), trace/errors to stderr — same posture as CLI
// mode per SPEC.md §2.1.

import type Rpc from "./rpc.ts";
import { formatPlain } from "./cli.ts";
import type { LogEntryWire } from "./render.ts";

// ─── Shared rendering helpers ─────────────────────────────────────────

// Simple column-aligned table. Renders header + rows; no header borders.
const renderTable = (headers: string[], rows: string[][]): string => {
    const widths = headers.map((h, i) =>
        Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
    const fmt = (cells: string[]) =>
        cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
    return [fmt(headers), ...rows.map(fmt)].join("\n");
};

// ─── plurnk models ────────────────────────────────────────────────────

interface ProviderAlias {
    alias: string;
    provider: string;
    model: string;
    active: boolean;
}

export const runModels = async (rpc: Rpc, opts: { json: boolean }): Promise<number> => {
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

// ─── plurnk session list ──────────────────────────────────────────────

interface SessionRow {
    id: number;
    name: string;
    project_root: string | null;
    created_at: string;
    cost_pico: number;
}

const formatCost = (picoUsd: number): string => {
    if (picoUsd === 0) return "0";
    const usd = picoUsd / 1e12;
    if (usd < 0.01) return `$${(usd * 100).toFixed(4)}¢`;
    return `$${usd.toFixed(4)}`;
};

export const runSessionList = async (rpc: Rpc, opts: { json: boolean }): Promise<number> => {
    const { sessions } = await rpc.call("session.list") as { sessions: SessionRow[] };
    if (opts.json) {
        process.stdout.write(`${JSON.stringify(sessions)}\n`);
        return 0;
    }
    if (sessions.length === 0) {
        process.stdout.write("(no sessions; run `plurnk` to create one)\n");
        return 0;
    }
    const rows = sessions.map((s) => [
        s.name,
        s.project_root ?? "(headless)",
        s.created_at,
        formatCost(s.cost_pico),
    ]);
    process.stdout.write(`${renderTable(["name", "project_root", "created", "cost"], rows)}\n`);
    return 0;
};

// ─── plurnk log read ──────────────────────────────────────────────────

// Caller has already attached the session via attachOrCreateSession; we just
// call log.read on the attached run. Filters thread through to the RPC.

interface LogReadResult {
    status: number;
    entries: LogEntryWire[];
}

export interface LogReadFilters {
    loopId?: number;
    turnId?: number;
    sinceId?: number;
    limit?: number;
}

export const runLogRead = async (
    rpc: Rpc,
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
