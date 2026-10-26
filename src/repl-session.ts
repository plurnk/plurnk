// Five-stream contract ([stdin, stdout, stderr, events, reasoning], fd 0..4) and
// interactive REPL engine ({§cli-output-channels}, {§cli-repl-mode}, {§cli-tui-mode}).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, fstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import * as readline from "node:readline";
import { PassThrough, Writable } from "node:stream";
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
    openCliSession,
    type CliCommonOptions,
} from "./cli-runner.ts";
import { INTERACTIVE_COMMANDS, renderCommandReference } from "./commands.ts";
import { SessionPresenter, lifecycleGlyphFor, type PresentationFrame } from "./session-presenter.ts";
import { matchesKey, type Terminal } from "@earendil-works/pi-tui";
import { makeAutocompleteProvider } from "./tui-completion.ts";
import Review, { type ElicitationGateEvent, type PermissionGateEvent } from "./tui-review.ts";
import TuiSurface, {
    attention,
    bell,
    buildHeader,
    concluded,
    formatLoopMetrics,
    ModelText,
    paint,
    renderLoopSummary,
    renderModelReply,
    renderNoteBlock,
    renderOperationBlock,
    renderReasoning,
    renderSubmittedInput,
    windowTitle,
} from "./tui-surface.ts";

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

const formatFamilyRows = (family: string, result: Record<string, unknown>): string => {
    const definitions = Array.isArray(result.definitions)
        ? result.definitions
        : Array.isArray(result.items)
          ? result.items
          : [];
    if (definitions.length === 0) {
        return `${family}: none\n`;
    }
    const lines: string[] = [];
    for (const item of definitions) {
        const d = item as Record<string, unknown>;
        const alias = String(d.alias ?? d.name ?? d.glob ?? "");
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
        } else if (session.sessionId.includes("#")) {
            currentSessionName = session.sessionId.slice(session.sessionId.indexOf("#") + 1);
        }
        const visibleItems = session.items.filter((item) => {
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
        const chronologicalItems =
            firstId !== undefined && lastId !== undefined && firstId > lastId
                ? visibleItems.toReversed()
                : visibleItems;
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

        if (sub === "list") {
            const result = await client.action<Record<string, unknown>>(
                `${scopePrefix}.${family}.list`,
                {},
                bindingContext(),
            );
            streams.stdout.write(formatFamilyRows(family, result));
            return;
        }
        if (sub === "discover") {
            const query = rest.join(" ");
            const result = await client.action<Record<string, unknown>>(
                `${scopePrefix}.${family}.discover`,
                query.length > 0 ? { query, source: query } : {},
                bindingContext(),
            );
            streams.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            return;
        }
        if (sub === "enable" || sub === "disable" || sub === "remove") {
            const target = rest[0] ?? "";
            const param = family === "members" ? { file: target } : { alias: target };
            const result = await client.action<Record<string, unknown>>(
                `${scopePrefix}.${family}.${sub}`,
                param,
                bindingContext(),
            );
            streams.stdout.write(`${JSON.stringify(result)}\n`);
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
                bindingContext(),
            );
            streams.stdout.write(`${JSON.stringify(result)}\n`);
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
                bindingContext(),
            );
            streams.stdout.write(`${JSON.stringify(result)}\n`);
            return;
        }
        if (sub === "add" && family === "members") {
            const result = await client.action<Record<string, unknown>>(
                "workspace.members.add",
                { files: rest },
                bindingContext(),
            );
            streams.stdout.write(`${JSON.stringify(result)}\n`);
            return;
        }
        if ((sub === "add" || sub === "replace") && family === "env") {
            const alias = rest[0] ?? "";
            const value = rest.slice(1).join(" ");
            const result = await client.action<Record<string, unknown>>(
                `${scopePrefix}.env.${sub}`,
                { alias, definition: { value } },
                bindingContext(),
            );
            streams.stdout.write(`${JSON.stringify(result)}\n`);
            return;
        }
        if (sub === "import" && family === "env") {
            const filePath = rest[0];
            if (!filePath) {
                writeErrorJsonl(streams.stderr, {
                    type: "https://problems.plurnk.xyz/client/usage",
                    title: "Missing env import path",
                    status: 400,
                    detail: "usage: /env import <path>",
                });
                return;
            }
            const parsed = parseEnv(readFileSync(resolve(options.cwd, filePath), "utf8"));
            const entries = Object.entries(parsed);
            let landed = 0;
            for (const [alias, val] of entries) {
                try {
                    await client.action(
                        `${scopePrefix}.env.add`,
                        { alias, definition: { value: String(val ?? "") } },
                        bindingContext(),
                    );
                    landed += 1;
                } catch (err) {
                    writeErrorJsonl(streams.stderr, {
                        type: "https://problems.plurnk.xyz/client/command-failed",
                        title: "Env import entry failed",
                        status: 400,
                        detail: err instanceof Error ? err.message : String(err),
                    });
                }
            }
            const scopeDesc = scopePrefix === "workspace" ? "workspace defaults" : "this session only";
            streams.stdout.write(`imported ${String(landed)} of ${String(entries.length)} into ${scopeDesc}\n`);
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
                bindingContext(),
            );
            streams.stdout.write(`${JSON.stringify(result)}\n`);
            return;
        }
        const result = await client.action<Record<string, unknown>>(
            `${scopePrefix}.${family}.${sub}`,
            rest.length > 0 ? { args: rest } : {},
            bindingContext(),
        );
        streams.stdout.write(`${JSON.stringify(result)}\n`);
    };

    const navigateTopology = async (direction: "parent" | "enter" | "older" | "newer"): Promise<void> => {
        const res = await client.action<{
            readonly sessions?: ReadonlyArray<{
                readonly id?: number;
                readonly name: string;
                readonly parentSessionId?: number | null;
                readonly parent_session_id?: number | null;
                readonly origin?: string;
            }>;
        }>("workspace.sessions", {}, bindingContext());
        const sessions = (res.sessions ?? []).filter((s) => s.origin !== "maintenance" && s.origin !== "scratch");
        const parentOf = (s: { readonly parentSessionId?: number | null; readonly parent_session_id?: number | null } | undefined): number | null =>
            s?.parentSessionId ?? s?.parent_session_id ?? null;
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
                    const result = await client.action<{ readonly workspaces?: ReadonlyArray<Record<string, unknown>> }>(
                        "workspace.list",
                        {},
                    );
                    for (const w of result.workspaces ?? []) {
                        streams.stdout.write(
                            `${String(w.name ?? w.id)}\t${String(w.project_root ?? w.cwd ?? "")}\n`,
                        );
                    }
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
                    let result: unknown;
                    try {
                        result = await client.action("models.list", args.length > 0 ? { search: args.join(" ") } : {});
                    } catch {
                        result = await client.listProviders();
                    }
                    const rec = result as Record<string, unknown>;
                    const items = Array.isArray(rec.items)
                        ? rec.items
                        : Array.isArray(rec.providers)
                          ? rec.providers
                          : [];
                    for (const item of items) {
                        const r = item as Record<string, unknown>;
                        streams.stdout.write(
                            `${String(r.id ?? r.providerId ?? r.alias ?? "")}\t${String(r.name ?? r.model ?? "")}\n`,
                        );
                    }
                    return "continue";
                }

                if (cmd === "loops") {
                    const result = await client.action<{
                        readonly items?: ReadonlyArray<Record<string, unknown>>;
                        readonly loops?: ReadonlyArray<Record<string, unknown>>;
                    }>("session.loops", {}, bindingContext());
                    for (const l of result.items ?? result.loops ?? []) {
                        const seq = String(l.seq ?? l.id ?? "");
                        const summary = String(l.summary ?? l.prompt ?? "");
                        streams.stdout.write(`  ${seq}: ${summary}\n`);
                    }
                    return "continue";
                }

                if (cmd === "loop") {
                    const loopNum = args[0] ? Number.parseInt(args[0], 10) : undefined;
                    const result = await client.action<{
                        readonly entries?: ReadonlyArray<Record<string, unknown>>;
                    }>(
                        "log.read",
                        {
                            ...(loopNum !== undefined && Number.isInteger(loopNum) ? { loopId: loopNum } : {}),
                            limit: 100,
                        },
                        bindingContext(),
                    );
                    streams.stdout.write(`── loop ${String(loopNum ?? "current")} ──\n`);
                    for (const e of result.entries ?? []) {
                        streams.stdout.write(
                            `${String(e.loop_seq ?? e.loop_id)}/${String(e.turn_seq ?? e.turn_id)}/${String(e.sequence)}\t${String(e.op ?? "")}\t${String(e.status ?? "")}\n`,
                        );
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
                    if (cmd === "model" && args[1]) {
                        const effortRes = await client.setConfigOption(
                            session.sessionId,
                            "thought_level",
                            args[1],
                        );
                        session.configOptions = [...effortRes.configOptions];
                    }
                    writeEventJsonl(streams.events, {
                        sessionUpdate: "config_option_update",
                        configOptions: session.configOptions,
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

export const ALT_SHORTCUTS: Readonly<Record<string, string>> = Object.freeze({
    m: "/models",
    s: "/workspaces",
    R: "/sessions",
    L: "/loops",
    Y: "/yolo",
    N: "/workspace",
    M: "/members",
    x: "/stop",
    "?": "/help",
    e: "/editor",
    h: "/parent",
    l: "/enter",
    j: "/older",
    k: "/newer",
});

export const altShortcut = (forward: string): string | null => {
    const m = forward.match(/^\x1b([a-zA-Z?])$/u);
    return m ? (ALT_SHORTCUTS[m[1]!] ?? null) : null;
};

export const backTabShortcut = (forward: string): string | null =>
    forward === "\x1b[Z" ? "/yolo" : null;

// Pure TUI viewport composed atop the 5-stream contract ([stdin, stdout, stderr, events, reasoning]).
// Holds no reference to AcpClient or AcpSession ({§cli-tui-mode}).
export const runTuiViewport = async (
    options: CliCommonOptions,
    outerStreams?: Partial<Pick<ClientStreams, "stdin" | "stdout" | "stderr">> & {
        readonly terminal?: Terminal;
    },
): Promise<number> => {
    const replStdin = new PassThrough();
    const replStdout = new PassThrough();
    const replStderr = new PassThrough();
    const replEvents = new PassThrough();
    const replReasoning = new PassThrough();

    const termIn = outerStreams?.stdin ?? process.stdin;
    const termOut = outerStreams?.stdout ?? process.stdout;
    const termErr = outerStreams?.stderr ?? process.stderr;

    const useSurface =
        outerStreams?.terminal !== undefined ||
        (outerStreams === undefined && process.stdin.isTTY === true && process.stdout.isTTY === true);
    const surface = useSurface ? new TuiSurface(outerStreams?.terminal) : null;
    if (surface !== null) {
        await surface.learnGround();
    }

    const attend = attention(options.bell ? [bell(termOut as { readonly isTTY?: boolean; write(chunk: string): unknown })] : []);

    const presenter = new SessionPresenter({
        workspaceName: options.workspace ?? "default",
        sessionName: options.sessionId ?? options.tuiSession ?? "user",
        model: options.model ?? "default",
        yolo: options.yolo,
    });

    let initialPromptPrinted = false;
    let initialWorkspaceConsumed = false;
    let boundProjectRoot: string | null = options.projectRoot ?? options.cwd;
    let cachedModels: string[] = [];
    let cachedEfforts: string[] = ["low", "medium", "high"];
    let cachedSessions: string[] = [];
    let cachedWorkspaces: string[] = [];
    let liveReasoningBuffer = "";
    let liveReasoningTurnEnded = false;
    let currentTurns = 0;
    const focusedGateIds: string[] = [];
    const suppressedStdoutQueue: string[] = [];

    const editInExternalEditor = (initialText: string): string | null => {
        const editorCmd = options.env.VISUAL || options.env.EDITOR || "vi";
        const tmpDir = mkdtempSync(join(tmpdir(), "plurnk-tui-editor-"));
        const tmpFile = join(tmpDir, "buffer.md");
        try {
            writeFileSync(tmpFile, initialText, "utf8");
            const res = spawnSync(editorCmd, [tmpFile], {
                stdio: "inherit",
                shell: true,
                env: options.env as NodeJS.ProcessEnv,
            });
            if (res.status === 0) {
                return readFileSync(tmpFile, "utf8");
            }
            return null;
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    };

    const review =
        surface !== null
            ? new Review(surface, {
                  sendStdin: (cmd) => {
                      replStdin.write(cmd);
                  },
                  editBody: async (initialBody) => {
                      return await surface.handOff(() => editInExternalEditor(initialBody));
                  },
                  record: (text) => {
                      surface.append(text);
                  },
              })
            : null;

    const updateSurfaceStatus = (): void => {
        if (surface === null) return;
        const place =
            currentTurns > 0
                ? `[${presenter.workspaceName}/~${presenter.sessionName}(1/${String(currentTurns)})]`
                : `[${presenter.workspaceName}/~${presenter.sessionName}]`;
        const activity =
            presenter.lastStatusLine.length > 0
                ? presenter.lastStatusLine
                : `${presenter.lifecycle === "running" ? "⌛︎ " : presenter.lifecycle} · 🎲 ${presenter.model}`;
        surface.setStatus(`${place} ${activity}`);
    };

    const ensureSurfaceStarted = (): void => {
        if (surface === null || initialPromptPrinted) return;
        initialPromptPrinted = true;
        surface.start();
        const header = buildHeader({
            workspaceName: presenter.workspaceName,
            sessionName: presenter.sessionName,
            modelSelector: presenter.model,
            effort: presenter.effort,
            yolo: presenter.yolo,
        });
        surface.append(paint(header, "dim"));
        surface.setTitle(windowTitle(presenter.workspaceName, presenter.sessionName));
        surface.append("");
        updateSurfaceStatus();
        surface.renderNow();
    };

    const renderToolCallToSurface = (frame: Extract<PresentationFrame, { kind: "tool_call" }>): void => {
        if (surface === null) return;
        if (frame.op === "NOTE" && frame.origin === "model") {
            const rendered = renderNoteBlock({
                glyph: frame.glyph,
                aside: frame.aside,
                body: frame.noteBody ?? frame.contentLines.join("\n"),
                columns: surface.columns,
            });
            surface.append(rendered);
            if (rendered.includes("\n")) {
                surface.append("");
            }
        } else {
            const rendered = renderOperationBlock({
                glyph: frame.glyph,
                op: frame.op,
                title: frame.title,
                target: frame.target,
                scope: frame.scope,
                destination: frame.destination,
                pattern: frame.pattern,
                count: frame.count,
                aside: frame.aside,
                status: frame.status,
                statusCode: frame.statusCode,
                outcome: frame.outcome,
                contentLines: frame.contentLines,
                outputLines: frame.outputLines,
                coordinate: frame.toolCallId,
                previewLimit: options.previewLines,
                columns: surface.columns,
            });
            surface.append(rendered);
            if (rendered.includes("\n")) {
                surface.append("");
            }
        }
    };

    const statusTicker =
        surface !== null
            ? setInterval(() => {
                  if (presenter.lifecycle === "running" || presenter.lifecycle === "parked") {
                      presenter.buildStatusBar();
                      updateSurfaceStatus();
                  }
              }, 1000).unref()
            : null;

    const GATE_VERBS = new Set(["approve", "accept", "reject", "cancel", "edit", "answer"]);

    const routeAndSendLine = (rawSubmission: string): void => {
        const trimmed = rawSubmission.trim();
        if (trimmed.length === 0) return;
        if (trimmed.startsWith("/")) {
            const tokens = trimmed.slice(1).split(/\s+/u);
            const verb = tokens[0]?.toLowerCase() ?? "";
            const firstArg = tokens[1];
            const focusedId = focusedGateIds[0];
            if (
                GATE_VERBS.has(verb) &&
                focusedId !== undefined &&
                (firstArg === undefined || !firstArg.startsWith("@"))
            ) {
                const afterVerb = trimmed.slice(1 + verb.length).trimStart();
                const routed = afterVerb.length > 0 ? `/${verb} @${focusedId} ${afterVerb}` : `/${verb} @${focusedId}`;
                replStdin.write(
                    routed.includes("\n") ? `\x1b[200~${routed}\x1b[201~\n` : `${routed}\n`,
                );
                return;
            }
        }
        if (!trimmed.startsWith("/") && !trimmed.startsWith("!")) {
            presenter.markTurnStart();
            presenter.buildStatusBar();
            updateSurfaceStatus();
        }
        replStdin.write(
            rawSubmission.includes("\n")
                ? `\x1b[200~${rawSubmission}\x1b[201~\n`
                : `${rawSubmission}\n`,
        );
    };

    let removeInputListener: (() => void) | null = null;
    if (surface !== null) {
        surface.setAutocompleteProvider(
            makeAutocompleteProvider({
                cwd: options.cwd,
                getProjectRoot: () => boundProjectRoot,
                getModels: () => cachedModels,
                getEfforts: () => cachedEfforts,
                getSessionNames: () => cachedSessions,
                getWorkspaceNames: () => cachedWorkspaces,
                getPendingGateIds: () => focusedGateIds,
            }),
        );

        removeInputListener = surface.addInputListener((text) => {
            if (surface.dialogOpen) return undefined;
            if (matchesKey(text, "escape")) {
                if (surface.leaveReview()) return { consume: true };
                if (presenter.lifecycle === "running" || presenter.lifecycle === "parked" || presenter.lifecycle === "requires_action") {
                    replStdin.write("/stop\n");
                    return { consume: true };
                }
                if (surface.editor.getText().length > 0) {
                    surface.setInput("");
                }
                return { consume: true };
            }
            if (matchesKey(text, "ctrl+c")) {
                if (
                    presenter.lifecycle === "running" ||
                    presenter.lifecycle === "parked" ||
                    presenter.lifecycle === "requires_action" ||
                    focusedGateIds.length > 0
                ) {
                    replStdin.write("/stop\n");
                } else if (surface.editor.getText().length > 0) {
                    surface.setInput("");
                } else {
                    replStdin.write("/quit\n");
                }
                return { consume: true };
            }
            if (matchesKey(text, "ctrl+d") && !surface.reviewing && surface.editor.getText().length === 0) {
                replStdin.write("/quit\n");
                return { consume: true };
            }
            if (surface.reviewing) return undefined;
            const shortcut = altShortcut(text) ?? backTabShortcut(text);
            if (shortcut !== null) {
                if (shortcut === "/editor") {
                    const draft = surface.editor.getText();
                    void surface.handOff(() => editInExternalEditor(draft)).then((edited) => {
                        if (edited !== null) {
                            surface.setInput(edited.replace(/\r?\n$/u, ""));
                        }
                    });
                } else {
                    replStdin.write(`${shortcut}\n`);
                }
                return { consume: true };
            }
            return undefined;
        });

        surface.editor.onSubmit = (rawText: string) => {
            const trimmed = rawText.trim();
            if (trimmed.length === 0) return;
            surface.editor.addToHistory(rawText);
            surface.append("");
            surface.append(renderSubmittedInput(rawText));
            surface.append("");

            if (trimmed === "/review" && review !== null && review.waiting > 0) {
                surface.openReview();
                return;
            }

            if (trimmed === "/editor") {
                void surface.handOff(() => editInExternalEditor("")).then((edited) => {
                    if (edited !== null) {
                        surface.setInput(edited.replace(/\r?\n$/u, ""));
                    }
                });
                return;
            }

            const importMatch = trimmed.match(/^\/import(?:\s+(.+))?$/u);
            if (importMatch) {
                const filePath = importMatch[1]?.trim() ?? "";
                if (!filePath) {
                    replStdin.write("/import\n");
                    return;
                }
                try {
                    const content = readFileSync(resolve(options.cwd, filePath), "utf8");
                    surface.insertInput(content);
                } catch (err) {
                    surface.append(
                        paint(
                            `error: ${ModelText.plain(err instanceof Error ? err.message : String(err))}`,
                            "failure",
                        ),
                    );
                }
                return;
            }

            routeAndSendLine(rawText);
        };
    }

    const retireLiveReasoning = (): void => {
        if (liveReasoningBuffer.length > 0) {
            liveReasoningBuffer = "";
            liveReasoningTurnEnded = false;
            surface?.setLive(null);
        }
    };

    replStdout.setEncoding("utf8");
    replStdout.on("data", (chunk: string) => {
        if (surface !== null) {
            if (!initialWorkspaceConsumed && chunk.startsWith("workspace: ")) {
                initialWorkspaceConsumed = true;
                ensureSurfaceStarted();
                return;
            }
            let remaining = chunk;
            while (suppressedStdoutQueue.length > 0 && remaining.startsWith(suppressedStdoutQueue[0]!)) {
                remaining = remaining.slice(suppressedStdoutQueue.shift()!.length);
            }
            if (remaining.length === 0) return;
            const trimmed = remaining.replace(/\r?\n$/u, "");
            if (trimmed === "yolo: on" || trimmed === "yolo: off") {
                presenter.yolo = trimmed === "yolo: on";
                updateSurfaceStatus();
            }
            if (trimmed.length > 0) {
                surface.append(trimmed);
            }
            return;
        }

        if (
            !initialPromptPrinted &&
            chunk.startsWith("workspace: ") &&
            presenter.workspaceName &&
            presenter.sessionName
        ) {
            initialPromptPrinted = true;
            termOut.write(`${chunk}[${presenter.workspaceName}/~${presenter.sessionName}] `);
            return;
        }
        if (chunk.startsWith("● ") && presenter.lastStatusLine.length > 0 && !chunk.includes("🎲")) {
            const trimmed = chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk;
            termOut.write(`${trimmed}\n${presenter.lastStatusLine}\n`);
            return;
        }
        termOut.write(chunk);
    });

    replStderr.setEncoding("utf8");
    let stderrBuf = "";
    replStderr.on("data", (chunk: string) => {
        stderrBuf += chunk;
        const lines = stderrBuf.split("\n");
        stderrBuf = lines.pop() ?? "";
        for (const line of lines) {
            if (line.trim().length === 0) continue;
            try {
                const parsed = JSON.parse(line) as Record<string, unknown>;
                if (
                    typeof parsed.type === "string" &&
                    parsed.type.startsWith("https://problems.plurnk.xyz/client/")
                ) {
                    const detail =
                        typeof parsed.detail === "string"
                            ? parsed.detail
                            : typeof parsed.title === "string"
                              ? parsed.title
                              : line;
                    if (surface !== null) {
                        surface.append(paint(ModelText.plain(detail), "failure"));
                    } else {
                        termErr.write(`${detail}\n`);
                    }
                }
            } catch {
                if (surface !== null) {
                    surface.append(paint(ModelText.plain(line), "failure"));
                } else {
                    termErr.write(`${line}\n`);
                }
            }
        }
    });

    replReasoning.setEncoding("utf8");
    replReasoning.on("data", (chunk: string) => {
        if (surface !== null) {
            if (liveReasoningTurnEnded) {
                liveReasoningBuffer = "";
                liveReasoningTurnEnded = false;
            }
            liveReasoningBuffer += chunk;
            const rendered = renderReasoning(liveReasoningBuffer);
            if (rendered.length > 0) {
                surface.setLive(rendered);
            }
            return;
        }
        const trimmed = chunk.replace(/\r?\n$/u, "");
        if (trimmed.length > 0) {
            termOut.write(`${trimmed}\n`);
        }
    });

    replEvents.setEncoding("utf8");
    let eventsBuf = "";
    replEvents.on("data", (chunk: string) => {
        eventsBuf += chunk;
        const lines = eventsBuf.split("\n");
        eventsBuf = lines.pop() ?? "";
        for (const line of lines) {
            if (line.trim().length === 0) continue;
            let event: Record<string, unknown>;
            try {
                event = JSON.parse(line) as Record<string, unknown>;
            } catch {
                continue;
            }

            if (event.sessionUpdate === "session_bound") {
                const prevWorkspace = presenter.workspaceName;
                const prevSession = presenter.sessionName;
                const wasStarted = initialPromptPrinted;
                if (typeof event.workspace === "string" && event.workspace.length > 0) {
                    presenter.workspaceName = event.workspace;
                }
                if (typeof event.session === "string" && event.session.length > 0) {
                    presenter.sessionName = event.session;
                }
                if (typeof event.cwd === "string") {
                    boundProjectRoot = event.cwd.length > 0 ? event.cwd : null;
                }
                if (Array.isArray(event.sessions)) {
                    cachedSessions = event.sessions
                        .map((s) => (s && typeof s === "object" ? String((s as { name?: unknown }).name ?? "") : ""))
                        .filter(Boolean);
                }
                if (Array.isArray(event.workspaces)) {
                    cachedWorkspaces = event.workspaces
                        .map((w) => (w && typeof w === "object" ? String((w as { name?: unknown }).name ?? "") : ""))
                        .filter(Boolean);
                }
                if (Array.isArray(event.configOptions)) {
                    for (const rawOpt of event.configOptions) {
                        const opt = rawOpt as {
                            configId?: string;
                            currentValue?: string;
                            options?: ReadonlyArray<{ value?: string }>;
                        };
                        if (opt.configId === "model") {
                            if (typeof opt.currentValue === "string" && opt.currentValue.length > 0) {
                                presenter.model = opt.currentValue;
                            }
                            if (Array.isArray(opt.options)) {
                                cachedModels = opt.options.map((o) => String(o.value ?? "")).filter(Boolean);
                            }
                        } else if (opt.configId === "thought_level") {
                            if (typeof opt.currentValue === "string") {
                                presenter.effort = opt.currentValue.length > 0 ? opt.currentValue : null;
                            }
                            if (Array.isArray(opt.options)) {
                                cachedEfforts = opt.options.map((o) => String(o.value ?? "")).filter(Boolean);
                            }
                        }
                    }
                }
                if (event._meta && typeof event._meta === "object") {
                    presenter.ingestMeta(event._meta as Record<string, unknown>);
                }
                if (surface !== null) {
                    ensureSurfaceStarted();
                    if (Array.isArray(event.history) && event.history.length > 0) {
                        for (const rawItem of event.history) {
                            const rec = rawItem as Record<string, unknown>;
                            if (rec.kind === "user_message" && typeof rec.text === "string" && rec.text.length > 0) {
                                surface.editor.addToHistory(rec.text);
                                surface.append("");
                                surface.append(renderSubmittedInput(rec.text));
                                surface.append("");
                            } else if (rec.kind === "tool_call" && typeof rec.toolCallId === "string") {
                                const effectiveStatus =
                                    rec.status === "in_progress" || rec.status === "pending"
                                        ? "completed"
                                        : typeof rec.status === "string"
                                          ? rec.status
                                          : "completed";
                                const tcFrames = presenter.apply({
                                    sessionUpdate: "tool_call_update",
                                    toolCallId: rec.toolCallId,
                                    ...(typeof rec.name === "string" ? { name: rec.name } : {}),
                                    ...(typeof rec.title === "string" ? { title: rec.title } : {}),
                                    status: effectiveStatus,
                                    ...(Array.isArray(rec.locations) ? { locations: rec.locations } : {}),
                                    ...(Array.isArray(rec.content) ? { content: rec.content } : {}),
                                    ...(rec.rawInput !== undefined ? { rawInput: rec.rawInput } : {}),
                                    ...(rec.rawOutput !== undefined ? { rawOutput: rec.rawOutput } : {}),
                                    ...(rec.meta !== undefined ? { _meta: rec.meta } : {}),
                                } as unknown as SessionUpdate);
                                for (const f of tcFrames) {
                                    if (f.kind === "tool_call") {
                                        renderToolCallToSurface(f);
                                    }
                                }
                            } else if (
                                rec.kind === "agent_message" &&
                                typeof rec.text === "string" &&
                                rec.text.length > 0
                            ) {
                                const plurnkMeta = (
                                    rec.meta as
                                        | {
                                              plurnk?: {
                                                  op?: string;
                                                  status?: number;
                                                  attrs?: { aside?: string };
                                              };
                                          }
                                        | undefined
                                )?.plurnk;
                                surface.append(
                                    renderModelReply(rec.text, surface.columns, {
                                        op: plurnkMeta?.op ?? "SEND",
                                        status: plurnkMeta?.status ?? 200,
                                        aside: plurnkMeta?.attrs?.aside ?? null,
                                    }),
                                );
                            }
                        }
                    }
                    if (wasStarted && (presenter.workspaceName !== prevWorkspace || presenter.sessionName !== prevSession)) {
                        currentTurns = 0;
                        presenter.lastLoopStatus = null;
                        presenter.lastStatusLine = "";
                    }
                    surface.setTitle(windowTitle(presenter.workspaceName, presenter.sessionName));
                    updateSurfaceStatus();
                    surface.renderNow();
                }
                continue;
            }

            if (event.sessionUpdate === "composer_updated") {
                if (surface !== null && typeof event.text === "string") {
                    surface.setInput(event.text);
                }
                continue;
            }

            if (event.sessionUpdate === "permission_request") {
                if (typeof event.id === "string" && event.id.length > 0 && !focusedGateIds.includes(event.id)) {
                    focusedGateIds.push(event.id);
                }
                if (review !== null && typeof event.id === "string") {
                    review.addPermissionGate(event as unknown as PermissionGateEvent);
                    attend("review");
                }
                continue;
            }

            if (event.sessionUpdate === "elicitation_request") {
                if (typeof event.id === "string" && event.id.length > 0 && !focusedGateIds.includes(event.id)) {
                    focusedGateIds.push(event.id);
                }
                if (review !== null && typeof event.id === "string") {
                    review.addElicitationGate(event as unknown as ElicitationGateEvent);
                    attend("question");
                }
                continue;
            }

            if (event.sessionUpdate === "gate_resolved") {
                if (typeof event.id === "string") {
                    const idx = focusedGateIds.indexOf(event.id);
                    if (idx >= 0) focusedGateIds.splice(idx, 1);
                    review?.remove(event.id);
                }
                continue;
            }

            const frames = presenter.apply(event as unknown as SessionUpdate);
            for (const frame of frames) {
                switch (frame.kind) {
                    case "reasoning_tail":
                    case "reasoning_retired":
                    case "subagent":
                        break;
                    case "status_update":
                        if (frame.newTurn) {
                            liveReasoningTurnEnded = true;
                            surface?.archiveTurn();
                        }
                        if (surface !== null) {
                            updateSurfaceStatus();
                        } else if (frame.status.lifecycle === "parked") {
                            termOut.write(`${frame.status.formattedStatusLine}\n`);
                        }
                        break;
                    case "reply_chunk":
                        if (surface !== null && frame.text.length > 0) {
                            suppressedStdoutQueue.push(frame.text.endsWith("\n") ? frame.text : `${frame.text}\n`);
                            surface.addResponse(
                                renderModelReply(frame.text, surface.columns, {
                                    op: frame.op,
                                    status: frame.status,
                                    aside: frame.aside,
                                }),
                            );
                        }
                        break;
                    case "tool_call":
                        if (surface !== null) {
                            renderToolCallToSurface(frame);
                            updateSurfaceStatus();
                        } else {
                            if (frame.title) {
                                termOut.write(`${frame.title}\n`);
                            }
                            for (const cLine of frame.contentLines) {
                                termOut.write(`${cLine}\n`);
                            }
                        }
                        break;
                    case "terminal_output":
                        // Stream telemetry never writes directly to the TUI waterfall ({§cli-what-is-not-rendered});
                        // concluded output is previewed beneath the launching operation row when it finishes.
                        if (surface === null) {
                            termOut.write(`${frame.rawData}\n`);
                        }
                        break;
                    case "session_message":
                        if (surface !== null) {
                            surface.append(`🐜 ${ModelText.plain(frame.senderSessionId)}: ${ModelText.plain(frame.text)}`);
                        } else {
                            termOut.write(`🐜 ${frame.senderSessionId}: ${frame.text}\n`);
                        }
                        break;
                    case "notice":
                        if (surface !== null) {
                            const accent = frame.severity === "info" ? "dim" : "failure";
                            surface.append(paint(ModelText.plain(frame.formatted), accent));
                        } else {
                            termOut.write(`${frame.formatted}\n`);
                        }
                        break;
                    case "status_bar":
                        retireLiveReasoning();
                        currentTurns = frame.turns;
                        if (surface !== null) {
                            const metricsOpts = {
                                turns: frame.turns,
                                elapsedMs: frame.elapsedMs,
                                inputTokens: frame.status.inputTokens,
                                outputTokens: frame.status.outputTokens,
                                curationWeight: frame.status.curationWeight,
                                curationBudget: frame.status.curationBudget,
                                contextTokens: frame.status.contextTokens,
                                contextCapacity: frame.status.contextCapacity,
                                costUsd: frame.status.costUsd,
                            };
                            const attachedToHamster = surface.archiveTurn(
                                frame.statusCode === 200 && !frame.hitMaxTurns
                                    ? formatLoopMetrics(metricsOpts)
                                    : null,
                            );
                            if (frame.terminalDetail) {
                                surface.append(paint(ModelText.plain(frame.terminalDetail), "failure"));
                            }
                            if (!attachedToHamster) {
                                surface.append(
                                    renderLoopSummary({
                                        status: frame.statusCode,
                                        hitMaxTurns: frame.hitMaxTurns,
                                        ...metricsOpts,
                                    }),
                                );
                            }
                            updateSurfaceStatus();
                            attend(concluded(frame.statusCode, frame.hitMaxTurns));
                        } else {
                            if (frame.terminalDetail) {
                                termOut.write(`${frame.terminalDetail}\n`);
                            }
                            termOut.write(
                                `${frame.status.formattedStatusLine}\n[${presenter.workspaceName}/~${presenter.sessionName}(1/${frame.turns})] `,
                            );
                        }
                        break;
                }
            }
        }
    });

    const userRl = surface === null ? readline.createInterface({ input: termIn, terminal: false }) : null;
    if (userRl !== null) {
        userRl.on("line", (line: string) => {
            routeAndSendLine(line);
        });
        userRl.on("close", () => {
            replStdin.end();
        });
    }

    try {
        return await runReplSession(options, {
            stdin: replStdin,
            stdout: replStdout,
            stderr: replStderr,
            events: replEvents,
            reasoning: replReasoning,
        });
    } finally {
        if (statusTicker !== null) {
            clearInterval(statusTicker);
        }
        removeInputListener?.();
        surface?.stop();
        userRl?.close();
    }
};
