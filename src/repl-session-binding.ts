// REPL session binding, catalog autocomplete fetchers, `session_bound` telemetry emission,
// fork adoption, and permission/elicitation gate handlers
// ({§cli-repl-mode}, {§cli-workspaces-and-sessions}, {§cli-model-selection}, {§cli-inline-review}, {§cli-sessions-topology}).

import {
    CreateElicitationRequest,
    SessionConfigOption,
    type CreateElicitationResponse,
    type ForkSessionResponse,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { AcpClient } from "./acp-client.ts";
import { AcpSession } from "./acp-session.ts";
import { openCliSession, type CliCommonOptions } from "./cli-connection.ts";
import { matchesRuntimeAcceptance } from "./cli-permission.ts";
import {
    mintGateHash,
    writeEventJsonl,
    type ClientStreams,
} from "./repl-commands.ts";
import type { PendingGate } from "./repl-slash-commands.ts";

export interface ReplSessionHooks {
    readonly onProviderModelsFetcher?: (fetcher: (provider: string) => Promise<readonly string[]>) => void;
    readonly onModelSearchFetcher?: (fetcher: (query: string) => Promise<readonly string[]>) => void;
    readonly onModelEffortsFetcher?: (fetcher: (selector: string) => Promise<readonly string[] | null>) => void;
    readonly openBrowser?: (url: string) => Promise<void>;
}

export interface ReplRuntimeState {
    readonly options: CliCommonOptions;
    readonly streams: ClientStreams;
    readonly openBrowser?: (url: string) => Promise<void>;
    currentWorkspace: string;
    currentSessionName: string;
    currentProjectRoot: string;
    boundWorkspaceProjectRoot: string | null | undefined;
    currentYolo: boolean;
    forceReviewNextRun: boolean;
    gateSeq: number;
    currentLifecycle: string;
    stagedComposerText: string;
    activeSession: AcpSession | null;
    activeLocalMcpOAuth: number;
    readonly activeLocalOAuthControllers: Set<AbortController>;
    readonly pendingGates: Map<string, PendingGate>;
}

export interface ReplCatalogHelpers {
    readonly aliasTargetByName: Map<string, string>;
    recordCatalogItems(items: ReadonlyArray<Record<string, unknown>> | undefined): void;
}

export const createReplPermissionHandler =
    (state: ReplRuntimeState) =>
    async (request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> => {
        if (signal.aborted) {
            return { outcome: { outcome: "cancelled" } };
        }
        state.gateSeq += 1;
        const sessionId = state.activeSession?.sessionId ?? state.currentSessionName;
        const id = mintGateHash(sessionId, "permission", state.gateSeq);
        writeEventJsonl(state.streams.events, {
            ...request,
            sessionUpdate: "permission_request",
            id,
            sessionId,
        });

        if (
            (state.currentYolo || state.options.auto || matchesRuntimeAcceptance(request, state.options.env)) &&
            !state.forceReviewNextRun
        ) {
            const allowOption =
                request.options.find((opt) => opt.kind === "allow_once" || opt.kind === "allow_always") ??
                request.options[0];
            const outcome: RequestPermissionResponse["outcome"] =
                allowOption !== undefined
                    ? { outcome: "selected", optionId: allowOption.optionId }
                    : { outcome: "cancelled" };
            writeEventJsonl(state.streams.events, {
                sessionUpdate: "gate_resolved",
                id,
                outcome,
            });
            return { outcome };
        }

        return await new Promise<RequestPermissionResponse>((resolveGate) => {
            const finishGate = (res: RequestPermissionResponse, reason?: string): void => {
                if (!state.pendingGates.has(id)) return;
                state.pendingGates.delete(id);
                writeEventJsonl(state.streams.events, {
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
            state.pendingGates.set(id, {
                kind: "permission",
                id,
                sessionId,
                request,
                resolveGate: (res) => {
                    signal.removeEventListener("abort", onAbort);
                    finishGate(res);
                },
            });
        });
    };

export const createReplElicitationHandler =
    (state: ReplRuntimeState) =>
    async (request: CreateElicitationRequest, signal: AbortSignal): Promise<CreateElicitationResponse> => {
        if (signal.aborted) {
            return { action: "cancel" };
        }
        if (
            state.activeLocalMcpOAuth > 0 &&
            CreateElicitationRequest.isUrl(request) &&
            request.elicitationId.startsWith("mcp-oauth:")
        ) {
            return { action: "accept" };
        }
        state.gateSeq += 1;
        const sessionId = state.activeSession?.sessionId ?? state.currentSessionName;
        const id = mintGateHash(sessionId, "elicitation", state.gateSeq);
        writeEventJsonl(state.streams.events, {
            sessionUpdate: "elicitation_request",
            id,
            sessionId,
            mode: CreateElicitationRequest.isUrl(request) ? "url" : "form",
            message: request.message,
            ...(CreateElicitationRequest.isForm(request) ? { requestedSchema: request.requestedSchema } : {}),
            ...(CreateElicitationRequest.isUrl(request) ? { url: request.url } : {}),
            ...(request._meta !== undefined ? { _meta: request._meta } : {}),
        });

        if (state.options.auto) {
            const outcome: CreateElicitationResponse = { action: "decline" };
            writeEventJsonl(state.streams.events, {
                sessionUpdate: "gate_resolved",
                id,
                outcome,
            });
            return outcome;
        }

        return await new Promise<CreateElicitationResponse>((resolveGate) => {
            const finishGate = (res: CreateElicitationResponse, reason?: string): void => {
                if (!state.pendingGates.has(id)) return;
                state.pendingGates.delete(id);
                writeEventJsonl(state.streams.events, {
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
            state.pendingGates.set(id, {
                kind: "elicitation",
                id,
                sessionId,
                request,
                resolveGate: (res) => {
                    signal.removeEventListener("abort", onAbort);
                    finishGate(res);
                },
            });
        });
    };

export const createReplCatalogFetchers = (
    client: AcpClient,
    hooks?: ReplSessionHooks,
): ReplCatalogHelpers => {
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

    hooks?.onProviderModelsFetcher?.(fetchProviderModels);
    hooks?.onModelSearchFetcher?.(fetchSearchedModels);
    hooks?.onModelEffortsFetcher?.(async (selector: string) => {
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

    return { aliasTargetByName, recordCatalogItems };
};

export type EmitSessionBoundFn = (
    session: AcpSession,
    extra?: {
        readonly sessions?: ReadonlyArray<Record<string, unknown>>;
        readonly workspaces?: ReadonlyArray<Record<string, unknown>>;
    },
) => void;

export const bindReplSession = async (
    state: ReplRuntimeState,
    client: AcpClient,
    catalog: ReplCatalogHelpers,
    handleSessionUpdate: (update: SessionUpdate) => void,
    emitSessionBound: EmitSessionBoundFn,
    workspaceName: string | undefined,
    sessionName: string,
    bindOpts?: { readonly initial?: boolean; readonly isChild?: boolean },
): Promise<AcpSession> => {
    const { options } = state;
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
            if (s === state.activeSession) {
                handleSessionUpdate(update);
            }
        },
        options.historyEntries > 0,
    );
    if (state.activeSession !== null && state.activeSession !== nextSession) {
        const prevId = state.activeSession.sessionId;
        state.activeSession.dispose();
        if (prevId !== nextSession.sessionId) {
            client.untrackSession(prevId);
        }
    }
    state.activeSession = nextSession;
    const plurnk = (nextSession.meta?.plurnk ?? undefined) as Record<string, unknown> | undefined;
    const ws = (plurnk?.workspace ?? undefined) as Record<string, unknown> | undefined;
    const resolvedWorkspace =
        typeof ws?.name === "string" && ws.name.length > 0 ? ws.name : (workspaceName ?? state.currentWorkspace);
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
    catalog.recordCatalogItems(modelsRes?.items as ReadonlyArray<Record<string, unknown>> | undefined);
    if (Array.isArray(plurnk?.providers)) {
        for (const p of plurnk.providers as ReadonlyArray<Record<string, unknown>>) {
            if (
                typeof p?.alias === "string" &&
                typeof p?.provider === "string" &&
                typeof p?.model === "string"
            ) {
                catalog.aliasTargetByName.set(p.alias, `${p.provider}/${p.model}`);
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
    const boundModeOpt = nextSession.configOptions.find((o) => o.configId === "mode");
    if (boundModeOpt !== undefined && "currentValue" in boundModeOpt && typeof boundModeOpt.currentValue === "string") {
        state.currentYolo = boundModeOpt.currentValue === "accept";
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

export const adoptForkedReplSession = async (
    state: ReplRuntimeState,
    client: AcpClient,
    handleSessionUpdate: (update: SessionUpdate) => void,
    emitSessionBound: EmitSessionBoundFn,
    forked: ForkSessionResponse,
    requestedName?: string,
): Promise<AcpSession> => {
    const { options } = state;
    const forkedMeta = (forked._meta ?? undefined) as Record<string, unknown> | undefined;
    const forkedPlurnk = (forkedMeta?.plurnk ?? undefined) as Record<string, unknown> | undefined;
    const nextName =
        typeof forkedPlurnk?.sessionName === "string" && forkedPlurnk.sessionName.length > 0
            ? forkedPlurnk.sessionName
            : (requestedName ??
              (forked.sessionId.includes("#")
                  ? forked.sessionId.slice(forked.sessionId.indexOf("#") + 1)
                  : forked.sessionId));
    const prevSession = state.activeSession;
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
        if (s === state.activeSession) {
            handleSessionUpdate(update);
        }
    });
    client.trackSession(nextSession, {
        cwd: state.currentProjectRoot,
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
    state.activeSession = nextSession;
    state.currentSessionName = nextName;
    const [sessionsRes, workspacesRes] = await Promise.all([
        client
            .action<{ readonly sessions?: ReadonlyArray<Record<string, unknown>> }>(
                "workspace.sessions",
                {},
                {
                    sessionId: nextSession.sessionId,
                    workspace: state.currentWorkspace,
                    session: nextName,
                },
            )
            .catch(() => undefined),
        client
            .action<{ readonly workspaces?: ReadonlyArray<Record<string, unknown>> }>("workspace.list", {})
            .catch(() => undefined),
    ]);
    const boundModeOpt = nextSession.configOptions.find((o) => o.configId === "mode");
    if (boundModeOpt !== undefined && "currentValue" in boundModeOpt && typeof boundModeOpt.currentValue === "string") {
        state.currentYolo = boundModeOpt.currentValue === "accept";
    }
    emitSessionBound(nextSession, {
        sessions: Array.isArray(sessionsRes?.sessions) ? sessionsRes.sessions : [],
        workspaces: Array.isArray(workspacesRes?.workspaces) ? workspacesRes.workspaces : [],
    });
    return nextSession;
};
