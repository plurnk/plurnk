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
// waterfall line. Resolved via log.read on the attached run + a client-side
// coordinate match: log.read carries each entry's full tx/rx, and (unlike
// `entry.read({target:"log:///L/T/S"})`, which 404s on this daemon — SPEC drift,
// see Open ecosystem deps) it actually returns the content. The coordinate is
// run-relative, so target the conversation's run with `--run <model-run>`.
// Accepts zero-padded display form (03/01/02) or bare (3/1/2) alike.
export const parseCoord = (raw: string): [number, number, number] | null => {
    const parts = raw.split("/");
    if (parts.length !== 3) return null;
    const nums = parts.map((p) => (/^\d+$/.test(p.trim()) ? Number(p) : NaN));
    if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
    return [nums[0], nums[1], nums[2]];
};

// The human-readable body of an entry: a READ's result content, else the op's
// own body (SEND/PLAN/EDIT carry it on tx.body), else null → caller pretty-prints.
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

export const runRead = async (rpc: Rpc, coord: string, opts: { json: boolean }): Promise<number> => {
    const parsed = parseCoord(coord);
    if (parsed === null) {
        process.stderr.write("usage: plurnk read <loop>/<turn>/<seq>   (e.g. plurnk read 3/1/2)\n");
        return 64;
    }
    const [loop, turn, seq] = parsed;
    const { entries } = await rpc.call("log.read", {}) as LogReadResult;
    const match = entries.find((e) => e.loop_seq === loop && e.turn_seq === turn && e.sequence === seq);
    if (match === undefined) {
        process.stderr.write(`no entry at ${loop}/${turn}/${seq} in the attached run`
            + ` (the conversation lives in the model run — try --run <model-run>)\n`);
        return 4;
    }
    if (opts.json) {
        process.stdout.write(`${JSON.stringify({ schemaVersion: JSON_SCHEMA_VERSION, coord: `${loop}/${turn}/${seq}`, entry: match })}\n`);
        return 0;
    }
    // Text mode: the entry's content if it has a body, else the entry structure.
    process.stdout.write(`${extractEntryContent(match) ?? JSON.stringify(match, null, 2)}\n`);
    return 0;
};
