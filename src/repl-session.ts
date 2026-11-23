// Five-stream contract ([stdin, stdout, stderr, events, reasoning], fd 0..4) and
// interactive REPL engine ({§cli-output-channels}, {§cli-repl-mode}).

import * as readline from "node:readline";
import {
    CreateElicitationRequest,
    SessionConfigOption,
    SessionUpdate,
    type CreateElicitationResponse,
    type ForkSessionResponse,
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
import { resolveLearnCommand } from "./commands.ts";
import {
    buildPromptBlocks,
    executeFamilyCommand,
    extractChronologicalHistory,
    extractOpenPaths,
    extractPromptHistory,
    formatExecResultLine,
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
    readonly onModelSearchFetcher?: (fetcher: (query: string) => Promise<readonly string[]>) => void;
    readonly onModelEffortsFetcher?: (fetcher: (selector: string) => Promise<readonly string[] | null>) => void;
}

export const runReplSession = async (
    options: CliCommonOptions,
    customStreams?: Partial<ClientStreams> & ReplSessionHooks,
): Promise<number> => {
    const streams = openProcessStreams(customStreams);
    let currentWorkspace = options.workspace ?? "default";
    let currentSessionName = options.sessionId ?? options.termSession ?? "session1";
    let currentProjectRoot = options.projectRoot ?? options.cwd;
    let boundWorkspaceProjectRoot: string | null | undefined = options.projectRoot;
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
            boundWorkspaceProjectRoot = ws.projectRoot;
        } else if (ws?.projectRoot === null) {
            boundWorkspaceProjectRoot = null;
        }
        if (typeof plurnk?.sessionName === "string" && plurnk.sessionName.length > 0) {
            currentSessionName = plurnk.sessionName;
        } else if (session.sessionId.includes("#")) {
            currentSessionName = session.sessionId.slice(session.sessionId.indexOf("#") + 1);
        } else if (session.sessionId.length > 0) {
            currentSessionName = session.sessionId;
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
            availableCommands: session.availableCommands,
            promptSuggestions: session.promptSuggestions,
            history,
            prompts,
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
                rawNotice?.kind === "turn_queued" ||
                rawNotice?.kind === "loop_status"
            ) {
                flushReasoningNewline();
            }
            if (rawNotice?.kind === "turn_queued") {
                currentLifecycle = "queued";
            } else if (rawNotice?.kind === "loop_status") {
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
        const effortsBySelector = new Map<string, readonly string[]>();
        const aliasTargetByName = new Map<string, string>();
        const recordCatalogItems = (items: ReadonlyArray<Record<string, unknown>> | undefined): void => {
            for (const item of items ?? []) {
                const selector = typeof item?.selector === "string" ? item.selector : "";
                const capabilities =
                    item?.capabilities !== null && typeof item?.capabilities === "object"
                        ? (item.capabilities as { readonly efforts?: unknown })
                        : undefined;
                if (selector.length > 0 && Array.isArray(capabilities?.efforts)) {
                    effortsBySelector.set(
                        selector,
                        capabilities.efforts.filter((e): e is string => typeof e === "string" && e.length > 0),
                    );
                }
            }
        };
        const fetchProviderModels = (provider: string): Promise<readonly string[]> => {
            const existing = providerModelsCache.get(provider);
            if (existing !== undefined) return existing;
            const promise = client
                .action<{ readonly items?: ReadonlyArray<Record<string, unknown>> }>("models.list", {
                    provider,
                    limit: 100,
                })
                .then((res) => {
                    recordCatalogItems(res.items);
                    return (res.items ?? [])
                        .map((item) => (typeof item?.selector === "string" ? item.selector : ""))
                        .filter(Boolean);
                })
                .catch(() => {
                    providerModelsCache.delete(provider);
                    return [];
                });
            providerModelsCache.set(provider, promise);
            return promise;
        };
        const searchModelsCache = new Map<string, Promise<readonly string[]>>();
        const fetchSearchedModels = (rawQuery: string): Promise<readonly string[]> => {
            const key = rawQuery.trim().toLowerCase();
            if (key.length === 0) return Promise.resolve([]);
            const existing = searchModelsCache.get(key);
            if (existing !== undefined) return existing;
            const promise = client
                .action<{ readonly items?: ReadonlyArray<Record<string, unknown>> }>("models.list", {
                    search: key,
                    availability: "configured",
                    limit: 100,
                })
                .then((res) => {
                    recordCatalogItems(res.items);
                    return (res.items ?? [])
                        .filter((item) => {
                            const readiness = item?.readiness as { readonly ready?: unknown } | undefined;
                            return readiness?.ready !== false;
                        })
                        .map((item) => (typeof item?.selector === "string" ? item.selector : ""))
                        .filter(Boolean);
                })
                .catch(() => {
                    searchModelsCache.delete(key);
                    return [];
                });
            if (searchModelsCache.size >= 64) {
                const oldestKey = searchModelsCache.keys().next().value;
                if (oldestKey !== undefined) searchModelsCache.delete(oldestKey);
            }
            searchModelsCache.set(key, promise);
            return promise;
        };
        customStreams?.onProviderModelsFetcher?.(fetchProviderModels);
        customStreams?.onModelSearchFetcher?.(fetchSearchedModels);
        customStreams?.onModelEffortsFetcher?.(async (selector: string) => {
            const resolved = aliasTargetByName.get(selector) ?? selector;
            if (effortsBySelector.has(resolved)) {
                return effortsBySelector.get(resolved) ?? null;
            }
            const slashIdx = resolved.indexOf("/");
            if (slashIdx > 0) {
                await fetchSearchedModels(resolved);
                if (effortsBySelector.has(resolved)) {
                    return effortsBySelector.get(resolved) ?? null;
                }
                await fetchProviderModels(resolved.slice(0, slashIdx));
                if (effortsBySelector.has(resolved)) {
                    return effortsBySelector.get(resolved) ?? null;
                }
            }
            return null;
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
                        readonly capabilities?: { readonly efforts?: readonly string[] };
                        readonly limits?: { readonly contextTokens?: number; readonly inputTokens?: number };
                        readonly readiness?: { readonly ready?: boolean };
                    }>;
                }>("models.list", { availability: "configured", limit: 100 })
                .catch(() => undefined),
        ]);
        recordCatalogItems(modelsRes?.items as ReadonlyArray<Record<string, unknown>> | undefined);
        if (Array.isArray(plurnk?.providers)) {
            for (const p of plurnk.providers as ReadonlyArray<Record<string, unknown>>) {
                if (
                    typeof p?.alias === "string" &&
                    typeof p?.provider === "string" &&
                    typeof p?.model === "string"
                ) {
                    aliasTargetByName.set(p.alias, `${p.provider}/${p.model}`);
                }
            }
        }
        const catalogOptions = (modelsRes?.items ?? [])
            .filter(
                (
                    m,
                ): m is {
                    readonly selector: string;
                    readonly modelName?: string;
                    readonly limits?: { readonly contextTokens?: number; readonly inputTokens?: number };
                    readonly readiness?: { readonly ready?: boolean };
                } => typeof m?.selector === "string" && m.selector.length > 0 && m.readiness?.ready !== false,
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

    const adoptForkedSession = async (
        forked: ForkSessionResponse,
        requestedName?: string,
    ): Promise<AcpSession> => {
        const forkedMeta = (forked._meta ?? undefined) as Record<string, unknown> | undefined;
        const forkedPlurnk = (forkedMeta?.plurnk ?? undefined) as Record<string, unknown> | undefined;
        const nextName =
            typeof forkedPlurnk?.sessionName === "string" && forkedPlurnk.sessionName.length > 0
                ? forkedPlurnk.sessionName
                : (requestedName ??
                  (forked.sessionId.includes("#")
                      ? forked.sessionId.slice(forked.sessionId.indexOf("#") + 1)
                      : forked.sessionId));
        const prevSession = activeSession;
        const prevPlurnk = (prevSession?.meta?.plurnk ?? {}) as Record<string, unknown>;
        const mergedMeta: Record<string, unknown> = {
            ...(prevSession?.meta ?? {}),
            ...(forkedMeta ?? {}),
            plurnk: {
                ...prevPlurnk,
                ...(forkedPlurnk ?? {}),
                sessionName: nextName,
            },
        };
        const attended = !options.auto;
        const nextSession = new AcpSession(forked.sessionId, {
            configOptions:
                forked.configOptions && forked.configOptions.length > 0
                    ? forked.configOptions
                    : prevSession?.configOptions,
            availableCommands: forked.availableCommands ?? prevSession?.availableCommands,
            meta: mergedMeta,
            interactive: attended,
            window: true,
        });
        if (options.historyEntries > 0 && prevSession !== null && nextSession.items.length === 0) {
            for (const item of prevSession.items) {
                nextSession.items.push(structuredClone(item));
            }
        }
        const matchesForkedSession = (incomingId: string, boundId: string): boolean => {
            if (incomingId === boundId) return true;
            if (/^\d+#/u.test(boundId)) return false;
            const boundSuffix = boundId.includes("#") ? boundId.slice(boundId.indexOf("#") + 1) : boundId;
            return incomingId.endsWith(`#${boundSuffix}`);
        };
        const offUpdate = client.onSessionUpdate((notification) => {
            if (matchesForkedSession(notification.sessionId, nextSession.sessionId)) {
                nextSession.applyUpdate(notification.update);
            }
        });
        const offDisconnect = client.onDisconnect(() => {
            nextSession.endActiveStream();
        });
        nextSession.onDispose(() => {
            offUpdate();
            offDisconnect();
        });
        nextSession.onUpdate((update, s) => {
            if (s === activeSession) {
                handleSessionUpdate(update);
            }
        });
        client.trackSession(nextSession, {
            cwd: currentProjectRoot,
            interactive: attended,
            window: true,
        });
        if (prevSession !== null && prevSession !== nextSession) {
            const prevId = prevSession.sessionId;
            prevSession.dispose();
            if (prevId !== nextSession.sessionId) {
                client.untrackSession(prevId);
            }
        }
        activeSession = nextSession;
        currentSessionName = nextName;
        const [sessionsRes, workspacesRes] = await Promise.all([
            client
                .action<{ readonly sessions?: ReadonlyArray<Record<string, unknown>> }>(
                    "workspace.sessions",
                    {},
                    {
                        sessionId: nextSession.sessionId,
                        workspace: currentWorkspace,
                        session: nextName,
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

        const resolvedLearn = resolveLearnCommand(
            line,
            boundWorkspaceProjectRoot === undefined ? undefined : { projectRoot: boundWorkspaceProjectRoot },
        );
        if (resolvedLearn !== null && !resolvedLearn.ok) {
            writeErrorJsonl(streams.stderr, {
                type: "https://problems.plurnk.xyz/client/usage",
                title: "Invalid /learn scope",
                status: 400,
                detail: resolvedLearn.error,
            });
            return "continue";
        }
        const expandedLearn = resolvedLearn?.ok === true ? resolvedLearn.prompt : null;

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
                adoptForkedSession,
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
            const stmt = `plurnk.sh(${JSON.stringify({ command: shellCmd })})`;
            try {
                const res = await client.action("op.exec", { text: stmt }, bindingContext());
                for (const r of res.results ?? []) {
                    const out = formatExecResultLine(r);
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

        const isMcpExpression =
            !rawLine.trimStart().startsWith(": ") &&
            /^(?:await\s+)?plurnk\.[a-zA-Z0-9_]+\s*\(/u.test(line.trimStart());
        if (isMcpExpression) {
            try {
                const res = await client.action("op.exec", { text: line }, bindingContext());
                for (const r of res.results ?? []) {
                    const out = formatExecResultLine(r);
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
                .prompt(session.sessionId, buildPromptBlocks(injected, session.availableCommands), {
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
        let isQuestionPrompt = false;
        if (expandedLearn === null && line.startsWith("?")) {
            forceReviewNextRun = true;
            isQuestionPrompt = true;
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
            .prompt(session.sessionId, buildPromptBlocks(promptText, session.availableCommands), {
                plurnk: {
                    interactive: !options.auto,
                    tools: !options.auto ? ["question", "mcp_input_required"] : [],
                    descendants: true,
                    control: true,
                    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
                    ...(options.auto ? { envelope: { auto: true } } : {}),
                    ...(isQuestionPrompt ? { proposalPolicy: "review" } : {}),
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

