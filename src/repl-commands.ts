// Five-stream descriptor helpers, row formatters, and workspace/session family command execution
// ({§cli-output-channels}, {§cli-configuration-source}, {§cli-repl-mode}).

import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, fstatSync, readFileSync, statSync, writeSync } from "node:fs";
import { relative, resolve } from "node:path";
import { Writable } from "node:stream";
import { parseEnv } from "node:util";
import type { AcpClient } from "./acp-client.ts";
import type { AcpSession, AcpTranscriptItem } from "./acp-session.ts";
import { receiveAuthorization } from "./oauth.ts";

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
    const visibleItems = targetSession.items
        .filter((item) => {
            if (item.kind === "user_message") {
                const published = (item.meta?.plurnk as { published?: unknown } | undefined)?.published;
                return published !== false && item.text.length > 0;
            }
            if (item.kind === "agent_message") {
                return item.text.length > 0;
            }
            if (item.kind === "tool_call") {
                const itemPlurnk = (item.meta?.plurnk ?? undefined) as
                    | { op?: string; origin?: string; attrs?: { kind?: string; distilled?: string } }
                    | undefined;
                const op = itemPlurnk?.op ?? item.name ?? "";
                const target = item.locations[0]?.path ?? "";
                if (
                    itemPlurnk?.origin === "_plurnk" &&
                    op === "read" &&
                    (itemPlurnk.attrs?.kind === "emission" || target.startsWith("ops://"))
                ) {
                    return false;
                }
                if (
                    itemPlurnk?.origin === "_plurnk" &&
                    op === "edit" &&
                    itemPlurnk.attrs?.kind === "entry_materialized"
                ) {
                    return false;
                }
                if (
                    op === "note" &&
                    typeof itemPlurnk?.attrs?.distilled === "string" &&
                    itemPlurnk.attrs.distilled.trim().length > 0
                ) {
                    return false;
                }
                return true;
            }
            return false;
        })
        .map((item) => {
            if (item.kind !== "tool_call") return item;
            const hasContentBlock = item.content.some((c) => c.type === "content");
            if (hasContentBlock) return item;
            const itemPlurnk = (item.meta?.plurnk ?? undefined) as { id?: unknown } | undefined;
            const terminalIds = item.content
                .filter(
                    (c): c is { readonly type: "terminal"; readonly terminalId: string } =>
                        c.type === "terminal" && typeof (c as { terminalId?: unknown }).terminalId === "string",
                )
                .map((c) => c.terminalId);
            if (terminalIds.length === 0 && typeof itemPlurnk?.id === "number") {
                terminalIds.push(`term:${String(itemPlurnk.id)}`);
            }
            const termOut = terminalIds
                .map((tid) => targetSession.terminals.get(tid)?.outputText ?? "")
                .join("");
            if (termOut.length === 0) return item;
            return {
                ...item,
                content: [
                    ...item.content,
                    { type: "content" as const, content: { type: "text" as const, text: termOut } },
                ],
            };
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

export const extractPromptHistory = (targetSession: AcpSession, maxEntries?: number): string[] => {
    const prompts: string[] = [];
    for (const item of extractChronologicalHistory(targetSession)) {
        if (item.kind !== "user_message" || item.text.length === 0) continue;
        const plurnkMeta = (
            item.meta as
                | {
                      plurnk?: {
                          answering?: unknown;
                      };
                  }
                | undefined
        )?.plurnk;
        if (typeof plurnkMeta?.answering === "string") continue;
        prompts.push(item.text);
    }
    if (typeof maxEntries === "number" && maxEntries >= 0) {
        return maxEntries > 0 ? prompts.slice(-maxEntries) : [];
    }
    return prompts;
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
                      : typeof def.rule === "string"
                        ? [def.rule, typeof def.target === "string" ? def.target : ""].filter(Boolean).join("  ")
                        : typeof def.description === "string"
                          ? def.description
                          : "";
        const extra =
            family === "personas"
                ? [
                      typeof def.model === "string" && def.model.length > 0 ? `model=${def.model}` : "",
                      typeof def.effort === "string" && def.effort.length > 0 ? `effort=${def.effort}` : "",
                  ]
                      .filter(Boolean)
                      .join("  ")
                : "";
        const prov = (d.provenance ?? {}) as Record<string, unknown>;
        const source = typeof prov.source === "string" ? `source=${prov.source}` : "";
        const rowParts = [alias, state, type, target, extra, source].filter((p) => p.length > 0);
        lines.push(rowParts.join("  "));
    }
    return `${lines.join("\n")}\n`;
};

const renderTable = (headers: readonly string[], rows: readonly (readonly string[])[]): string => {
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
    const fmt = (cells: readonly string[]) =>
        cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
    return [fmt(headers), ...rows.map(fmt)].join("\n");
};

const contextLabel = (tokens: number): string =>
    tokens >= 1_000_000 && tokens % 1_000_000 === 0
        ? `${tokens / 1_000_000}m`
        : tokens >= 1_000 && tokens % 1_000 === 0
          ? `${tokens / 1_000}k`
          : String(tokens);

const readinessLabel = (entry: Record<string, unknown>): string => {
    const readiness = entry.readiness as
        | {
              readonly ready?: boolean;
              readonly causes?: ReadonlyArray<{ readonly alternatives?: ReadonlyArray<ReadonlyArray<string>> }>;
          }
        | undefined;
    if (!readiness || readiness.ready !== false) return "ready";
    return (readiness.causes ?? [])
        .map(({ alternatives }) => (alternatives ?? []).map((names) => names.join("+")).join("|"))
        .join("; ");
};

export const formatModelsRows = (result: Record<string, unknown>): string => {
    const items = Array.isArray(result.items) ? result.items : [];
    if (items.length === 0) {
        return "(no models match; use --all to include models missing local configuration)\n";
    }
    const rows = items.map((item) => {
        const r = item as Record<string, unknown>;
        const limits = (r.limits ?? {}) as { readonly contextTokens?: number };
        const caps = (r.capabilities ?? {}) as {
            readonly reasoning?: boolean;
            readonly efforts?: ReadonlyArray<string>;
        };
        const ctx = typeof limits.contextTokens === "number" ? contextLabel(limits.contextTokens) : "-";
        const efforts =
            caps.reasoning && Array.isArray(caps.efforts) && caps.efforts.length > 0
                ? caps.efforts.join(",")
                : "-";
        return [
            String(r.selector ?? ""),
            String(r.modelName ?? r.model ?? ""),
            ctx,
            efforts,
            readinessLabel(r),
        ];
    });
    let out = `${renderTable(["selector", "name", "context", "efforts", "readiness"], rows)}\n`;
    if (typeof result.nextOffset === "number") {
        const offset = typeof result.offset === "number" ? result.offset : 0;
        const total = typeof result.total === "number" ? result.total : items.length;
        out += `(showing ${String(offset + 1)}-${String(offset + items.length)} of ${String(total)}; next --offset ${String(result.nextOffset)})\n`;
    }
    return out;
};

export const formatWorkspacesRows = (result: Record<string, unknown>): string => {
    const workspaces = Array.isArray(result.workspaces) ? result.workspaces : [];
    if (workspaces.length === 0) {
        return "(no workspaces; run `plurnk` to create one)\n";
    }
    const rows = workspaces.map((item) => {
        const w = item as Record<string, unknown>;
        return [
            String(w.name ?? w.id ?? ""),
            typeof w.project_root === "string" && w.project_root.length > 0 ? w.project_root : "(headless)",
            typeof w.created_at === "string" ? w.created_at : "",
        ];
    });
    return `${renderTable(["name", "project_root", "created"], rows)}\n`;
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
        readonly stderr?: NodeJS.WritableStream;
        readonly oauthTimeoutMs?: number;
        readonly signal?: AbortSignal;
        readonly openBrowser?: (url: string) => Promise<ChildProcess | void>;
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

    const parseFamilyFlags = (tokens: readonly string[]): {
        readonly flags: Map<string, string[]>;
        readonly positionals: string[];
    } => {
        const flags = new Map<string, string[]>();
        const positionals: string[] = [];
        for (let i = 0; i < tokens.length; i += 1) {
            const tok = tokens[i]!;
            if (tok.startsWith("--") && tok.length > 2) {
                const eq = tok.indexOf("=");
                if (eq > 0) {
                    const k = tok.slice(2, eq);
                    const v = tok.slice(eq + 1);
                    const arr = flags.get(k) ?? [];
                    arr.push(v);
                    flags.set(k, arr);
                } else {
                    const k = tok.slice(2);
                    const next = tokens[i + 1];
                    if (next !== undefined && !next.startsWith("--")) {
                        const arr = flags.get(k) ?? [];
                        arr.push(next);
                        flags.set(k, arr);
                        i += 1;
                    } else {
                        const arr = flags.get(k) ?? [];
                        arr.push("true");
                        flags.set(k, arr);
                    }
                }
            } else {
                positionals.push(tok);
            }
        }
        return { flags, positionals };
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
        const { flags, positionals } = parseFamilyFlags(rest);
        const flagSource = flags.get("source")?.at(-1);
        const flagQuery = flags.get("query")?.at(-1);
        const flagRule = flags.get("rule")?.at(-1);
        const query = positionals.join(" ");
        const payload =
            flagSource !== undefined
                ? { source: flagSource }
                : flagRule !== undefined
                  ? { rule: flagRule }
                  : flagQuery !== undefined
                    ? { query: flagQuery }
                    : query.length === 0
                      ? {}
                      : family === "skills" || family === "personas"
                        ? { source: query }
                        : family === "schedule"
                          ? { rule: query }
                          : { query };
        const result = await client.action<Record<string, unknown>>(
            `${scopePrefix}.${family}.discover`,
            payload,
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
        const { flags, positionals } = parseFamilyFlags(rest);
        const alias = positionals[0] ?? "";
        const urlFlag = flags.get("url")?.at(-1);
        const commandFlag = flags.get("command")?.at(-1);
        const argFlags = flags.get("arg") ?? [];
        const envFlags = flags.get("env") ?? [];
        const envObj: Record<string, string> = {};
        for (const pair of envFlags) {
            const eq = pair.indexOf("=");
            if (eq > 0) envObj[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
        const target = urlFlag ?? commandFlag ?? positionals[1] ?? "";
        const extraArgs = argFlags.length > 0 ? argFlags : positionals.slice(2);
        const payload = /^https?:\/\//iu.test(target)
            ? { alias, type: "streamable-http", url: target }
            : {
                  alias,
                  type: "stdio",
                  command: target,
                  ...(extraArgs.length > 0 ? { args: extraArgs } : {}),
                  ...(Object.keys(envObj).length > 0 ? { env: envObj } : {}),
              };
        const result = await client.action<Record<string, unknown>>(
            `workspace.mcp.${sub}`,
            payload,
            binding,
        );
        writeResult(result);
        return;
    }
    if (sub === "skills" && family === "mcp") {
        const alias = rest[0];
        const result = await client.action<Record<string, unknown>>(
            "workspace.mcp.skills",
            alias ? { alias } : {},
            binding,
        );
        writeResult(result);
        return;
    }
    if (sub === "complete" && family === "mcp") {
        const { flags, positionals } = parseFamilyFlags(rest);
        const alias = flags.get("alias")?.at(-1) ?? positionals[0] ?? "";
        const uri = flags.get("uri")?.at(-1);
        const promptName = flags.get("prompt")?.at(-1);
        const argName = flags.get("name")?.at(-1) ?? positionals[1] ?? "";
        const argValue = flags.get("value")?.at(-1) ?? positionals[2] ?? "";
        const ref = promptName !== undefined
            ? { type: "ref/prompt" as const, name: promptName }
            : { type: "ref/resource" as const, uri: uri ?? "" };
        const result = await client.action<Record<string, unknown>>(
            "workspace.mcp.complete",
            { alias, ref, argument: { name: argName, value: argValue } },
            binding,
        );
        writeResult(result);
        return;
    }
    if (sub === "oauth" && family === "mcp") {
        const alias = rest[0] ?? "";
        const callbackUrl = rest[1];
        if (alias.length === 0 || rest.length > 2 || callbackUrl === "") {
            io.onError({
                type: "https://problems.plurnk.xyz/client/usage",
                title: "Invalid mcp oauth arguments",
                status: 400,
                detail: "usage: /mcp oauth <alias> [callback-url]",
            });
            return;
        }
        const complete = async (cbUrl: string): Promise<Record<string, unknown>> =>
            await client.action("workspace.mcp.oauth.complete", { alias, callbackUrl: cbUrl }, binding);
        let result: Record<string, unknown>;
        if (callbackUrl !== undefined) {
            result = await complete(callbackUrl);
        } else {
            const timeoutMs = io.oauthTimeoutMs;
            if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0) {
                throw new TypeError(
                    `Invalid PLURNK_CLIENT_OAUTH_TIMEOUT_MS '${String(timeoutMs)}': must be a positive integer.`,
                );
            }
            const listed = await client.action("workspace.mcp.list", {}, binding);
            const definitions = Array.isArray(listed.definitions) ? listed.definitions : [];
            const entry = definitions.find(
                (item): item is Record<string, unknown> =>
                    item !== null && typeof item === "object" && (item as { alias?: unknown }).alias === alias,
            );
            if (entry === undefined || entry.state === "disabled") {
                throw new Error(`MCP server '${alias}' is not enabled in this workspace.`);
            }
            if (entry.state === "active") {
                result = { status: 200, alias, definition: entry };
            } else {
                const definition =
                    entry.definition !== null && typeof entry.definition === "object"
                        ? (entry.definition as Record<string, unknown>)
                        : undefined;
                const authDef =
                    definition?.type === "streamable-http" &&
                    definition.authorization !== null &&
                    typeof definition.authorization === "object"
                        ? (definition.authorization as Record<string, unknown>)
                        : undefined;
                const redirectUrl =
                    authDef?.type === "oauth" && typeof authDef.redirectUrl === "string"
                        ? authDef.redirectUrl
                        : undefined;
                const deadline = AbortSignal.timeout(timeoutMs);
                const signal = io.signal === undefined ? deadline : AbortSignal.any([io.signal, deadline]);
                const noticeStream = io.json ? (io.stderr ?? process.stderr) : io.stdout;
                result = await receiveAuthorization(
                    {
                        ...(redirectUrl === undefined ? {} : { redirectUrl }),
                        begin: async (boundRedirectUrl) =>
                            await client.action(
                                "workspace.mcp.oauth.begin",
                                { alias, redirectUrl: boundRedirectUrl },
                                binding,
                            ),
                    },
                    complete,
                    {
                        signal,
                        write: (text) => {
                            noticeStream.write(text);
                        },
                        ...(io.openBrowser !== undefined ? { openBrowser: io.openBrowser } : {}),
                    },
                );
            }
        }
        if (io.json) {
            io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else if (result.status === 202) {
            io.stdout.write(`  ${alias}: Sign-in accepted; tools awaiting activation.\n`);
        } else {
            const defState =
                result.definition !== null &&
                typeof result.definition === "object" &&
                typeof (result.definition as { state?: unknown }).state === "string"
                    ? ` (${(result.definition as { state: string }).state})`
                    : "";
            io.stdout.write(`  authorized: ${alias}${defState}\n`);
        }
        return;
    }
    if ((sub === "add" || sub === "replace") && family === "skills") {
        const { flags, positionals } = parseFamilyFlags(rest);
        const alias = positionals[0] ?? "";
        const source = flags.get("source")?.at(-1) ?? positionals[1] ?? "";
        const ref = flags.get("ref")?.at(-1);
        const payload = {
            alias,
            ...(source.length > 0 ? { source } : {}),
            ...(ref !== undefined ? { ref } : {}),
        };
        const result = await client.action<Record<string, unknown>>(
            `workspace.skills.${sub}`,
            payload,
            binding,
        );
        writeResult(result);
        return;
    }
    if ((sub === "add" || sub === "replace") && family === "personas") {
        const { flags, positionals } = parseFamilyFlags(rest);
        const alias = positionals[0] ?? "";
        const source = flags.get("source")?.at(-1);
        const model = flags.get("model")?.at(-1);
        const effort = flags.get("effort")?.at(-1);
        const description = flags.get("description")?.at(-1);
        const bodyFlag = flags.get("body")?.at(-1);
        const positionalRest = positionals.slice(1).join(" ");
        const payload: Record<string, unknown> = {
            alias,
            ...(source !== undefined
                ? { source }
                : bodyFlag !== undefined
                  ? { body: bodyFlag }
                  : positionalRest.length > 0
                    ? { source: positionalRest }
                    : {}),
            ...(model !== undefined ? { model } : {}),
            ...(effort !== undefined ? { effort } : {}),
            ...(description !== undefined ? { description } : {}),
        };
        const result = await client.action<Record<string, unknown>>(
            `workspace.personas.${sub}`,
            payload,
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
    if ((sub === "add" || sub === "replace" || sub === "set") && family === "env") {
        const firstArg = rest[0] ?? "";
        const eqIdx = rest.length === 1 ? firstArg.indexOf("=") : -1;
        const alias = eqIdx > 0 ? firstArg.slice(0, eqIdx) : firstArg;
        const value = eqIdx > 0 ? firstArg.slice(eqIdx + 1) : rest.slice(1).join(" ");
        const verb = sub === "set" ? "replace" : sub;
        const result = await client.action<Record<string, unknown>>(
            `${scopePrefix}.env.${verb}`,
            { alias, value },
            binding,
        );
        writeResult(result);
        return;
    }
    if (sub === "unset" && family === "env") {
        const alias = rest[0] ?? "";
        const result = await client.action<Record<string, unknown>>(
            `${scopePrefix}.env.remove`,
            { alias },
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
                    { alias, value: String(val ?? "") },
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
        const { flags, positionals } = parseFamilyFlags(rest);
        const alias = positionals[0] ?? "";
        const ruleFlag = flags.get("rule")?.at(-1);
        const targetFlag = flags.get("target")?.at(-1);
        const promptFlag = flags.get("prompt")?.at(-1);
        const sessionArg = targetFlag ?? positionals[1] ?? "";
        const rule = ruleFlag ?? positionals[2] ?? "";
        const prompt = promptFlag ?? positionals.slice(3).join(" ");
        const target = sessionArg.startsWith("session://") ? sessionArg : `session://${sessionArg}`;
        const result = await client.action<Record<string, unknown>>(
            `workspace.schedule.${sub}`,
            { alias, rule, target, prompt },
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
