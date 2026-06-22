// Read-only subcommands: `plurnk models`, `plurnk session list`, `plurnk log read`.
// Each is a thin wrapper around a daemon RPC plus a small renderer; output
// goes to stdout (the product), trace/errors to stderr — same posture as CLI
// mode per SPEC.md §2.1.

import type Rpc from "./rpc.ts";
import { formatPlain, JSON_SCHEMA_VERSION } from "./cli.ts";
import type { LogEntryWire } from "./render.ts";
import { report, clientSubcommandSessionNotFound, clientSubcommandSessionAmbiguous } from "./telemetry.ts";

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

// ─── plurnk session runs <name> ───────────────────────────────────────

interface RunRow {
    id: number;
    name: string;
    created_at: string;
    cost_pico: number;
}

export const runSessionRuns = async (
    rpc: Rpc,
    sessionName: string,
    opts: { json: boolean },
): Promise<number> => {
    // Look up the session id by name without attaching — session.runs accepts
    // an explicit id, so we don't need to spend an attach on a read-only call.
    const { sessions } = await rpc.call("session.list") as { sessions: SessionRow[] };
    const matches = sessions.filter((s) => s.name === sessionName);
    if (matches.length === 0) {
        report(clientSubcommandSessionNotFound(sessionName));
        return 1;
    }
    if (matches.length > 1) {
        report(clientSubcommandSessionAmbiguous(sessionName, matches.length));
        return 1;
    }
    const { runs } = await rpc.call("session.runs", { id: matches[0].id }) as { runs: RunRow[] };
    if (opts.json) {
        process.stdout.write(`${JSON.stringify(runs)}\n`);
        return 0;
    }
    if (runs.length === 0) {
        process.stdout.write(`(session ${JSON.stringify(sessionName)} has no runs)\n`);
        return 0;
    }
    const rows = runs.map((r) => [r.name, r.created_at, formatCost(r.cost_pico)]);
    process.stdout.write(`${renderTable(["name", "created", "cost"], rows)}\n`);
    return 0;
};

// ─── plurnk session rename ────────────────────────────────────────────

// session.rename mutates the ATTACHED session's name (a session is the world;
// its name is a mutable handle — unlike a run, which is immutable history).
// Resolve <name> by list, attach, rename. svc#248.
export const runSessionRename = async (
    rpc: Rpc,
    sessionName: string,
    newName: string,
    opts: { json: boolean },
): Promise<number> => {
    const { sessions } = await rpc.call("session.list") as { sessions: SessionRow[] };
    const matches = sessions.filter((s) => s.name === sessionName);
    if (matches.length === 0) {
        report(clientSubcommandSessionNotFound(sessionName));
        return 1;
    }
    if (matches.length > 1) {
        report(clientSubcommandSessionAmbiguous(sessionName, matches.length));
        return 1;
    }
    await rpc.call("session.attach", { id: matches[0].id });
    const result = await rpc.call("session.rename", { name: newName }) as { id: number; name: string };
    if (opts.json) {
        process.stdout.write(`${JSON.stringify(result)}\n`);
        return 0;
    }
    process.stdout.write(`renamed ${JSON.stringify(sessionName)} → ${JSON.stringify(result.name)}\n`);
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

// ─── plurnk read <L/T/S> ──────────────────────────────────────────────

// Drill into ONE log entry by its L/T/S coordinate — the address on every
// waterfall line. The CLEAN contract: hand the coordinate to the SERVICE via
// op.read of the Log scheme (§schemes/Log.ts coordinate addressing); the daemon
// resolves it and returns the content. The client renders what it's given — NO
// fetch-all, NO client-side coordinate match, NO tx/rx second-guessing (that was
// a protocol compromise — the client's job is the contract, not the daemon's).
// Run-relative, so target the conversation's run with `--run <model-run>`. Accepts
// zero-padded display form (03/01/02) or bare (3/1/2) alike.
// svc#271: op.read of a log:// entry returns only the rx receipt, so a non-READ
// entry (SEND/PLAN/EDIT) shows status metadata, not its tx body — visibly degraded
// until the service surfaces the full entry shape by coordinate. That's the
// forcing function, not something to paper over client-side.
export const parseCoord = (raw: string): [number, number, number] | null => {
    const parts = raw.split("/");
    if (parts.length !== 3) return null;
    const nums = parts.map((p) => (/^\d+$/.test(p.trim()) ? Number(p) : NaN));
    if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
    return [nums[0], nums[1], nums[2]];
};

export const runRead = async (rpc: Rpc, coord: string, opts: { json: boolean }): Promise<number> => {
    const parsed = parseCoord(coord);
    if (parsed === null) {
        process.stderr.write("usage: plurnk read <loop>/<turn>/<seq>   (e.g. plurnk read 3/1/2)\n");
        return 64;
    }
    const [loop, turn, seq] = parsed;
    // One clean call: the daemon resolves the coordinate and returns the content.
    const target = `log:///${loop}/${turn}/${seq}`;
    const r = await rpc.call("op.read", { target }) as { status: number; content: string | null; mimetype?: string };
    if (r.status === 404) {
        process.stderr.write(`no entry at ${loop}/${turn}/${seq} in the attached run`
            + ` (the conversation lives in the model run — try --run <model-run>)\n`);
        return 4;
    }
    if (r.status >= 400) {
        process.stderr.write(`read failed: ${r.status}\n`);
        return 4;
    }
    if (opts.json) {
        process.stdout.write(`${JSON.stringify({ schemaVersion: JSON_SCHEMA_VERSION, coord: `${loop}/${turn}/${seq}`, status: r.status, content: r.content, mimetype: r.mimetype ?? null })}\n`);
        return 0;
    }
    process.stdout.write(`${r.content ?? ""}\n`);
    return 0;
};
