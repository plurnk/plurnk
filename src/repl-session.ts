// Five-stream contract ([stdin, stdout, stderr, events, reasoning], fd 0..4) and
// interactive REPL engine ({§cli-output-channels}, {§cli-repl-mode}).

import { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { AcpClient } from "./acp-client.ts";
import { contentBlockToText, type AcpSession } from "./acp-session.ts";
import {
    ensureDaemonConnected,
    type CliCommonOptions,
} from "./cli-connection.ts";
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
import {
    createReplLineAccumulator,
    runReplInputLoop,
    type ReplLineAccumulator,
} from "./repl-input-reader.ts";
import {
    adoptForkedReplSession,
    bindReplSession,
    createReplCatalogFetchers,
    createReplElicitationHandler,
    createReplPermissionHandler,
    type ReplRuntimeState,
    type ReplSessionHooks,
} from "./repl-session-binding.ts";
import type { PendingGate } from "./repl-slash-commands.ts";

export {
    createReplLineAccumulator,
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
    type ReplLineAccumulator,
    type ReplSessionHooks,
};

export const runReplSession = async (
    options: CliCommonOptions,
    customStreams?: Partial<ClientStreams> & ReplSessionHooks,
): Promise<number> => {
    const streams = openProcessStreams(customStreams);
    const state: ReplRuntimeState = {
        options,
        streams,
        ...(customStreams?.openBrowser !== undefined ? { openBrowser: customStreams.openBrowser } : {}),
        currentWorkspace: options.workspace ?? "default",
        currentSessionName: options.sessionId ?? options.termSession ?? "session1",
        currentProjectRoot: options.projectRoot ?? options.cwd,
        boundWorkspaceProjectRoot: options.projectRoot,
        currentYolo: options.yolo,
        forceReviewNextRun: false,
        gateSeq: 0,
        currentLifecycle: "idle",
        stagedComposerText: "",
        activeSession: null,
        activeLocalMcpOAuth: 0,
        activeLocalOAuthControllers: new Set<AbortController>(),
        pendingGates: new Map<string, PendingGate>(),
    };

    let reasoningOpenOnLine = false;
    const flushReasoningNewline = (): void => {
        if (reasoningOpenOnLine) {
            streams.reasoning.write("\n");
            reasoningOpenOnLine = false;
        }
    };

    const emitSessionBound = (
        targetSession: AcpSession,
        extra?: {
            readonly sessions?: ReadonlyArray<Record<string, unknown>>;
            readonly workspaces?: ReadonlyArray<Record<string, unknown>>;
        },
    ): void => {
        const plurnk = (targetSession.meta?.plurnk ?? undefined) as Record<string, unknown> | undefined;
        const ws = (plurnk?.workspace ?? undefined) as Record<string, unknown> | undefined;
        if (typeof ws?.name === "string" && ws.name.length > 0) {
            state.currentWorkspace = ws.name;
        } else if (targetSession.sessionId.includes("#")) {
            const prefix = targetSession.sessionId.slice(0, targetSession.sessionId.indexOf("#"));
            if (prefix.length > 0 && !/^\d+$/u.test(prefix)) {
                state.currentWorkspace = prefix;
            }
        }
        if (typeof ws?.projectRoot === "string") {
            state.currentProjectRoot = ws.projectRoot;
            state.boundWorkspaceProjectRoot = ws.projectRoot;
        } else if (ws?.projectRoot === null) {
            state.boundWorkspaceProjectRoot = null;
        }
        if (typeof plurnk?.sessionName === "string" && plurnk.sessionName.length > 0) {
            state.currentSessionName = plurnk.sessionName;
        } else if (targetSession.sessionId.includes("#")) {
            state.currentSessionName = targetSession.sessionId.slice(targetSession.sessionId.indexOf("#") + 1);
        } else if (targetSession.sessionId.length > 0) {
            state.currentSessionName = targetSession.sessionId;
        }
        const chronologicalItems = extractChronologicalHistory(targetSession);
        const historyLimit = options.historyEntries > 0 ? options.historyEntries : 0;
        const prompts = extractPromptHistory(targetSession, historyLimit);
        const history = historyLimit > 0 ? chronologicalItems.slice(-historyLimit) : [];
        const mergedMeta =
            targetSession.usage?.meta !== undefined
                ? {
                      ...(targetSession.meta ?? {}),
                      ...targetSession.usage.meta,
                      plurnk: {
                          ...((targetSession.meta?.plurnk as Record<string, unknown> | undefined) ?? {}),
                          ...((targetSession.usage.meta.plurnk as Record<string, unknown> | undefined) ?? {}),
                      },
                  }
                : targetSession.meta;
        writeEventJsonl(streams.events, {
            sessionUpdate: "session_bound",
            sessionId: targetSession.sessionId,
            workspace: state.currentWorkspace,
            session: state.currentSessionName,
            cwd: state.currentProjectRoot,
            configOptions: targetSession.configOptions,
            availableCommands: targetSession.availableCommands,
            promptSuggestions: targetSession.promptSuggestions,
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
                    state.currentLifecycle = "parked";
                } else if (rawNotice.status === 102) {
                    state.currentLifecycle = "running";
                } else if (rawNotice.status === 100) {
                    state.currentLifecycle = "queued";
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
                    state.currentLifecycle = "parked";
                } else if (rawNotice.status === 102) {
                    state.currentLifecycle = "running";
                } else if (rawNotice.status === 100) {
                    state.currentLifecycle = "queued";
                }
            } else if (update.state === "running") {
                const metaLifecycle = (
                    update._meta as { plurnk?: { status?: { lifecycle?: unknown } } } | undefined
                )?.plurnk?.status?.lifecycle;
                state.currentLifecycle = metaLifecycle === "parked" ? "parked" : "running";
            } else if (update.state === "requires_action") {
                state.currentLifecycle = "parked";
            } else if (update.state === "idle") {
                flushReasoningNewline();
                state.forceReviewNextRun = false;
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
                state.currentLifecycle = status >= 400 ? (status === 499 ? "cancelled" : "failed") : "idle";
                if (termMeta?.problem !== undefined) {
                    writeErrorJsonl(streams.stderr, termMeta.problem);
                }
            }
            writeEventJsonl(streams.events, update);
            return;
        }

        if (SessionUpdate.isConfigOptionUpdate(update)) {
            const modeOpt = update.configOptions.find((o) => o.configId === "mode");
            if (modeOpt !== undefined && "currentValue" in modeOpt && typeof modeOpt.currentValue === "string") {
                state.currentYolo = modeOpt.currentValue === "accept";
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
                state.currentLifecycle = "queued";
            } else if (rawNotice?.kind === "loop_status") {
                if (rawNotice.status === 202) {
                    state.currentLifecycle = "parked";
                } else if (rawNotice.status === 102) {
                    state.currentLifecycle = "running";
                } else if (rawNotice.status === 100) {
                    state.currentLifecycle = "queued";
                }
            }
            writeEventJsonl(streams.events, update);
            return;
        }

        writeEventJsonl(streams.events, update);
    };

    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
        onDisconnect: () => {
            state.currentLifecycle = "idle";
            writeEventJsonl(streams.events, {
                sessionUpdate: "connection_lost",
            });
        },
        onPermissionRequest: createReplPermissionHandler(state),
        onElicitationRequest: createReplElicitationHandler(state),
    });

    try {
        await ensureDaemonConnected(client, options);
        const catalog = createReplCatalogFetchers(client, customStreams);
        const bindSession = (
            workspaceName: string | undefined,
            sessionName: string,
            bindOpts?: { readonly initial?: boolean; readonly isChild?: boolean },
        ) =>
            bindReplSession(
                state,
                client,
                catalog,
                handleSessionUpdate,
                emitSessionBound,
                workspaceName,
                sessionName,
                bindOpts,
            );

        let session = await bindSession(options.workspace, state.currentSessionName, { initial: true });
        streams.stdout.write(`workspace: ${state.currentWorkspace}\n`);

        return await runReplInputLoop({
            state,
            client,
            hasCustomEventsStream: customStreams?.events !== undefined,
            getSession: () => session,
            setSession: (next) => {
                session = next;
            },
            bindSession,
            adoptForkedSession: (forked, requestedName) =>
                adoptForkedReplSession(
                    state,
                    client,
                    handleSessionUpdate,
                    emitSessionBound,
                    forked,
                    requestedName,
                ),
            emitSessionBound: (targetSession) => emitSessionBound(targetSession),
            flushReasoningNewline,
        });
    } finally {
        state.activeSession?.dispose();
        if (streams.stdin === process.stdin) {
            process.stdin.pause();
        }
        client.close();
    }
};
