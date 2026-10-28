// Five-stream descriptor helpers, row formatters, and workspace/session family command execution
// ({§cli-output-channels}, {§cli-configuration-source}, {§cli-repl-mode}).

import { createHash } from "node:crypto";
import { existsSync, fstatSync, readFileSync, statSync, writeSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Writable } from "node:stream";
import { parseEnv } from "node:util";
import type { AcpClient } from "./acp-client.ts";
import type { AcpSession, AcpTranscriptItem } from "./acp-session.ts";

export interface ClientStreams {
    readonly stdin: NodeJS.ReadableStream;
    readonly stdout: NodeJS.WritableStream;
    readonly stderr: NodeJS.WritableStream;
    readonly events: NodeJS.WritableStream;
    readonly reasoning: NodeJS.WritableStream;
}

const createNoopWritable = (): Writable =>
    new Writable({
        write(_chunk, _encoding, callback) {
            callback();
        },
    });

const createFdWritable = (fd: number): Writable => {
    try {
        const stat = fstatSync(fd);
        if (!stat.isFIFO() && !stat.isSocket() && !stat.isFile() && !stat.isCharacterDevice()) {
            return createNoopWritable();
        }
    } catch {
        return createNoopWritable();
    }
    return new Writable({
        write(chunk: Buffer | string, encoding, callback) {
            try {
                const buf = Buffer.isBuffer(chunk)
                    ? chunk
                    : Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8");
                writeSync(fd, buf);
                callback();
            } catch (err) {
                const code = (err as NodeJS.ErrnoException)?.code;
                if (code === "EBADF" || code === "EPIPE" || code === "EINVAL") {
                    callback();
                    return;
                }
                callback(err instanceof Error ? err : new Error(String(err)));
            }
        },
    });
};

export const openProcessStreams = (overrides?: Partial<ClientStreams>): ClientStreams => ({
    stdin: overrides?.stdin ?? process.stdin,
    stdout: overrides?.stdout ?? process.stdout,
    stderr: overrides?.stderr ?? process.stderr,
    events: overrides?.events ?? createFdWritable(3),
    reasoning: overrides?.reasoning ?? createFdWritable(4),
});

export const writeEventJsonl = (events: NodeJS.WritableStream, payload: unknown): void => {
    events.write(`${JSON.stringify(payload)}\n`);
};

export const writeErrorJsonl = (stderr: NodeJS.WritableStream, payload: unknown): void => {
    stderr.write(`${JSON.stringify(payload)}\n`);
};

export const mintGateHash = (sessionId: string, kind: string, seq: number): string =>
    createHash("sha256")
        .update(`${sessionId}:${kind}:${String(seq)}:${String(Date.now())}`)
        .digest("hex")
        .slice(0, 8);

export const extractOpenPaths = (promptText: string, projectRoot: string | undefined): string[] => {
    if (!projectRoot || projectRoot.length === 0) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const match of promptText.matchAll(/(?:^|\s)@([^\s]+)/gu)) {
        const rawToken = match[1]?.replace(/[.,;:!?)]+$/u, "") ?? "";
        if (rawToken.length === 0) continue;
        const candidate = resolve(projectRoot, rawToken);
        const rel = relative(projectRoot, candidate);
        if (rel.startsWith("..") || rel.length === 0) continue;
        try {
            if (existsSync(candidate) && statSync(candidate).isFile()) {
                if (!seen.has(rel)) {
                    seen.add(rel);
                    result.push(rel);
                }
            }
        } catch {
            // ignore inaccessible paths
        }
    }
    return result;
};

export const extractChronologicalHistory = (targetSession: AcpSession): AcpTranscriptItem[] => {
    const visibleItems = targetSession.items.filter((item) => {
        if (item.kind === "user_message" || item.kind === "agent_message") {
            return item.text.length > 0;
        }
        if (item.kind === "tool_call") {
            const itemPlurnk = (item.meta?.plurnk ?? undefined) as
                | { op?: string; origin?: string; attrs?: { kind?: string } }
                | undefined;
            const op = itemPlurnk?.op ?? item.name ?? "";
            const target = item.locations[0]?.path ?? "";
            if (
                itemPlurnk?.origin === "_plurnk" &&
                op === "READ" &&
                (itemPlurnk.attrs?.kind === "emission" || target.startsWith("ops://"))
            ) {
                return false;
            }
            if (
                itemPlurnk?.origin === "_plurnk" &&
                op === "EDIT" &&
                itemPlurnk.attrs?.kind === "entry_materialized"
            ) {
                return false;
            }
            return true;
        }
        return false;
    });
    const idOf = (item: (typeof visibleItems)[number]): number | undefined => {
        const id = (item.meta?.plurnk as { id?: unknown } | undefined)?.id;
        return typeof id === "number" ? id : undefined;
    };
    const firstId = visibleItems.map(idOf).find((id): id is number => id !== undefined);
    const lastId = visibleItems
        .map(idOf)
        .findLast((id): id is number => id !== undefined);
    return firstId !== undefined && lastId !== undefined && firstId > lastId
        ? visibleItems.toReversed()
        : visibleItems;
};

export const formatFamilyRows = (family: string, result: Record<string, unknown>): string => {
    const definitions = Array.isArray(result.definitions) ? result.definitions : [];
    if (definitions.length === 0) {
        return `${family}: none\n`;
    }
    const lines: string[] = [];
    for (const item of definitions) {
        const d = item as Record<string, unknown>;
        const alias = String(d.alias ?? "");
        const state = String(d.state ?? "active");
        const def = (d.definition ?? {}) as Record<string, unknown>;
        const type = typeof def.type === "string" ? def.type : "";
        const target =
            typeof def.command === "string"
                ? def.command
                : typeof def.url === "string"
                  ? def.url
                  : typeof def.source === "string"
                    ? def.source
                    : typeof def.value === "string"
                      ? def.value
                      : "";
        const prov = (d.provenance ?? {}) as Record<string, unknown>;
        const source = typeof prov.source === "string" ? `source=${prov.source}` : "";
        const rowParts = [alias, state, type, target, source].filter((p) => p.length > 0);
        lines.push(rowParts.join("  "));
    }
    return `${lines.join("\n")}\n`;
};

export const formatModelsRows = (result: Record<string, unknown>): string => {
    const items = Array.isArray(result.items) ? result.items : [];
    let out = "";
    for (const item of items) {
        const r = item as Record<string, unknown>;
        out += `${String(r.selector ?? "")}\t${String(r.modelName ?? r.model ?? "")}\n`;
    }
    return out;
};

export const formatWorkspacesRows = (result: Record<string, unknown>): string => {
    const workspaces = Array.isArray(result.workspaces) ? result.workspaces : [];
    let out = "";
    for (const item of workspaces) {
        const w = item as Record<string, unknown>;
        out += `${String(w.name ?? w.id)}\t${String(w.project_root ?? "")}\n`;
    }
    return out;
};

export const formatLogEntries = (entries: readonly unknown[]): string => {
    let out = "";
    for (const entry of entries) {
        const e = entry as Record<string, unknown>;
        out += `${String(e.loop_seq)}/${String(e.turn_seq)}/${String(e.sequence)}\t${String(e.op ?? "")}\t${String(e.status_rx ?? e.status ?? "")}\n`;
    }
    return out;
};

export const executeFamilyCommand = async (
    client: AcpClient,
    family: string,
    args: readonly string[],
    binding: {
        readonly sessionId?: string;
        readonly workspace?: string;
        readonly session?: string;
        readonly cwd?: string;
    },
    cwd: string,
    io: {
        readonly json?: boolean;
        readonly stdout: NodeJS.WritableStream;
        readonly onError: (problem: {
            readonly type: string;
            readonly title: string;
            readonly status: number;
            readonly detail: string;
        }) => void;
    },
): Promise<void> => {
    let scopePrefix = family === "env" ? "session" : "workspace";
    const filteredArgs: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
        const tok = args[i]!;
        if (tok === "--scope" && args[i + 1]) {
            scopePrefix = args[i + 1] === "workspace" ? "workspace" : "session";
            i += 1;
            continue;
        }
        if (tok.startsWith("--scope=")) {
            scopePrefix = tok.slice("--scope=".length) === "workspace" ? "workspace" : "session";
            continue;
        }
        filteredArgs.push(tok);
    }
    const sub = filteredArgs[0] ?? "list";
    const rest = filteredArgs.slice(1);
    const writeResult = (result: Record<string, unknown>): void => {
        io.stdout.write(io.json ? `${JSON.stringify(result, null, 2)}\n` : `${JSON.stringify(result)}\n`);
    };

    if (sub === "list") {
        const result = await client.action<Record<string, unknown>>(
            `${scopePrefix}.${family}.list`,
            {},
            binding,
        );
        if (io.json) {
            io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
            io.stdout.write(formatFamilyRows(family, result));
        }
        return;
    }
    if (sub === "discover") {
        const query = rest.join(" ");
        const result = await client.action<Record<string, unknown>>(
            `${scopePrefix}.${family}.discover`,
            query.length > 0 ? { query, source: query } : {},
            binding,
        );
        io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
    }
    if (sub === "enable" || sub === "disable" || sub === "remove") {
        const target = rest[0] ?? "";
        const param = family === "members" ? { file: target } : { alias: target };
        const result = await client.action<Record<string, unknown>>(
            `${scopePrefix}.${family}.${sub}`,
            param,
            binding,
        );
        writeResult(result);
        return;
    }
    if ((sub === "add" || sub === "replace") && family === "mcp") {
        const alias = rest[0] ?? "";
        const target = rest[1] ?? "";
        const extraArgs = rest.slice(2);
        const definition = /^https?:\/\//iu.test(target)
            ? { name: alias, type: "streamable-http", url: target }
            : {
                  name: alias,
                  type: "stdio",
                  command: target,
                  ...(extraArgs.length > 0 ? { args: extraArgs } : {}),
              };
        const result = await client.action<Record<string, unknown>>(
            `workspace.mcp.${sub}`,
            { alias, definition },
            binding,
        );
        writeResult(result);
        return;
    }
    if ((sub === "add" || sub === "replace") && family === "skills") {
        const alias = rest[0] ?? "";
        const source = rest[1] ?? "";
        const refIdx = rest.indexOf("--ref");
        const ref = refIdx >= 0 ? rest[refIdx + 1] : undefined;
        const definition = {
            name: alias,
            source,
            ...(ref !== undefined ? { ref } : {}),
        };
        const result = await client.action<Record<string, unknown>>(
            `workspace.skills.${sub}`,
            { alias, definition },
            binding,
        );
        writeResult(result);
        return;
    }
    if (sub === "add" && family === "members") {
        const result = await client.action<Record<string, unknown>>(
            "workspace.members.add",
            { files: rest },
            binding,
        );
        writeResult(result);
        return;
    }
    if ((sub === "add" || sub === "replace") && family === "env") {
        const alias = rest[0] ?? "";
        const value = rest.slice(1).join(" ");
        const result = await client.action<Record<string, unknown>>(
            `${scopePrefix}.env.${sub}`,
            { alias, definition: { value } },
            binding,
        );
        writeResult(result);
        return;
    }
    if (sub === "import" && family === "env") {
        const filePath = rest[0];
        if (!filePath) {
            io.onError({
                type: "https://problems.plurnk.xyz/client/usage",
                title: "Missing env import path",
                status: 400,
                detail: "usage: /env import <path>",
            });
            return;
        }
        const parsed = parseEnv(readFileSync(resolve(cwd, filePath), "utf8"));
        const entries = Object.entries(parsed);
        let landed = 0;
        for (const [alias, val] of entries) {
            try {
                await client.action(
                    `${scopePrefix}.env.add`,
                    { alias, definition: { value: String(val ?? "") } },
                    binding,
                );
                landed += 1;
            } catch (err) {
                io.onError({
                    type: "https://problems.plurnk.xyz/client/command-failed",
                    title: "Env import entry failed",
                    status: 400,
                    detail: err instanceof Error ? err.message : String(err),
                });
            }
        }
        const scopeDesc = scopePrefix === "workspace" ? "workspace defaults" : "this session only";
        io.stdout.write(`imported ${String(landed)} of ${String(entries.length)} into ${scopeDesc}\n`);
        return;
    }
    if ((sub === "add" || sub === "replace") && family === "schedule") {
        const alias = rest[0] ?? "";
        const sessionArg = rest[1] ?? "";
        const rule = rest[2] ?? "";
        const prompt = rest.slice(3).join(" ");
        const target = sessionArg.startsWith("session://") ? sessionArg : `session://${sessionArg}`;
        const result = await client.action<Record<string, unknown>>(
            `workspace.schedule.${sub}`,
            { alias, definition: { rule, target, prompt } },
            binding,
        );
        writeResult(result);
        return;
    }
    const result = await client.action<Record<string, unknown>>(
        `${scopePrefix}.${family}.${sub}`,
        rest.length > 0 ? { args: rest } : {},
        binding,
    );
    writeResult(result);
};
