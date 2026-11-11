// Standard ACP v2 CLI runner for one-shot prompts, session connection, and interactive dispatch
// ({§cli-invocation}, {§cli-output-channels}, {§cli-subcommands}).

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
    CreateElicitationRequest,
    SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { AcpClient } from "./acp-client.ts";
import { contentBlockToText, type AcpMessageItem } from "./acp-session.ts";
import {
    ClientCliError,
    ensureDaemonConnected,
    openCliSession,
    resolveServiceCommand,
    type CliCommonOptions,
} from "./cli-connection.ts";
import {
    createCliElicitationHandler,
    createCliPermissionHandler,
    formatProposalDiffPreview,
    matchesRuntimeAcceptance,
    type CliPermissionHandlerOptions,
} from "./cli-permission.ts";
import {
    formatConfigOption,
    formatServiceUpdateResult,
    openWebHandoff,
    runCliCapabilities,
    runCliCompletion,
    runCliConfig,
    runCliDaemon,
    runCliDeleteSession,
    runCliFamily,
    runCliForkSession,
    runCliListSessions,
    runCliLogin,
    runCliLogout,
    runCliLogRead,
    runCliModels,
    runCliNewSession,
    runCliReadCoord,
    runCliResumeSession,
    runCliScript,
    runCliUpdate,
    runCliWeb,
    runCliWorkspace,
} from "./cli-subcommands.ts";
import { checkNeedsAutoOnboard, runCliOnboard } from "./onboard.ts";
import {
    formatFamilyRows,
    mintGateHash,
    openProcessStreams,
    writeErrorJsonl,
    writeEventJsonl,
    type ClientStreams,
} from "./repl-commands.ts";
import { runReplSession } from "./repl-session.ts";
import { runTuiViewport } from "./tui-viewport.ts";

export {
    checkNeedsAutoOnboard,
    ClientCliError,
    createCliElicitationHandler,
    createCliPermissionHandler,
    ensureDaemonConnected,
    formatConfigOption,
    formatFamilyRows,
    formatProposalDiffPreview,
    formatServiceUpdateResult,
    matchesRuntimeAcceptance,
    openCliSession,
    openProcessStreams,
    openWebHandoff,
    resolveServiceCommand,
    runCliCapabilities,
    runCliCompletion,
    runCliConfig,
    runCliDaemon,
    runCliDeleteSession,
    runCliFamily,
    runCliForkSession,
    runCliListSessions,
    runCliLogin,
    runCliLogout,
    runCliLogRead,
    runCliModels,
    runCliNewSession,
    runCliOnboard,
    runCliReadCoord,
    runCliResumeSession,
    runCliScript,
    runCliUpdate,
    runCliWeb,
    runCliWorkspace,
    runReplSession,
    runTuiViewport,
    type CliCommonOptions,
    type CliPermissionHandlerOptions,
    type ClientStreams,
};

export const runCliPrompt = async (
    promptText: string,
    options: CliCommonOptions,
    customStreams?: Partial<ClientStreams>,
): Promise<number> => {
    const streams = openProcessStreams(customStreams);
    const isQuestionPrompt = promptText.trimStart().startsWith("?");
    const effectiveYolo = isQuestionPrompt ? false : options.yolo;
    let gateSeq = 0;
    let activeSessionId = options.sessionId ?? "user";
    const basePermHandler = createCliPermissionHandler(effectiveYolo, {
        env: options.env,
        forceReview: isQuestionPrompt,
        auto: options.auto,
    });
    const baseElicitHandler = createCliElicitationHandler();

    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
        onPermissionRequest: async (request, signal) => {
            gateSeq += 1;
            const id = mintGateHash(activeSessionId, "permission", gateSeq);
            writeEventJsonl(streams.events, {
                ...request,
                sessionUpdate: "permission_request",
                id,
                sessionId: activeSessionId,
            });
            const res = await basePermHandler(request, signal);
            writeEventJsonl(streams.events, {
                sessionUpdate: "gate_resolved",
                id,
                outcome: res.outcome,
            });
            return res;
        },
        onElicitationRequest: async (request, signal) => {
            gateSeq += 1;
            const id = mintGateHash(activeSessionId, "elicitation", gateSeq);
            writeEventJsonl(streams.events, {
                sessionUpdate: "elicitation_request",
                id,
                sessionId: activeSessionId,
                mode: CreateElicitationRequest.isUrl(request) ? "url" : "form",
                message: request.message,
                ...(CreateElicitationRequest.isForm(request) ? { requestedSchema: request.requestedSchema } : {}),
                ...(CreateElicitationRequest.isUrl(request) ? { url: request.url } : {}),
                ...(request._meta !== undefined ? { _meta: request._meta } : {}),
            });
            const res = await baseElicitHandler(request, signal);
            writeEventJsonl(streams.events, {
                sessionUpdate: "gate_resolved",
                id,
                outcome: res,
            });
            return res;
        },
    });

    try {
        await ensureDaemonConnected(client, options);
        let promptDispatched = false;
        let reasoningOpenOnLine = false;
        let turnSettled = false;
        let reportedProblem: Record<string, unknown> | undefined;
        let turnIdleResolve: (() => void) | null = null;
        const turnIdlePromise = new Promise<void>((resolveIdle) => {
            turnIdleResolve = resolveIdle;
        });

        const flushReasoningNewline = (): void => {
            if (reasoningOpenOnLine) {
                streams.reasoning.write("\n");
                reasoningOpenOnLine = false;
            }
        };

        const session = await openCliSession(client, options, (update) => {
            if (!promptDispatched) return;

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
                return;
            }

            if (SessionUpdate.isToolCallUpdate(update)) {
                flushReasoningNewline();
                writeEventJsonl(streams.events, update);
                return;
            }

            if (SessionUpdate.isNotice(update)) {
                if (update.severity === "error") {
                    const noticeProblem = (
                        update._meta as
                            | {
                                  plurnk?: {
                                      problem?: Record<string, unknown>;
                                  };
                              }
                            | undefined
                    )?.plurnk?.problem;
                    reportedProblem =
                        noticeProblem ?? {
                            type: "https://problems.plurnk.xyz/service/notice",
                            title: update.title || "Error",
                            status: 500,
                            ...(typeof update.description === "string" && update.description.length > 0
                                ? { detail: update.description }
                                : {}),
                        };
                    if (!options.json) {
                        writeErrorJsonl(streams.stderr, update);
                    }
                }
                writeEventJsonl(streams.events, update);
                return;
            }

            if (SessionUpdate.isStateUpdate(update)) {
                if (update.state === "idle") {
                    turnSettled = true;
                    flushReasoningNewline();
                    const termProblem = (
                        update._meta as
                            | {
                                  plurnk?: {
                                      terminal?: {
                                          problem?: Record<string, unknown>;
                                      };
                                  };
                              }
                            | undefined
                    )?.plurnk?.terminal?.problem;
                    if (termProblem !== undefined) {
                        reportedProblem = termProblem;
                        if (!options.json) {
                            writeErrorJsonl(streams.stderr, termProblem);
                        }
                    }
                    writeEventJsonl(streams.events, update);
                    turnIdleResolve?.();
                    return;
                }
                writeEventJsonl(streams.events, update);
                return;
            }

            writeEventJsonl(streams.events, update);
        });

        activeSessionId = session.sessionId;
        const plurnkInitMeta = (session.meta?.plurnk ?? undefined) as Record<string, unknown> | undefined;
        const wsInit = (plurnkInitMeta?.workspace ?? undefined) as Record<string, unknown> | undefined;
        writeEventJsonl(streams.events, {
            sessionUpdate: "session_bound",
            sessionId: session.sessionId,
            workspace: typeof wsInit?.name === "string" ? wsInit.name : (options.workspace ?? "default"),
            session:
                typeof plurnkInitMeta?.sessionName === "string"
                    ? plurnkInitMeta.sessionName
                    : (options.sessionId ?? "user"),
            cwd: typeof wsInit?.projectRoot === "string" ? wsInit.projectRoot : (options.projectRoot ?? options.cwd),
            configOptions: session.configOptions,
            ...(session.meta !== undefined ? { _meta: session.meta } : {}),
        });
        for (const item of session.items) {
            if (item.kind !== "notice") continue;
            const plurnkItem = (item.meta?.plurnk ?? undefined) as
                | { notice?: { source?: string }; problem?: unknown }
                | undefined;
            if (plurnkItem?.notice?.source === "engine:configuration" || plurnkItem?.problem !== undefined) {
                const noticeUpdate: SessionUpdate = {
                    sessionUpdate: "notice",
                    severity: item.severity,
                    title: item.title,
                    ...(item.description !== undefined ? { description: item.description } : {}),
                    ...(item.meta !== undefined ? { _meta: item.meta } : {}),
                };
                if (item.severity === "error" && !options.json) {
                    writeErrorJsonl(streams.stderr, noticeUpdate);
                }
                writeEventJsonl(streams.events, noticeUpdate);
            }
        }

        const replayCount = session.items.length;
        let timedOut = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let cancelGraceTimer: ReturnType<typeof setTimeout> | undefined;
        let interruptedExitCode: 130 | 143 | null = null;
        let resolveCancelGrace!: () => void;
        const cancelGracePromise = new Promise<void>((r) => {
            resolveCancelGrace = r;
        });

        const armCancelGrace = () => {
            if (cancelGraceTimer === undefined && options.cancelGraceMs > 0) {
                cancelGraceTimer = setTimeout(() => {
                    resolveCancelGrace();
                }, options.cancelGraceMs);
            }
        };

        const onSignal = (code: 130 | 143) => {
            if (interruptedExitCode !== null) {
                resolveCancelGrace();
                return;
            }
            interruptedExitCode = code;
            void client.cancel(session.sessionId).catch(() => {});
            armCancelGrace();
        };
        const onSigInt = () => onSignal(130);
        const onSigTerm = () => onSignal(143);
        process.on("SIGINT", onSigInt);
        process.on("SIGTERM", onSigTerm);

        const startedAt = Date.now();
        promptDispatched = true;
        session.state = "running";

        if (options.timeoutSec !== undefined && options.timeoutSec > 0) {
            timeoutHandle = setTimeout(() => {
                timedOut = true;
                void client.cancel(session.sessionId).catch(() => {});
                armCancelGrace();
            }, options.timeoutSec * 1000);
        }

        try {
            const promptMeta: Record<string, unknown> = {
                plurnk: {
                    interactive: false,
                    tools: [],
                    descendants: true,
                    control: true,
                    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
                    ...(options.auto ? { envelope: { auto: true } } : {}),
                },
            };
            const promptRes = await client.prompt(session.sessionId, promptText, promptMeta);
            await Promise.race([
                turnIdlePromise,
                client.closed,
                cancelGracePromise,
            ]);
            flushReasoningNewline();

            if (options.shareFolder !== undefined && options.shareFolder.length > 0) {
                const resolvedShare = options.shareFolder.startsWith("~/")
                    ? join(options.env.HOME || homedir(), options.shareFolder.slice(2))
                    : resolve(options.cwd, options.shareFolder);
                await client.action(
                    "workspace.share",
                    { folder: resolvedShare },
                    { sessionId: session.sessionId, workspace: options.workspace },
                ).catch(() => undefined);
            }

            const disconnectProblem: Record<string, unknown> | undefined = !turnSettled
                ? (reportedProblem ?? {
                      type: "https://problems.plurnk.xyz/client/transport/terminal-missing",
                      title: "Incomplete stream",
                      status: 502,
                      detail: "The ACP stream closed before the turn reached an idle state.",
                  })
                : undefined;
            if (!turnSettled && !options.json && reportedProblem === undefined && disconnectProblem !== undefined) {
                writeErrorJsonl(streams.stderr, disconnectProblem);
            }

            const stopReason = turnSettled ? (session.stopReason ?? "end_turn") : "error";
            const turnItems = session.items.slice(replayCount);
            // {§cli-markdown-projection} — Outside text never enters CLI stdout or `--json` response.
            const agentMessages = turnItems
                .filter((item): item is AcpMessageItem => {
                    if (item.kind !== "agent_message") return false;
                    const p = (item.meta?.plurnk ?? undefined) as Record<string, unknown> | undefined;
                    if (typeof item.id === "string" && item.id.startsWith("outside-")) return false;
                    if (p?.op === "outside-" || p?.outside !== undefined) return false;
                    return true;
                })
                .map((item) => item.text);
            const finalAnswer = agentMessages.at(-1) ?? "";

            const plurnkSessionMeta = (session.meta?.plurnk ?? {}) as Record<string, unknown>;
            const terminalMeta = ((session.lastStateMeta?.plurnk as Record<string, unknown> | undefined)?.terminal ?? {}) as Record<string, unknown>;
            let loopId: number | null = typeof terminalMeta.loopId === "number" ? terminalMeta.loopId : null;

            const turnsById = new Map<number, Record<string, unknown>[]>();
            for (const item of turnItems) {
                const p = (item.meta?.plurnk ?? undefined) as Record<string, unknown> | undefined;
                const rawCoord =
                    typeof p?.coordinate === "string"
                        ? p.coordinate
                        : item.kind === "tool_call"
                          ? item.toolCallId
                          : item.kind === "agent_message" || item.kind === "user_message" || item.kind === "agent_thought"
                            ? item.id
                            : undefined;
                const coordMatch =
                    typeof rawCoord === "string" ? /^(\d+)\/(\d+)\/(\d+)$/u.exec(rawCoord) : null;
                if (loopId === null) {
                    if (typeof p?.loopId === "number") {
                        loopId = p.loopId;
                    } else if (coordMatch !== null) {
                        loopId = Number.parseInt(coordMatch[1]!, 10);
                    }
                }
                const opName =
                    typeof p?.op === "string"
                        ? p.op
                        : item.kind === "tool_call" && typeof item.name === "string"
                          ? item.name
                          : undefined;
                if (opName !== undefined && (p !== undefined || item.kind === "tool_call")) {
                    const turnId =
                        typeof p?.turnId === "number"
                            ? p.turnId
                            : coordMatch !== null
                              ? Number.parseInt(coordMatch[2]!, 10)
                              : 1;
                    let bucket = turnsById.get(turnId);
                    if (bucket === undefined) {
                        bucket = [];
                        turnsById.set(turnId, bucket);
                    }
                    bucket.push({
                        id: p?.id ?? (coordMatch !== null ? Number.parseInt(coordMatch[3]!, 10) : undefined),
                        op: opName,
                        origin: p?.origin ?? "model",
                        status:
                            typeof p?.status === "number"
                                ? p.status
                                : item.kind === "tool_call" && item.status === "failed"
                                  ? 500
                                  : 200,
                        scope: p?.scope ?? null,
                        coordinate: rawCoord,
                    });
                }
            }
            const turns = [...turnsById.entries()].map(([turnId, ops]) => ({ turnId, ops }));

            const finalStatus = !turnSettled
                ? typeof disconnectProblem?.status === "number"
                    ? disconnectProblem.status
                    : 502
                : typeof terminalMeta.status === "number"
                  ? terminalMeta.status
                  : timedOut || stopReason === "cancelled"
                    ? 499
                    : stopReason === "max_turn_requests"
                      ? 429
                      : stopReason === "refusal" || stopReason === "error"
                        ? 500
                        : 200;

            const turnCount = !turnSettled
                ? null
                : typeof terminalMeta.turnCount === "number"
                  ? terminalMeta.turnCount
                  : turns.length > 0
                    ? turns.length + 1
                    : 1;

            const mergedUsage = !turnSettled
                ? null
                : terminalMeta.usage !== undefined && typeof terminalMeta.usage === "object" && terminalMeta.usage !== null
                  ? { ...(session.usage ?? {}), ...(terminalMeta.usage as Record<string, unknown>) }
                  : session.usage;

            const terminalProblem = terminalMeta.problem as Record<string, unknown> | undefined;
            const matchingReportedProblem =
                reportedProblem !== undefined &&
                !timedOut &&
                stopReason !== "cancelled" &&
                (typeof reportedProblem.status !== "number" || reportedProblem.status === finalStatus)
                    ? reportedProblem
                    : undefined;
            const problemRecord =
                disconnectProblem ??
                (finalStatus < 400
                    ? null
                    : (terminalProblem ??
                        matchingReportedProblem ?? {
                            type:
                                timedOut || stopReason === "cancelled" || finalStatus === 499
                                    ? "https://problems.plurnk.xyz/client/cancelled"
                                    : stopReason === "max_turn_requests" || finalStatus === 429
                                      ? "https://problems.plurnk.xyz/engine/rail/max-turns"
                                      : "https://problems.plurnk.xyz/client/prompt-failed",
                            title: timedOut
                                ? "Prompt timed out"
                                : stopReason === "cancelled" || finalStatus === 499
                                  ? "Prompt cancelled"
                                  : stopReason === "max_turn_requests" || finalStatus === 429
                                    ? "Turn limit reached"
                                    : "Prompt failed",
                            status: finalStatus,
                            detail: timedOut
                                ? "The prompt exceeded the configured client timeout."
                                : `The turn ended with stop reason '${stopReason}' (status ${finalStatus}).`,
                        }));

            if (options.json) {
                const payload = {
                    schemaVersion: 6,
                    sessionId: session.sessionId,
                    loopId,
                    messageId: promptRes.messageId,
                    stopReason,
                    state: session.state,
                    finalStatus,
                    timedOut,
                    turnCount,
                    wallMs: Date.now() - startedAt,
                    workspace: plurnkSessionMeta.workspace ?? { name: options.workspace ?? "default" },
                    session: plurnkSessionMeta.session ?? { name: options.sessionId ?? "user" },
                    turns,
                    response: finalAnswer,
                    usage: mergedUsage,
                    problem: problemRecord,
                    configOptions: session.configOptions,
                };
                streams.stdout.write(`${JSON.stringify(payload)}\n`);
            } else if (finalAnswer.length > 0) {
                streams.stdout.write(finalAnswer.endsWith("\n") ? finalAnswer : `${finalAnswer}\n`);
            }

            if (interruptedExitCode !== null) return interruptedExitCode;
            if (!turnSettled) return 4;
            if (timedOut || stopReason === "cancelled" || finalStatus === 499) return 3;
            if (stopReason === "max_turn_requests" || finalStatus === 429) return 2;
            if (stopReason === "error" || stopReason === "refusal" || finalStatus >= 400) return 4;
            return 0;
        } finally {
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
            if (cancelGraceTimer !== undefined) clearTimeout(cancelGraceTimer);
            process.removeListener("SIGINT", onSigInt);
            process.removeListener("SIGTERM", onSigTerm);
        }
    } finally {
        client.close();
    }
};

export const runInteractiveSession = async (
    options: CliCommonOptions,
    customStreams?: Partial<ClientStreams>,
): Promise<number> => {
    if (options.repl) {
        return await runReplSession(options, customStreams);
    }
    if (customStreams === undefined && (await checkNeedsAutoOnboard(options))) {
        await runCliOnboard(options);
    }
    return await runTuiViewport(options, customStreams);
};
