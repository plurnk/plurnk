// Five-stream contract ([stdin, stdout, stderr, events, reasoning], fd 0..4) and
// interactive REPL engine ({§cli-output-channels}, {§cli-repl-mode}).

import * as readline from "node:readline";
import {
    CreateElicitationRequest,
    SessionConfigOption,
    SessionUpdate,
    type CreateElicitationResponse,
    type RequestPermissionResponse,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { AcpClient } from "./acp-client.ts";
import { AcpSession, contentBlockToText } from "./acp-session.ts";
import {
    ensureDaemonConnected,
    openCliSession,
    type CliCommonOptions,
} from "./cli-connection.ts";
import { matchesRuntimeAcceptance } from "./cli-permission.ts";
import { expandLearnCommand } from "./commands.ts";
import {
    executeFamilyCommand,
    extractChronologicalHistory,
    extractOpenPaths,
    extractPromptHistory,
    formatFamilyRows,
    formatLogEntries,
    formatModelsRows,
    formatWorkspacesRows,
    mintGateHash,
    openProcessStreams,
    writeErrorJsonl,
    writeEventJsonl,
    type ClientStreams,
} from "./repl-commands.ts";
import { dispatchSlashCommand, type PendingGate } from "./repl-slash-commands.ts";

export {
    executeFamilyCommand,
    extractChronologicalHistory,
    extractOpenPaths,
    formatFamilyRows,
    formatLogEntries,
    formatModelsRows,
    formatWorkspacesRows,
    mintGateHash,
    openProcessStreams,
    writeErrorJsonl,
    writeEventJsonl,
    type ClientStreams,
};

export interface ReplSessionHooks {
    readonly onProviderModelsFetcher?: (fetcher: (provider: string) => Promise<readonly string[]>) => void;
}

export const runReplSession = async (
    options: CliCommonOptions,
    customStreams?: Partial<ClientStreams> & ReplSessionHooks,
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
        } else if (session.sessionId.includes("#")) {
            const prefix = session.sessionId.slice(0, session.sessionId.indexOf("#"));
            if (prefix.length > 0 && !/^\d+$/u.test(prefix)) {
                currentWorkspace = prefix;
            }
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
        const prompts = extractPromptHistory(session, historyLimit);
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
            prompts,
            ...(extra?.sessions !== undefined ? { sessions: extra.sessions } : {}),
            ...(extra?.workspaces !== undefined ? { workspaces: extra.workspaces } : {}),
            ...(mergedMeta !== undefined ? { _meta: mergedMeta } : {}),
        });
    };

    const handleSessionUpdate = (update: SessionUpdate): void => {
        if (SessionUpdate.isAgentThoughtChunk(update)) {
            const metaPlurnk = (
                update._meta as
                    | { plurnk?: { op?: unknown; outside?: unknown } }
                    | undefined
            )?.plurnk;
            const isOutside =
                (typeof update.messageId === "string" && update.messageId.startsWith("outside-")) ||
                metaPlurnk?.op === "outside-" ||
                metaPlurnk?.outside !== undefined;
            if (isOutside) {
                flushReasoningNewline();
                writeEventJsonl(streams.events, update);
                return;
            }
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
            const metaPlurnk = (
                update._meta as
                    | { plurnk?: { op?: unknown; outside?: unknown } }
                    | undefined
            )?.plurnk;
            const isOutside =
                (typeof update.messageId === "string" && update.messageId.startsWith("outside-")) ||
                metaPlurnk?.op === "outside-" ||
                metaPlurnk?.outside !== undefined;
            // {§cli-markdown-projection} — Outside text never enters CLI stdout.
            if (!isOutside) {
                const text = contentBlockToText(update.content);
                if (text.length > 0) {
                    streams.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
                }
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
            if (
                rawNotice?.kind === "turn_generated" ||
                rawNotice?.kind === "turn_awaiting_model" ||
                rawNotice?.kind === "loop_status"
            ) {
                flushReasoningNewline();
            }
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
            const rawNotice = (
                update._meta as { plurnk?: { notice?: Record<string, unknown> } } | undefined
            )?.plurnk?.notice;
            if (
                rawNotice?.kind === "turn_generated" ||
                rawNotice?.kind === "turn_awaiting_model" ||
                rawNotice?.kind === "loop_status"
            ) {
                flushReasoningNewline();
            }
            if (rawNotice?.kind === "loop_status") {
                if (rawNotice.status === 202) {
                    currentLifecycle = "parked";
                } else if (rawNotice.status === 102) {
                    currentLifecycle = "running";
                } else if (rawNotice.status === 100) {
                    currentLifecycle = "queued";
                }
            } else if (update.state === "running") {
                const metaLifecycle = (
                    update._meta as { plurnk?: { status?: { lifecycle?: unknown } } } | undefined
                )?.plurnk?.status?.lifecycle;
                currentLifecycle = metaLifecycle === "parked" ? "parked" : "running";
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

        if (SessionUpdate.isCustom(update)) {
            const rawNotice = (
                update._meta as { plurnk?: { notice?: Record<string, unknown> } } | undefined
            )?.plurnk?.notice;
            if (
                rawNotice?.kind === "turn_generated" ||
                rawNotice?.kind === "turn_awaiting_model" ||
                rawNotice?.kind === "loop_status"
            ) {
                flushReasoningNewline();
            }
            if (rawNotice?.kind === "loop_status") {
                if (rawNotice.status === 202) {
                    currentLifecycle = "parked";
                } else if (rawNotice.status === 102) {
                    currentLifecycle = "running";
                } else if (rawNotice.status === 100) {
                    currentLifecycle = "queued";
                }
            }
            writeEventJsonl(streams.events, update);
            return;
        }

        writeEventJsonl(streams.events, update);
    };

    let activeSession = null as AcpSession | null;
    let activeLocalMcpOAuth = 0;

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

            if ((currentYolo || options.auto || matchesRuntimeAcceptance(request, options.env)) && !forceReviewNextRun) {
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
            if (
                activeLocalMcpOAuth > 0 &&
                CreateElicitationRequest.isUrl(request) &&
                request.elicitationId.startsWith("mcp-oauth:")
            ) {
                return { action: "accept" };
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

    try {
        await ensureDaemonConnected(client, options);
        const providerModelsCache = new Map<string, Promise<readonly string[]>>();
        customStreams?.onProviderModelsFetcher?.((provider: string) => {
            const existing = providerModelsCache.get(provider);
            if (existing !== undefined) return existing;
            const promise = client
                .action<{ readonly items?: ReadonlyArray<{ readonly selector?: string }> }>("models.list", {
                    provider,
                    limit: 100,
                })
                .then((res) =>
                    (res.items ?? [])
                        .map((item) => (typeof item?.selector === "string" ? item.selector : ""))
                        .filter(Boolean),
                )
                .catch(() => {
                    providerModelsCache.delete(provider);
                    return [];
                });
            providerModelsCache.set(provider, promise);
            return promise;
        });

        const bindSession = async (
            workspaceName: string | undefined,
            sessionName: string,
            bindOpts?: { readonly initial?: boolean; readonly isChild?: boolean },
        ): Promise<AcpSession> => {
        const nextSession = await openCliSession(
            client,
            {
                ...options,
                interactive: !options.auto,
                ...(workspaceName !== undefined ? { workspace: workspaceName } : {}),
                sessionId: sessionName,
                model: bindOpts?.initial ? options.model : undefined,
                effort: bindOpts?.initial ? options.effort : undefined,
                persona: bindOpts?.initial ? options.persona : undefined,
                systemPrompt: bindOpts?.initial ? options.systemPrompt : undefined,
                sessionEnv: bindOpts?.isChild ? undefined : options.sessionEnv,
            },
            (update, s) => {
                if (s === activeSession) {
                    handleSessionUpdate(update);
                }
            },
            options.historyEntries > 0,
        );
        if (activeSession !== null && activeSession !== nextSession) {
            const prevId = activeSession.sessionId;
            activeSession.dispose();
            if (prevId !== nextSession.sessionId) {
                client.untrackSession(prevId);
            }
        }
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
        const [sessionsRes, workspacesRes, modelsRes] = await Promise.all([
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
            client
                .action<{
                    readonly items?: ReadonlyArray<{
                        readonly selector?: string;
                        readonly modelName?: string;
                        readonly limits?: { readonly contextTokens?: number; readonly inputTokens?: number };
                    }>;
                }>("models.list", { limit: 100 })
                .catch(() => undefined),
        ]);
        const catalogOptions = (modelsRes?.items ?? [])
            .filter(
                (
                    m,
                ): m is {
                    readonly selector: string;
                    readonly modelName?: string;
                    readonly limits?: { readonly contextTokens?: number; readonly inputTokens?: number };
                } => typeof m?.selector === "string" && m.selector.length > 0,
            )
            .map((m) => {
                const cap = m.limits?.inputTokens ?? m.limits?.contextTokens;
                return {
                    value: m.selector,
                    name:
                        m.modelName && m.modelName !== m.selector
                            ? `${m.selector} (${m.modelName})`
                            : m.selector,
                    description:
                        typeof cap === "number" && cap > 0
                            ? `${String(Math.round(cap / 1000))}k context`
                            : null,
                };
            });
        const existingModelOptIdx = nextSession.configOptions.findIndex((o) => o.configId === "model");
        if (
            existingModelOptIdx < 0 &&
            ((plurnk?.status && typeof plurnk.status === "object" && "model" in plurnk.status) ||
                catalogOptions.length > 0)
        ) {
            const statusModel =
                (
                    plurnk?.status as
                        | { model?: { alias?: string | null; provider?: string; model?: string } | null }
                        | undefined
                )?.model ?? null;
            const activeProvider = Array.isArray(plurnk?.providers)
                ? (plurnk.providers as unknown[]).find(
                      (p): p is { alias?: string; provider?: string; model?: string } =>
                          Boolean(p) && typeof p === "object" && (p as { active?: unknown }).active === true,
                  )
                : undefined;
            const currentVal =
                statusModel !== null && typeof statusModel === "object"
                    ? (statusModel.alias ??
                      (typeof statusModel.provider === "string" && typeof statusModel.model === "string"
                          ? `${statusModel.provider}/${statusModel.model}`
                          : "none"))
                    : activeProvider !== undefined
                      ? (activeProvider.alias ??
                        (typeof activeProvider.provider === "string" && typeof activeProvider.model === "string"
                            ? `${activeProvider.provider}/${activeProvider.model}`
                            : "none"))
                      : "none";
            nextSession.configOptions = [
                {
                    configId: "model",
                    name: "Model",
                    category: "model",
                    type: "select",
                    currentValue: currentVal,
                    options: [
                        ...(currentVal === "none"
                            ? [{ value: "none", name: "None (unselected)", description: null }]
                            : []),
                        ...catalogOptions,
                    ],
                },
                ...nextSession.configOptions,
            ];
        } else if (existingModelOptIdx >= 0 && catalogOptions.length > 0) {
            const existingOpt = nextSession.configOptions[existingModelOptIdx]!;
            if (SessionConfigOption.isSelect(existingOpt)) {
                const isGroupList = existingOpt.options.length > 0 && "options" in existingOpt.options[0]!;
                if (!isGroupList) {
                    const flatOpts = [
                        ...(existingOpt.options as ReadonlyArray<{
                            readonly value: string;
                            readonly name: string;
                            readonly description?: string | null;
                        }>),
                    ];
                    for (const cOpt of catalogOptions) {
                        if (!flatOpts.some((o) => o.value === cOpt.value)) {
                            flatOpts.push(cOpt);
                        }
                    }
                    nextSession.configOptions[existingModelOptIdx] = {
                        ...existingOpt,
                        options: flatOpts,
                    };
                }
            }
        }
        emitSessionBound(nextSession, {
            sessions: Array.isArray(sessionsRes?.sessions) ? sessionsRes.sessions : [],
            workspaces: Array.isArray(workspacesRes?.workspaces) ? workspacesRes.workspaces : [],
        });
        if (bindOpts?.initial) {
            for (const item of nextSession.items) {
                if (item.kind !== "notice") continue;
                const plurnkItem = (item.meta?.plurnk ?? undefined) as
                    | { notice?: { source?: string }; problem?: unknown }
                    | undefined;
                if (plurnkItem?.notice?.source === "engine:configuration" || plurnkItem?.problem !== undefined) {
                    handleSessionUpdate({
                        sessionUpdate: "notice",
                        severity: item.severity,
                        title: item.title,
                        ...(item.description !== undefined ? { description: item.description } : {}),
                        ...(item.meta !== undefined ? { _meta: item.meta } : {}),
                    });
                }
            }
        }
        return nextSession;
    };

    let session = await bindSession(options.workspace, currentSessionName, { initial: true });
    streams.stdout.write(`workspace: ${currentWorkspace}\n`);

    const bindingContext = () => ({
        sessionId: session.sessionId,
        workspace: currentWorkspace,
        session: currentSessionName,
    });

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

        const expandedLearn = expandLearnCommand(line);

        if (expandedLearn === null && line.startsWith("/")) {
            return await dispatchSlashCommand(line, {
                client,
                options,
                streams,
                hasCustomEventsStream: customStreams?.events !== undefined,
                pendingGates,
                getSession: () => session,
                setSession: (next) => {
                    session = next;
                },
                getWorkspace: () => currentWorkspace,
                setWorkspace: (next) => {
                    currentWorkspace = next;
                },
                getSessionName: () => currentSessionName,
                getProjectRoot: () => currentProjectRoot,
                getLifecycle: () => currentLifecycle,
                getYolo: () => currentYolo,
                setYolo: (next) => {
                    currentYolo = next;
                },
                clearForceReviewNextRun: () => {
                    forceReviewNextRun = false;
                },
                getStagedComposerText: () => stagedComposerText,
                setStagedComposerText: (next) => {
                    stagedComposerText = next;
                },
                adjustLocalMcpOAuth: (delta) => {
                    activeLocalMcpOAuth += delta;
                },
                bindSession,
                emitSessionBound,
                dispatchLine,
            });
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
            const stmt = `await plurnk.sh(${JSON.stringify({ command: shellCmd })});`;
            try {
                const res = await client.action<{
                    readonly results?: ReadonlyArray<{
                        readonly status?: number;
                        readonly content?: string;
                        readonly message?: string;
                    }>;
                }>("op.parse", { text: stmt }, bindingContext());
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

        const isCodeStatement =
            !rawLine.trimStart().startsWith(": ") &&
            /^await\s+plurnk\.[a-zA-Z0-9_]+\s*\(/u.test(line.trimStart());
        if (isCodeStatement) {
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
            void client
                .prompt(session.sessionId, [{ type: "text", text: injected }], {
                    plurnk: {
                        interactive: !options.auto,
                        tools: !options.auto ? ["question", "mcp_input_required"] : [],
                        descendants: true,
                        control: true,
                        ...(options.auto ? { envelope: { auto: true } } : {}),
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
        }

        let promptText = expandedLearn ?? line;
        if (expandedLearn === null && line.startsWith("?")) {
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
                    interactive: !options.auto,
                    tools: !options.auto ? ["question", "mcp_input_required"] : [],
                    descendants: true,
                    control: true,
                    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
                    ...(options.auto ? { envelope: { auto: true } } : {}),
                    ...(openPaths.length > 0 ? { openPaths } : {}),
                },
            })
            .catch((err) => {
                currentLifecycle = "failed";
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
    } finally {
        activeSession?.dispose();
        if (streams.stdin === process.stdin) {
            process.stdin.pause();
        }
        client.close();
    }
};

