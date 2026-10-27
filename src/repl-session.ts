// Five-stream contract ([stdin, stdout, stderr, events, reasoning], fd 0..4) and
// interactive REPL engine ({§cli-output-channels}, {§cli-repl-mode}, {§cli-repl-mode}).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, fstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import * as readline from "node:readline";
import { Writable } from "node:stream";
import { parseEnv } from "node:util";
import {
    CreateElicitationRequest,
    SessionConfigOption,
    SessionUpdate,
    ToolCallContent,
    type CreateElicitationResponse,
    type ElicitationContentValue,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { AcpClient } from "./acp-client.ts";
import { AcpSession, contentBlockToText } from "./acp-session.ts";
import {
    ensureDaemonConnected,
    formatConfigOption,
    formatServiceUpdateResult,
    openCliSession,
    type CliCommonOptions,
} from "./cli-runner.ts";
import { INTERACTIVE_COMMANDS, renderCommandReference } from "./commands.ts";
import { lifecycleGlyphFor } from "./session-presenter.ts";

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

interface PendingPermissionGate {
    readonly kind: "permission";
    readonly id: string;
    readonly sessionId: string;
    readonly request: RequestPermissionRequest;
    readonly resolveGate: (res: RequestPermissionResponse) => void;
}

interface PendingElicitationGate {
    readonly kind: "elicitation";
    readonly id: string;
    readonly sessionId: string;
    readonly request: CreateElicitationRequest;
    readonly resolveGate: (res: CreateElicitationResponse) => void;
}

type PendingGate = PendingPermissionGate | PendingElicitationGate;

const extractOpenPaths = (promptText: string, projectRoot: string | undefined): string[] => {
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
    binding: { readonly sessionId?: string; readonly workspace?: string; readonly session?: string; readonly cwd?: string },
    cwd: string,
    io: {
        readonly json?: boolean;
        readonly stdout: NodeJS.WritableStream;
        readonly onError: (problem: { readonly type: string; readonly title: string; readonly status: number; readonly detail: string }) => void;
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

export const runReplSession = async (
    options: CliCommonOptions,
    customStreams?: Partial<ClientStreams>,
): Promise<number> => {
    const streams = openProcessStreams(customStreams);
    let currentWorkspace = options.workspace ?? "default";
    let currentSessionName = options.sessionId ?? options.tuiSession ?? "user";
    let currentProjectRoot = options.projectRoot ?? options.cwd;
    let currentYolo = options.yolo;
    let forceReviewNextRun = false;
    let gateSeq = 0;
    let reasoningOpenOnLine = false;
    let currentLifecycle = "idle";
    let stagedComposerText = "";
    const pendingGates = new Map<string, PendingGate>();

    const flushReasoningNewline = (): void => {
        if (reasoningOpenOnLine) {
            streams.reasoning.write("\n");
            reasoningOpenOnLine = false;
        }
    };

    const extractChronologicalHistory = (targetSession: AcpSession) => {
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

    const emitSessionBound = (
        session: AcpSession,
        extra?: {
            readonly sessions?: ReadonlyArray<Record<string, unknown>>;
            readonly workspaces?: ReadonlyArray<Record<string, unknown>>;
        },
    ): void => {
        const plurnk = (session.meta?.plurnk ?? undefined) as Record<string, unknown> | undefined;
        const ws = (plurnk?.workspace ?? undefined) as Record<string, unknown> | undefined;
        if (typeof ws?.name === "string" && ws.name.length > 0) {
            currentWorkspace = ws.name;
        }
        if (typeof ws?.projectRoot === "string") {
            currentProjectRoot = ws.projectRoot;
        }
        if (typeof plurnk?.sessionName === "string" && plurnk.sessionName.length > 0) {
            currentSessionName = plurnk.sessionName;
        } else if (session.sessionId.includes("#") ) {
            currentSessionName = session.sessionId.slice(session.sessionId.indexOf("#") + 1);
        }
        const chronologicalItems = extractChronologicalHistory(session);
        const historyLimit = options.historyEntries > 0 ? options.historyEntries : 0;
        const history = historyLimit > 0 ? chronologicalItems.slice(-historyLimit) : [];
        const mergedMeta =
            session.usage?.meta !== undefined
                ? {
                      ...(session.meta ?? {}),
                      ...session.usage.meta,
                      plurnk: {
                          ...((session.meta?.plurnk as Record<string, unknown> | undefined) ?? {}),
                          ...((session.usage.meta.plurnk as Record<string, unknown> | undefined) ?? {}),
                      },
                  }
                : session.meta;
        writeEventJsonl(streams.events, {
            sessionUpdate: "session_bound",
            sessionId: session.sessionId,
            workspace: currentWorkspace,
            session: currentSessionName,
            cwd: currentProjectRoot,
            configOptions: session.configOptions,
            history,
            ...(extra?.sessions !== undefined ? { sessions: extra.sessions } : {}),
            ...(extra?.workspaces !== undefined ? { workspaces: extra.workspaces } : {}),
            ...(mergedMeta !== undefined ? { _meta: mergedMeta } : {}),
        });
    };

    const handleSessionUpdate = (update: SessionUpdate): void => {
        if (SessionUpdate.isAgentThoughtChunk(update)) {
            const delta = contentBlockToText(update.content);
            if (delta.length > 0) {
                streams.reasoning.write(delta);
                reasoningOpenOnLine = !delta.endsWith("\n");
            }
            return;
        }

        if (SessionUpdate.isAgentMessageChunk(update)) {
            flushReasoningNewline();
            writeEventJsonl(streams.events, update);
            const text = contentBlockToText(update.content);
            if (text.length > 0) {
                streams.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
            }
            return;
        }

        if (SessionUpdate.isToolCallUpdate(update)) {
            flushReasoningNewline();
            writeEventJsonl(streams.events, update);
            return;
        }

        if (SessionUpdate.isNotice(update)) {
            const rawNotice = (
                update._meta as { plurnk?: { notice?: Record<string, unknown> } } | undefined
            )?.plurnk?.notice;
            if (rawNotice?.kind === "loop_status") {
                if (rawNotice.status === 202) {
                    currentLifecycle = "parked";
                } else if (rawNotice.status === 102) {
                    currentLifecycle = "running";
                } else if (rawNotice.status === 100) {
                    currentLifecycle = "queued";
                }
            }
            if (update.severity === "error") {
                writeErrorJsonl(streams.stderr, update);
            }
            writeEventJsonl(streams.events, update);
            return;
        }

        if (SessionUpdate.isStateUpdate(update)) {
            if (update.state === "running") {
                currentLifecycle = "running";
            } else if (update.state === "requires_action") {
                currentLifecycle = "parked";
            } else if (update.state === "idle") {
                flushReasoningNewline();
                forceReviewNextRun = false;
                const termMeta = (
                    update._meta as
                        | {
                              plurnk?: {
                                  terminal?: {
                                      status?: number;
                                      problem?: Record<string, unknown>;
                                  };
                              };
                          }
                        | undefined
                )?.plurnk?.terminal;
                const status =
                    typeof termMeta?.status === "number"
                        ? termMeta.status
                        : update.stopReason === "error" || update.stopReason === "refusal"
                          ? 500
                          : update.stopReason === "cancelled"
                            ? 499
                            : 200;
                currentLifecycle = status >= 400 ? (status === 499 ? "cancelled" : "failed") : "idle";
                if (termMeta?.problem !== undefined) {
                    writeErrorJsonl(streams.stderr, termMeta.problem);
                }
            }
            writeEventJsonl(streams.events, update);
            return;
        }

        writeEventJsonl(streams.events, update);
    };

    let activeSession: AcpSession | null = null;

    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
        onDisconnect: () => {
            currentLifecycle = "idle";
            writeEventJsonl(streams.events, {
                sessionUpdate: "connection_lost",
            });
        },
        onPermissionRequest: async (request, signal): Promise<RequestPermissionResponse> => {
            if (signal.aborted) {
                return { outcome: { outcome: "cancelled" } };
            }
            gateSeq += 1;
            const id = mintGateHash(activeSession?.sessionId ?? currentSessionName, "permission", gateSeq);
            writeEventJsonl(streams.events, {
                ...request,
                sessionUpdate: "permission_request",
                id,
                sessionId: activeSession?.sessionId ?? currentSessionName,
            });

            if ((currentYolo || options.auto) && !forceReviewNextRun) {
                const allowOption =
                    request.options.find((opt) => opt.kind === "allow_once" || opt.kind === "allow_always") ??
                    request.options[0];
                const outcome: RequestPermissionResponse["outcome"] =
                    allowOption !== undefined
                        ? { outcome: "selected", optionId: allowOption.optionId }
                        : { outcome: "cancelled" };
                writeEventJsonl(streams.events, {
                    sessionUpdate: "gate_resolved",
                    id,
                    outcome,
                });
                return { outcome };
            }

            return await new Promise<RequestPermissionResponse>((resolveGate) => {
                const finishGate = (res: RequestPermissionResponse, reason?: string): void => {
                    if (!pendingGates.has(id)) return;
                    pendingGates.delete(id);
                    writeEventJsonl(streams.events, {
                        sessionUpdate: "gate_resolved",
                        id,
                        outcome: res.outcome,
                        ...(reason !== undefined ? { reason } : {}),
                    });
                    resolveGate(res);
                };
                const onAbort = (): void => {
                    finishGate({ outcome: { outcome: "cancelled" } }, "settled_elsewhere");
                };
                signal.addEventListener("abort", onAbort, { once: true });
                pendingGates.set(id, {
                    kind: "permission",
                    id,
                    sessionId: activeSession?.sessionId ?? currentSessionName,
                    request,
                    resolveGate: (res) => {
                        signal.removeEventListener("abort", onAbort);
                        finishGate(res);
                    },
                });
            });
        },
        onElicitationRequest: async (request, signal): Promise<CreateElicitationResponse> => {
            if (signal.aborted) {
                return { action: "cancel" };
            }
            gateSeq += 1;
            const id = mintGateHash(activeSession?.sessionId ?? currentSessionName, "elicitation", gateSeq);
            writeEventJsonl(streams.events, {
                sessionUpdate: "elicitation_request",
                id,
                sessionId: activeSession?.sessionId ?? currentSessionName,
                mode: CreateElicitationRequest.isUrl(request) ? "url" : "form",
                message: request.message,
                ...(CreateElicitationRequest.isForm(request) ? { requestedSchema: request.requestedSchema } : {}),
                ...(CreateElicitationRequest.isUrl(request) ? { url: request.url } : {}),
                ...(request._meta !== undefined ? { _meta: request._meta } : {}),
            });

            if (options.auto) {
                const outcome: CreateElicitationResponse = { action: "decline" };
                writeEventJsonl(streams.events, {
                    sessionUpdate: "gate_resolved",
                    id,
                    outcome,
                });
                return outcome;
            }

            return await new Promise<CreateElicitationResponse>((resolveGate) => {
                const finishGate = (res: CreateElicitationResponse, reason?: string): void => {
                    if (!pendingGates.has(id)) return;
                    pendingGates.delete(id);
                    writeEventJsonl(streams.events, {
                        sessionUpdate: "gate_resolved",
                        id,
                        outcome: res,
                        ...(reason !== undefined ? { reason } : {}),
                    });
                    resolveGate(res);
                };
                const onAbort = (): void => {
                    finishGate({ action: "cancel" }, "settled_elsewhere");
                };
                signal.addEventListener("abort", onAbort, { once: true });
                pendingGates.set(id, {
                    kind: "elicitation",
                    id,
                    sessionId: activeSession?.sessionId ?? currentSessionName,
                    request,
                    resolveGate: (res) => {
                        signal.removeEventListener("abort", onAbort);
                        finishGate(res);
                    },
                });
            });
        },
    });

    await ensureDaemonConnected(client, options);

    const bindSession = async (workspaceName: string | undefined, sessionName: string): Promise<AcpSession> => {
        const nextSession = await openCliSession(
            client,
            {
                ...options,
                ...(workspaceName !== undefined ? { workspace: workspaceName } : {}),
                sessionId: sessionName,
            },
            (update, s) => {
                if (s === activeSession) {
                    handleSessionUpdate(update);
                }
            },
            options.historyEntries > 0,
        );
        activeSession = nextSession;
        const plurnk = (nextSession.meta?.plurnk ?? undefined) as Record<string, unknown> | undefined;
        const ws = (plurnk?.workspace ?? undefined) as Record<string, unknown> | undefined;
        const resolvedWorkspace =
            typeof ws?.name === "string" && ws.name.length > 0 ? ws.name : (workspaceName ?? currentWorkspace);
        const resolvedSession =
            typeof plurnk?.sessionName === "string" && plurnk.sessionName.length > 0
                ? plurnk.sessionName
                : nextSession.sessionId.includes("#")
                  ? nextSession.sessionId.slice(nextSession.sessionId.indexOf("#") + 1)
                  : sessionName;
        const [sessionsRes, workspacesRes] = await Promise.all([
            client
                .action<{ readonly sessions?: ReadonlyArray<Record<string, unknown>> }>(
                    "workspace.sessions",
                    {},
                    {
                        sessionId: nextSession.sessionId,
                        workspace: resolvedWorkspace,
                        session: resolvedSession,
                    },
                )
                .catch(() => undefined),
            client
                .action<{ readonly workspaces?: ReadonlyArray<Record<string, unknown>> }>("workspace.list", {})
                .catch(() => undefined),
        ]);
        emitSessionBound(nextSession, {
            sessions: Array.isArray(sessionsRes?.sessions) ? sessionsRes.sessions : [],
            workspaces: Array.isArray(workspacesRes?.workspaces) ? workspacesRes.workspaces : [],
        });
        return nextSession;
    };

    let session = await bindSession(options.workspace, currentSessionName);
    streams.stdout.write(`workspace: ${currentWorkspace}\n`);

    const resolveRequiredGate = (
        cmdName: string,
        usage: string,
        rawTarget: string | undefined,
    ): PendingGate | undefined => {
        if (!rawTarget || !rawTarget.startsWith("@") || rawTarget.length < 2) {
            writeErrorJsonl(streams.stderr, {
                type: "https://problems.plurnk.xyz/client/usage",
                title: "Missing gate identifier",
                status: 400,
                detail: `usage: ${usage} (/<${cmdName}> requires @<id> in REPL mode; inspect pending gates with /review or fd 3 events).`,
            });
            return undefined;
        }
        const id = rawTarget.slice(1);
        const gate = pendingGates.get(id);
        if (!gate) {
            writeErrorJsonl(streams.stderr, {
                type: "https://problems.plurnk.xyz/client/gate-not-found",
                title: "Gate not found",
                status: 404,
                detail: `No pending gate with id @${id}.`,
            });
            return undefined;
        }
        return gate;
    };

    const bindingContext = () => ({
        sessionId: session.sessionId,
        workspace: currentWorkspace,
        session: currentSessionName,
    });

    const handleFamilyCommand = async (family: string, args: readonly string[]): Promise<void> => {
        await executeFamilyCommand(client, family, args, bindingContext(), options.cwd, {
            stdout: streams.stdout,
            onError: (problem) => writeErrorJsonl(streams.stderr, problem),
        });
    };

    const navigateTopology = async (direction: "parent" | "enter" | "older" | "newer"): Promise<void> => {
        const res = await client.action<{
            readonly sessions?: ReadonlyArray<{
                readonly id?: number;
                readonly name: string;
                readonly parentSessionId?: number | null;
                readonly origin?: string;
            }>;
        }>("workspace.sessions", {}, bindingContext());
        const sessions = (res.sessions ?? []).filter((s) => s.origin !== "maintenance" && s.origin !== "scratch");
        const parentOf = (s: { readonly parentSessionId?: number | null } | undefined): number | null =>
            s?.parentSessionId ?? null;
        const current = sessions.find((s) => s.name === currentSessionName);
        if (direction === "parent") {
            const pid = parentOf(current);
            if (!current || pid === null) {
                streams.stdout.write("(at the root: no parent)\n");
                return;
            }
            const parent = sessions.find((s) => s.id === pid);
            if (!parent) {
                streams.stdout.write("(at the root: no parent)\n");
                return;
            }
            session = await bindSession(currentWorkspace, parent.name);
            streams.stdout.write(`session: ${currentSessionName} (bound)\n`);
            return;
        }
        if (direction === "enter") {
            const children = current?.id !== undefined ? sessions.filter((s) => parentOf(s) === current.id) : [];
            const newest = children.at(-1);
            if (!newest) {
                streams.stdout.write("(no children)\n");
                return;
            }
            session = await bindSession(currentWorkspace, newest.name);
            streams.stdout.write(`session: ${currentSessionName} (bound)\n`);
            return;
        }
        const parentId = parentOf(current);
        const siblings = sessions.filter((s) => parentOf(s) === parentId);
        if (siblings.length <= 1) {
            streams.stdout.write("(no siblings)\n");
            return;
        }
        const idx = siblings.findIndex((s) => s.name === currentSessionName);
        const nextIdx =
            direction === "older"
                ? (idx - 1 + siblings.length) % siblings.length
                : (idx + 1) % siblings.length;
        const target = siblings[nextIdx]!;
        session = await bindSession(currentWorkspace, target.name);
        streams.stdout.write(`session: ${currentSessionName} (bound)\n`);
    };

    const dispatchLine = async (rawLine: string): Promise<"continue" | "quit"> => {
        const line = rawLine.trim();
        if (line.length === 0) return "continue";

        if (line === "/quit" || line === "/exit") {
            return "quit";
        }

        if (line === "/stop") {
            for (const gate of [...pendingGates.values()]) {
                if (gate.kind === "permission") {
                    gate.resolveGate({ outcome: { outcome: "cancelled" } });
                } else {
                    gate.resolveGate({ action: "cancel" });
                }
            }
            await client
                .cancel(session.sessionId)
                .then(() => {
                    streams.stdout.write("cancelled (final 499)\n");
                })
                .catch(() => {
                    streams.stdout.write("cancelled (final 499)\n");
                });
            return "continue";
        }

        if (line.startsWith("/")) {
            const parts = line.slice(1).split(/\s+/u);
            const cmd = parts[0]?.toLowerCase() ?? "";
            const args = parts.slice(1);

            try {
                if (cmd === "help") {
                    const topic = args[0]?.replace(/^\//u, "").toLowerCase();
                    if (topic) {
                        const matches = INTERACTIVE_COMMANDS.filter((c) =>
                            c.usage.toLowerCase().startsWith(`/${topic}`),
                        );
                        if (matches.length > 0) {
                            for (const m of matches) {
                                streams.stdout.write(`${m.usage.padEnd(30, " ")} ${m.summary}\n`);
                            }
                            return "continue";
                        }
                    }
                    streams.stdout.write(`${renderCommandReference()}\n`);
                    return "continue";
                }

                if (cmd === "update") {
                    const result = await client.action<Record<string, unknown>>("service.update", {});
                    streams.stdout.write(`${formatServiceUpdateResult(result)}\n`);
                    return "continue";
                }

                if (cmd === "yolo") {
                    currentYolo = !currentYolo;
                    streams.stdout.write(`yolo: ${currentYolo ? "on" : "off"}\n`);
                    return "continue";
                }

                if (cmd === "review") {
                    if (pendingGates.size === 0) {
                        streams.stdout.write("review: none\n");
                        return "continue";
                    }
                    for (const gate of pendingGates.values()) {
                        if (gate.kind === "permission") {
                            const opts = gate.request.options.map((o) => o.optionId).join(", ");
                            streams.stdout.write(`@${gate.id}  permission  ${gate.request.title}  [${opts}]\n`);
                        } else {
                            streams.stdout.write(`@${gate.id}  elicitation  ${gate.request.message}\n`);
                        }
                    }
                    return "continue";
                }

                if (cmd === "approve" || cmd === "accept") {
                    const gate = resolveRequiredGate(cmd, `/${cmd} @<id> [optionId]`, args[0]);
                    if (!gate) {
                        return "continue";
                    }
                    const explicitOptionId = args[1];
                    if (gate.kind === "permission") {
                        const chosen =
                            (explicitOptionId
                                ? gate.request.options.find((o) => o.optionId === explicitOptionId)
                                : undefined) ??
                            gate.request.options.find(
                                (o) => o.kind === "allow_once" || o.kind === "allow_always",
                            ) ??
                            gate.request.options[0];
                        if (!chosen) {
                            gate.resolveGate({ outcome: { outcome: "cancelled" } });
                        } else {
                            gate.resolveGate({
                                outcome: { outcome: "selected", optionId: chosen.optionId },
                            });
                        }
                    } else {
                        gate.resolveGate({ action: "accept" });
                    }
                    return "continue";
                }

                if (cmd === "reject") {
                    const gate = resolveRequiredGate(cmd, "/reject @<id> [optionId]", args[0]);
                    if (!gate) {
                        return "continue";
                    }
                    const explicitOptionId = args[1];
                    if (gate.kind === "permission") {
                        const chosen =
                            (explicitOptionId
                                ? gate.request.options.find((o) => o.optionId === explicitOptionId)
                                : undefined) ??
                            gate.request.options.find(
                                (o) => o.kind === "reject_once" || o.kind === "reject_always",
                            );
                        if (!chosen) {
                            gate.resolveGate({ outcome: { outcome: "cancelled" } });
                        } else {
                            gate.resolveGate({
                                outcome: { outcome: "selected", optionId: chosen.optionId },
                            });
                        }
                    } else {
                        gate.resolveGate({ action: "decline" });
                    }
                    return "continue";
                }

                if (cmd === "cancel") {
                    const gate = resolveRequiredGate(cmd, "/cancel @<id>", args[0]);
                    if (!gate) {
                        return "continue";
                    }
                    if (gate.kind === "permission") {
                        gate.resolveGate({ outcome: { outcome: "cancelled" } });
                    } else {
                        gate.resolveGate({ action: "cancel" });
                    }
                    return "continue";
                }

                if (cmd === "edit") {
                    const gate = resolveRequiredGate(cmd, "/edit @<id> <body...>", args[0]);
                    if (!gate) {
                        return "continue";
                    }
                    if (gate.kind !== "permission") {
                        writeErrorJsonl(streams.stderr, {
                            type: "https://problems.plurnk.xyz/client/gate-not-found",
                            title: "Gate not found",
                            status: 404,
                            detail: `Gate @${gate.id} is not a permission gate.`,
                        });
                        return "continue";
                    }
                    const afterTargetMatch = line.match(/^\/\S+\s+\S+(?:\r?\n|[ \t])([\s\S]*)$/u);
                    const editedBody = afterTargetMatch?.[1] ?? "";
                    const allowOpt =
                        gate.request.options.find(
                            (o) => o.kind === "allow_once" || o.kind === "allow_always",
                        ) ?? gate.request.options[0];
                    gate.resolveGate({
                        outcome: allowOpt
                            ? { outcome: "selected", optionId: allowOpt.optionId }
                            : { outcome: "cancelled" },
                        ...(editedBody.length > 0 ? { _meta: { plurnk: { body: editedBody } } } : {}),
                    } as RequestPermissionResponse);
                    return "continue";
                }

                if (cmd === "answer") {
                    const gate = resolveRequiredGate(cmd, "/answer @<id> <json>", args[0]);
                    if (!gate) {
                        return "continue";
                    }
                    if (gate.kind !== "elicitation") {
                        writeErrorJsonl(streams.stderr, {
                            type: "https://problems.plurnk.xyz/client/gate-not-found",
                            title: "Gate not found",
                            status: 404,
                            detail: `Gate @${gate.id} is not an elicitation gate.`,
                        });
                        return "continue";
                    }
                    const afterTargetMatch = line.match(/^\/\S+\s+\S+(?:\r?\n|[ \t])([\s\S]*)$/u);
                    const rawPayload = (afterTargetMatch?.[1] ?? "").trim();
                    let content: Record<string, unknown> = {};
                    if (rawPayload.length > 0) {
                        try {
                            const parsed = JSON.parse(rawPayload) as unknown;
                            content =
                                typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
                                    ? (parsed as Record<string, unknown>)
                                    : { answer: parsed };
                        } catch {
                            content = { answer: rawPayload };
                        }
                    }
                    gate.resolveGate({
                        action: "accept",
                        content: content as Record<string, ElicitationContentValue>,
                    });
                    return "continue";
                }

                if (cmd === "sessions") {
                    try {
                        const res = await client.action<{
                            readonly sessions?: ReadonlyArray<{
                                readonly name: string;
                                readonly lifecycle?: string;
                            }>;
                        }>("workspace.sessions", {}, bindingContext());
                        const list = res.sessions ?? [];
                        if (list.length === 0) {
                            const glyph =
                                currentLifecycle !== "idle" ? ` ${lifecycleGlyphFor(currentLifecycle)}` : "";
                            streams.stdout.write(`● ${currentSessionName}${glyph}\n`);
                            return "continue";
                        }
                        for (const s of list) {
                            const isBound = s.name === currentSessionName;
                            const mark = isBound ? "●" : "○";
                            const effLifecycle = isBound && currentLifecycle !== "idle" ? currentLifecycle : s.lifecycle;
                            const glyph =
                                effLifecycle && effLifecycle !== "idle" && effLifecycle !== "completed"
                                    ? ` ${lifecycleGlyphFor(effLifecycle)}`
                                    : "";
                            streams.stdout.write(`${mark} ${s.name}${glyph}\n`);
                        }
                    } catch {
                        const glyph = currentLifecycle !== "idle" ? ` ${lifecycleGlyphFor(currentLifecycle)}` : "";
                        streams.stdout.write(`● ${currentSessionName}${glyph}\n`);
                    }
                    return "continue";
                }

                if (cmd === "session") {
                    const targetName = args[0];
                    if (!targetName) {
                        streams.stdout.write(
                            `session: ${currentSessionName} [/${currentWorkspace}/~${currentSessionName}]\n`,
                        );
                        return "continue";
                    }
                    session = await bindSession(currentWorkspace, targetName);
                    streams.stdout.write(`session: ${currentSessionName} (bound)\n`);
                    return "continue";
                }

                if (cmd === "fork") {
                    const forked = await client.forkSession(session.sessionId, currentProjectRoot);
                    const nextName = args[0] ?? (forked.sessionId.includes("#")
                        ? forked.sessionId.slice(forked.sessionId.indexOf("#") + 1)
                        : forked.sessionId);
                    session = await bindSession(currentWorkspace, nextName);
                    streams.stdout.write(`session: ${currentSessionName} (forked)\n`);
                    return "continue";
                }

                if (cmd === "parent" || cmd === "enter" || cmd === "older" || cmd === "newer") {
                    await navigateTopology(cmd);
                    return "continue";
                }

                if (cmd === "workspaces") {
                    const result = await client.action<Record<string, unknown>>("workspace.list", {});
                    streams.stdout.write(formatWorkspacesRows(result));
                    return "continue";
                }

                if (cmd === "workspace") {
                    const targetWs = args[0];
                    if (!targetWs) {
                        streams.stdout.write(`workspace: ${currentWorkspace}\n`);
                        return "continue";
                    }
                    session = await bindSession(targetWs, options.tuiSession || "user");
                    streams.stdout.write(`workspace: ${currentWorkspace}\n`);
                    return "continue";
                }

                if (cmd === "rename") {
                    const newName = args[0];
                    if (!newName) {
                        writeErrorJsonl(streams.stderr, {
                            type: "https://problems.plurnk.xyz/client/usage",
                            title: "Missing workspace name",
                            status: 400,
                            detail: "usage: /rename <name>",
                        });
                        return "continue";
                    }
                    await client.action(
                        "workspace.rename",
                        { from: currentWorkspace, name: newName },
                        bindingContext(),
                    );
                    currentWorkspace = newName;
                    emitSessionBound(session);
                    streams.stdout.write(`workspace: ${currentWorkspace}\n`);
                    return "continue";
                }

                if (cmd === "models") {
                    const result = await client.action<Record<string, unknown>>(
                        "models.list",
                        args.length > 0 ? { search: args.join(" ") } : {},
                    );
                    streams.stdout.write(formatModelsRows(result));
                    return "continue";
                }

                if (cmd === "loops") {
                    const result = await client.action<{
                        readonly items?: ReadonlyArray<Record<string, unknown>>;
                    }>("session.loops", {}, bindingContext());
                    const items = [...(result.items ?? [])].toSorted(
                        (a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0),
                    );
                    if (items.length === 0) {
                        streams.stdout.write("  (no loops yet)\n");
                        return "continue";
                    }
                    for (const l of items) {
                        const seq = String(l.sequence ?? "");
                        const rawPrompt = typeof l.prompt === "string" ? l.prompt : "";
                        const nonEmptyLines = rawPrompt
                            .split(/\r?\n/u)
                            .map((s) => s.trim())
                            .filter(Boolean);
                        const firstLine = nonEmptyLines[0] ?? "";
                        const clipped = firstLine.length > 240 ? firstLine.slice(0, 240) : firstLine;
                        const ellipsis = nonEmptyLines.length > 1 || firstLine.length > 240 ? "…" : "";
                        const rawSource = typeof l.promptSource === "string" ? l.promptSource : "";
                        const sender =
                            rawSource.length > 0 && !rawSource.startsWith("acp:")
                                ? `${rawSource.replace(/^session:\/\//u, "~")}: `
                                : "";
                        const status = typeof l.status === "number" ? l.status : 200;
                        const mark =
                            status === 100
                                ? " ⏳"
                                : status === 102
                                  ? " ⌛︎"
                                  : status === 202
                                    ? " 💤"
                                    : status === 499
                                      ? " 🛑"
                                      : status >= 400
                                        ? " ❌"
                                        : "";
                        streams.stdout.write(`  ${seq}: ${sender}${clipped}${ellipsis}${mark}\n`);
                    }
                    return "continue";
                }

                if (cmd === "loop") {
                    if (args.length > 1 || (args[0] !== undefined && !/^[1-9]\d*$/u.test(args[0]))) {
                        streams.stdout.write("  usage: /loop [n]\n");
                        return "continue";
                    }
                    const listRes = await client.action<{
                        readonly items?: ReadonlyArray<Record<string, unknown>>;
                        readonly updates?: ReadonlyArray<SessionUpdate>;
                    }>(
                        "session.loops",
                        args[0] !== undefined ? { loopSeq: Number.parseInt(args[0], 10) } : {},
                        bindingContext(),
                    );
                    const items = [...(listRes.items ?? [])].toSorted(
                        (a, b) => Number(a.sequence ?? 0) - Number(b.sequence ?? 0),
                    );
                    if (items.length === 0) {
                        streams.stdout.write("  (no loops yet)\n");
                        return "continue";
                    }
                    const targetSeq =
                        args[0] !== undefined
                            ? Number.parseInt(args[0], 10)
                            : Number(items.at(-1)?.sequence ?? 1);
                    const targetLoop = items.find((i) => Number(i.sequence) === targetSeq);
                    if (!targetLoop) {
                        streams.stdout.write(`  (no loop ${String(targetSeq)}; /loops lists them)\n`);
                        return "continue";
                    }
                    const detailRes =
                        args[0] !== undefined
                            ? listRes
                            : await client.action<{
                                  readonly items?: ReadonlyArray<Record<string, unknown>>;
                                  readonly updates?: ReadonlyArray<SessionUpdate>;
                              }>("session.loops", { loopSeq: targetSeq }, bindingContext());
                    const tempSession = new AcpSession(session.sessionId);
                    if (Array.isArray(detailRes.updates)) {
                        for (const u of detailRes.updates) {
                            tempSession.applyUpdate(u);
                        }
                    }
                    const history = [...extractChronologicalHistory(tempSession)];
                    if (
                        typeof targetLoop.prompt === "string" &&
                        targetLoop.prompt.length > 0 &&
                        !history.some((h) => h.kind === "user_message")
                    ) {
                        history.unshift({
                            kind: "user_message",
                            id: `loop-${String(targetSeq)}`,
                            text: targetLoop.prompt,
                            blocks: [],
                        });
                    }
                    let plainText = `── loop ${String(targetSeq)} ──\n`;
                    if (Array.isArray(detailRes.updates) && history.length > 0) {
                        for (const item of history) {
                            if (item.kind === "user_message") {
                                plainText += `🎤 ${item.text}\n`;
                            } else if (item.kind === "tool_call") {
                                plainText += `${item.title ?? item.name ?? item.toolCallId}\n`;
                            } else if (item.kind === "agent_message") {
                                plainText += `${item.text}\n`;
                            }
                        }
                    } else {
                        const logResult = await client.action<{
                            readonly entries?: ReadonlyArray<Record<string, unknown>>;
                        }>(
                            "log.read",
                            { loopSeq: targetSeq, limit: 100 },
                            bindingContext(),
                        );
                        plainText += formatLogEntries(logResult.entries ?? []);
                    }
                    writeEventJsonl(streams.events, {
                        sessionUpdate: "loop_replay",
                        loopSeq: targetSeq,
                        history,
                        text: plainText,
                    });
                    if (customStreams?.events === undefined) {
                        streams.stdout.write(plainText);
                    }
                    return "continue";
                }

                if (cmd === "capabilities") {
                    const rawPolicy = args.join(" ").trim();
                    const result =
                        rawPolicy.length > 0
                            ? await client.action(
                                  "workspace.capabilities.set",
                                  { policy: JSON.parse(rawPolicy) as unknown },
                                  bindingContext(),
                              )
                            : await client.action("workspace.capabilities.get", {}, bindingContext());
                    streams.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
                    return "continue";
                }

                if (cmd === "share") {
                    const folder = args[0];
                    if (!folder) {
                        writeErrorJsonl(streams.stderr, {
                            type: "https://problems.plurnk.xyz/client/usage",
                            title: "Missing share folder",
                            status: 400,
                            detail: "usage: /share <folder>",
                        });
                        return "continue";
                    }
                    const resolvedShare = folder.startsWith("~/")
                        ? join(options.env.HOME || homedir(), folder.slice(2))
                        : resolve(options.cwd, folder);
                    const result = await client.action(
                        "workspace.share",
                        { folder: resolvedShare },
                        bindingContext(),
                    );
                    streams.stdout.write(`${JSON.stringify(result)}\n`);
                    return "continue";
                }

                if (cmd === "rollback") {
                    const to = args[0];
                    if (!to) {
                        writeErrorJsonl(streams.stderr, {
                            type: "https://problems.plurnk.xyz/client/usage",
                            title: "Missing rollback coordinate",
                            status: 400,
                            detail: "usage: /rollback <loop>/<turn>/<item>",
                        });
                        return "continue";
                    }
                    const result = await client.action("workspace.rollback", { to }, bindingContext());
                    streams.stdout.write(`${JSON.stringify(result)}\n`);
                    return "continue";
                }

                if (cmd === "import") {
                    const filePath = args[0];
                    if (!filePath) {
                        writeErrorJsonl(streams.stderr, {
                            type: "https://problems.plurnk.xyz/client/usage",
                            title: "Missing import path",
                            status: 400,
                            detail: "usage: /import <path>",
                        });
                        return "continue";
                    }
                    const content = readFileSync(resolve(options.cwd, filePath), "utf8");
                    stagedComposerText =
                        stagedComposerText.length > 0 ? `${stagedComposerText}\n${content}` : content;
                    writeEventJsonl(streams.events, {
                        sessionUpdate: "composer_updated",
                        source: "import",
                        path: filePath,
                        text: stagedComposerText,
                    });
                    streams.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
                    return "continue";
                }

                if (cmd === "editor") {
                    const editorCmd = options.env.VISUAL || options.env.EDITOR || (process.stdin.isTTY ? "vi" : "");
                    if (!editorCmd) {
                        writeErrorJsonl(streams.stderr, {
                            type: "https://problems.plurnk.xyz/client/editor-unavailable",
                            title: "Editor unavailable",
                            status: 400,
                            detail: "Set $VISUAL or $EDITOR to use /editor in non-TTY mode.",
                        });
                        return "continue";
                    }
                    const tmpDir = mkdtempSync(join(tmpdir(), "plurnk-editor-"));
                    const tmpFile = join(tmpDir, "prompt.md");
                    try {
                        writeFileSync(tmpFile, stagedComposerText, "utf8");
                        const res = spawnSync(editorCmd, [tmpFile], {
                            stdio: "inherit",
                            shell: true,
                            env: options.env as NodeJS.ProcessEnv,
                        });
                        if (res.status === 0) {
                            const edited = readFileSync(tmpFile, "utf8").trim();
                            stagedComposerText = "";
                            writeEventJsonl(streams.events, {
                                sessionUpdate: "composer_updated",
                                source: "editor",
                                text: edited,
                            });
                            if (edited.length > 0) {
                                return await dispatchLine(edited);
                            }
                        }
                    } finally {
                        rmSync(tmpDir, { recursive: true, force: true });
                    }
                    return "continue";
                }

                if (cmd === "script") {
                    const filePath = args[0];
                    if (!filePath) {
                        writeErrorJsonl(streams.stderr, {
                            type: "https://problems.plurnk.xyz/client/usage",
                            title: "Missing script path",
                            status: 400,
                            detail: "usage: /script <path>",
                        });
                        return "continue";
                    }
                    const text = readFileSync(resolve(options.cwd, filePath), "utf8");
                    const res = await client.action<{
                        readonly results?: ReadonlyArray<{
                            readonly status?: number;
                            readonly content?: string;
                            readonly message?: string;
                        }>;
                    }>("op.parse", { text }, bindingContext());
                    for (const r of res.results ?? []) {
                        const out = r.content ?? r.message ?? String(r.status ?? 200);
                        streams.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
                    }
                    return "continue";
                }

                const configMap: Record<string, string> = {
                    model: "model",
                    effort: "thought_level",
                    child: "spawn_model",
                    mode: "mode",
                };
                const mappedConfigId = configMap[cmd];
                if (mappedConfigId !== undefined) {
                    const arg = args[0];
                    if (arg === undefined || arg.length === 0) {
                        const opt = session.configOptions.find((o) => o.configId === mappedConfigId);
                        if (opt !== undefined) {
                            streams.stdout.write(`${formatConfigOption(opt)}\n`);
                        }
                        return "continue";
                    }
                    const value = cmd === "child" && arg === "inherit" ? "" : arg;
                    const res = await client.setConfigOption(session.sessionId, mappedConfigId, value);
                    session.configOptions = [...res.configOptions];
                    let latestMeta = (res as { _meta?: unknown })._meta;
                    if (cmd === "model" && args[1]) {
                        const effortRes = await client.setConfigOption(
                            session.sessionId,
                            "thought_level",
                            args[1],
                        );
                        session.configOptions = [...effortRes.configOptions];
                        latestMeta = (effortRes as { _meta?: unknown })._meta ?? latestMeta;
                    }
                    writeEventJsonl(streams.events, {
                        sessionUpdate: "config_option_update",
                        configOptions: session.configOptions,
                        ...(latestMeta !== undefined ? { _meta: latestMeta } : {}),
                    });
                    const opt = session.configOptions.find((o) => o.configId === mappedConfigId);
                    if (opt !== undefined) {
                        streams.stdout.write(`${formatConfigOption(opt)}\n`);
                    }
                    return "continue";
                }

                if (["mcp", "skills", "members", "env", "schedule"].includes(cmd)) {
                    await handleFamilyCommand(cmd, args);
                    return "continue";
                }

                writeErrorJsonl(streams.stderr, {
                    type: "https://problems.plurnk.xyz/client/unknown-command",
                    title: "Unknown command",
                    status: 400,
                    detail: `Unknown interactive command: /${cmd}`,
                });
            } catch (err) {
                writeErrorJsonl(streams.stderr, {
                    type: "https://problems.plurnk.xyz/client/command-failed",
                    title: "Command failed",
                    status: 500,
                    detail: err instanceof Error ? err.message : String(err),
                });
            }
            return "continue";
        }

        if (line.startsWith("!")) {
            const shellCmd = line.replace(/^!+\s*/u, "");
            if (shellCmd.length === 0) {
                writeErrorJsonl(streams.stderr, {
                    type: "https://problems.plurnk.xyz/client/usage",
                    title: "Empty shell command",
                    status: 400,
                    detail: "usage: ! <command>",
                });
                return "continue";
            }
            const fence = `\`\`\`sh\n${shellCmd}\n\`\`\``;
            try {
                const res = await client.action<{
                    readonly results?: ReadonlyArray<{
                        readonly status?: number;
                        readonly content?: string;
                        readonly message?: string;
                    }>;
                }>("op.parse", { text: fence }, bindingContext());
                for (const r of res.results ?? []) {
                    const out = r.content ?? r.message ?? String(r.status ?? 200);
                    streams.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
                }
            } catch (err) {
                writeErrorJsonl(streams.stderr, {
                    type: "https://problems.plurnk.xyz/client/exec-failed",
                    title: "Execution failed",
                    status: 500,
                    detail: err instanceof Error ? err.message : String(err),
                });
            }
            return "continue";
        }

        const isExecFence =
            !rawLine.trimStart().startsWith(": ") &&
            /^(`{3,}|~{3,})([^\s`~].*)\r?\n[\s\S]*$/u.test(line);
        if (isExecFence) {
            try {
                const res = await client.action<{
                    readonly results?: ReadonlyArray<{
                        readonly status?: number;
                        readonly content?: string;
                        readonly message?: string;
                    }>;
                }>("op.parse", { text: line }, bindingContext());
                for (const r of res.results ?? []) {
                    const out = r.content ?? r.message ?? String(r.status ?? 200);
                    streams.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
                }
            } catch (err) {
                writeErrorJsonl(streams.stderr, {
                    type: "https://problems.plurnk.xyz/client/exec-failed",
                    title: "Execution failed",
                    status: 500,
                    detail: err instanceof Error ? err.message : String(err),
                });
            }
            return "continue";
        }

        if (line.startsWith("...")) {
            const injected = line.slice(3).trimStart();
            if (injected.length === 0) return "continue";
            try {
                await client.action("loop.inject", { message: injected }, bindingContext());
            } catch {
                void client.prompt(session.sessionId, [{ type: "text", text: injected }]).catch((err) => {
                    writeErrorJsonl(streams.stderr, {
                        type: "https://problems.plurnk.xyz/client/prompt-failed",
                        title: "Prompt failed",
                        status: 500,
                        detail: err instanceof Error ? err.message : String(err),
                    });
                });
            }
            return "continue";
        }

        let promptText = line;
        if (line.startsWith("?")) {
            forceReviewNextRun = true;
            promptText = line.slice(1).trimStart();
        } else if (rawLine.trimStart().startsWith(": ")) {
            promptText = rawLine.trimStart().slice(2);
        }

        if (stagedComposerText.length > 0) {
            promptText = promptText.startsWith(stagedComposerText)
                ? promptText
                : `${stagedComposerText}\n${promptText}`;
            stagedComposerText = "";
        }

        const openPaths = extractOpenPaths(promptText, currentProjectRoot);
        currentLifecycle = "running";
        void client
            .prompt(session.sessionId, [{ type: "text", text: promptText }], {
                plurnk: {
                    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
                    ...(options.auto ? { envelope: { auto: true } } : {}),
                    ...(openPaths.length > 0 ? { openPaths } : {}),
                },
            })
            .catch((err) => {
                currentLifecycle = "idle";
                writeErrorJsonl(streams.stderr, {
                    type: "https://problems.plurnk.xyz/client/prompt-failed",
                    title: "Prompt failed",
                    status: 500,
                    detail: err instanceof Error ? err.message : String(err),
                });
            });
        return "continue";
    };

    const rl = readline.createInterface({
        input: streams.stdin,
        terminal: false,
    });

    return await new Promise<number>((resolvePromise) => {
        let settled = false;
        let queue = Promise.resolve();
        let inBracketedPaste = false;
        let pasteLines: string[] = [];
        let activeFenceClosing: RegExp | null = null;
        let fenceLines: string[] = [];
        let continuationLines: string[] = [];

        const onSigInt = (): void => {
            if (currentLifecycle === "running" || currentLifecycle === "parked" || pendingGates.size > 0) {
                for (const gate of [...pendingGates.values()]) {
                    if (gate.kind === "permission") {
                        gate.resolveGate({ outcome: { outcome: "cancelled" } });
                    } else {
                        gate.resolveGate({ action: "cancel" });
                    }
                }
                void client.cancel(session.sessionId).catch(() => {});
                streams.stdout.write("cancelled (final 499)\n");
                return;
            }
            if (stagedComposerText.length > 0) {
                stagedComposerText = "";
                writeEventJsonl(streams.events, {
                    sessionUpdate: "composer_updated",
                    source: "clear",
                    text: "",
                });
                return;
            }
            finish(0);
        };

        process.on("SIGINT", onSigInt);

        const finish = (code: number): void => {
            if (settled) return;
            settled = true;
            process.removeListener("SIGINT", onSigInt);
            flushReasoningNewline();
            rl.close();
            if (streams.stdin === process.stdin) {
                process.stdin.pause();
            }
            client.close();
            resolvePromise(code);
        };

        const enqueueSubmission = (submission: string): void => {
            queue = queue.then(async () => {
                if (settled) return;
                const action = await dispatchLine(submission);
                if (action === "quit") {
                    finish(0);
                }
            });
        };

        rl.on("line", (rawLine: string) => {
            if (inBracketedPaste) {
                const endIdx = rawLine.indexOf("\x1b[201~");
                if (endIdx >= 0) {
                    pasteLines.push(rawLine.slice(0, endIdx) + rawLine.slice(endIdx + "\x1b[201~".length));
                    const submission = pasteLines.join("\n");
                    pasteLines = [];
                    inBracketedPaste = false;
                    enqueueSubmission(submission);
                } else {
                    pasteLines.push(rawLine);
                }
                return;
            }

            const pasteStartIdx = rawLine.indexOf("\x1b[200~");
            if (pasteStartIdx >= 0) {
                const prefix = rawLine.slice(0, pasteStartIdx);
                const afterStart = rawLine.slice(pasteStartIdx + "\x1b[200~".length);
                const endIdx = afterStart.indexOf("\x1b[201~");
                if (endIdx >= 0) {
                    const combined =
                        prefix + afterStart.slice(0, endIdx) + afterStart.slice(endIdx + "\x1b[201~".length);
                    enqueueSubmission(combined);
                } else {
                    inBracketedPaste = true;
                    pasteLines = [prefix + afterStart];
                }
                return;
            }

            if (activeFenceClosing !== null) {
                fenceLines.push(rawLine);
                if (activeFenceClosing.test(rawLine)) {
                    const submission = fenceLines.join("\n");
                    fenceLines = [];
                    activeFenceClosing = null;
                    enqueueSubmission(submission);
                }
                return;
            }

            if (continuationLines.length === 0) {
                const candidate = rawLine.trimStart().startsWith(": ")
                    ? rawLine.trimStart().slice(2)
                    : rawLine.trimStart();
                const fenceMatch = candidate.match(/^(`{3,}|~{3,})([^\s`~].*)$/u);
                if (fenceMatch) {
                    const fenceSeq = fenceMatch[1]!;
                    const fenceChar = fenceSeq[0]!;
                    activeFenceClosing = new RegExp(`^\\s*${fenceChar}{${String(fenceSeq.length)},}\\s*$`, "u");
                    fenceLines = [rawLine];
                    return;
                }
            }

            if (rawLine.endsWith("\\")) {
                continuationLines.push(rawLine.slice(0, -1));
                return;
            }

            if (continuationLines.length > 0) {
                continuationLines.push(rawLine);
                const submission = continuationLines.join("\n");
                continuationLines = [];
                enqueueSubmission(submission);
                return;
            }

            enqueueSubmission(rawLine);
        });

        rl.on("close", () => {
            if (pasteLines.length > 0) {
                enqueueSubmission(pasteLines.join("\n"));
                pasteLines = [];
            }
            if (fenceLines.length > 0) {
                enqueueSubmission(fenceLines.join("\n"));
                fenceLines = [];
            }
            if (continuationLines.length > 0) {
                enqueueSubmission(continuationLines.join("\n"));
                continuationLines = [];
            }
            void queue.then(() => {
                finish(0);
            });
        });
    });
};

