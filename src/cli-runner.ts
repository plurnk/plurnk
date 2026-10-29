// Standard ACP v2 CLI runner for one-shot prompts, session connection, and interactive dispatch
// ({§cli-invocation}, {§cli-output-channels}, {§cli-subcommands}).

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
    CreateElicitationRequest,
    SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { AcpClient } from "./acp-client.ts";
import { AcpSession, contentBlockToText, type AcpMessageItem } from "./acp-session.ts";
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
    runCliCapabilities,
    runCliCompletion,
    runCliConfig,
    runCliDeleteSession,
    runCliFamily,
    runCliForkSession,
    runCliListSessions,
    runCliLogRead,
    runCliModels,
    runCliNewSession,
    runCliReadCoord,
    runCliResumeSession,
    runCliScript,
    runCliUpdate,
    runCliWorkspace,
} from "./cli-subcommands.ts";
import Credential from "./credential.ts";
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
    createCliElicitationHandler,
    createCliPermissionHandler,
    formatConfigOption,
    formatFamilyRows,
    formatProposalDiffPreview,
    formatServiceUpdateResult,
    matchesRuntimeAcceptance,
    openProcessStreams,
    runCliCapabilities,
    runCliCompletion,
    runCliConfig,
    runCliDeleteSession,
    runCliFamily,
    runCliForkSession,
    runCliListSessions,
    runCliLogRead,
    runCliModels,
    runCliNewSession,
    runCliReadCoord,
    runCliResumeSession,
    runCliScript,
    runCliUpdate,
    runCliWorkspace,
    runReplSession,
    runTuiViewport,
    type CliPermissionHandlerOptions,
    type ClientStreams,
};

const require = createRequire(import.meta.url);

export interface CliCommonOptions {
    readonly url: string;
    readonly explicitAcpUrl: boolean;
    readonly host: string;
    readonly port: number;
    readonly credential: Credential;
    readonly env: Record<string, string>;
    readonly cwd: string;
    readonly workspace?: string;
    readonly sessionId?: string;
    readonly tuiSession: string;
    readonly model?: string;
    readonly effort?: string;
    readonly persona?: string;
    readonly systemPrompt?: string;
    readonly projectRoot?: string;
    readonly workspaceSettings?: Record<string, unknown>;
    readonly sessionEnv?: Record<string, string>;
    readonly maxTurns?: number;
    readonly timeoutSec?: number;
    readonly autostart: boolean;
    readonly daemonTimeoutMs: number;
    readonly oauthTimeoutMs: number;
    readonly cancelGraceMs: number;
    readonly serviceBin?: string;
    readonly yolo: boolean;
    readonly auto: boolean;
    readonly bell: boolean;
    readonly json: boolean;
    readonly repl?: boolean;
    readonly statusStream: boolean;
    readonly shareFolder?: string;
    readonly previewLines: number;
    readonly historyEntries: number;
    readonly mermaidTimeoutMs: number;
    readonly color: string;
}

const isLoopbackHost = (host: string): boolean =>
    host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";

const resolveServiceCommand = (serviceBin?: string): { readonly file: string; readonly args: string[] } => {
    if (serviceBin !== undefined && serviceBin.trim().length > 0) {
        const bin = serviceBin.trim();
        if (bin.endsWith(".js") || bin.endsWith(".mjs") || bin.endsWith(".ts")) {
            return { file: process.execPath, args: [resolve(bin), "start"] };
        }
        return { file: bin, args: ["start"] };
    }
    const localBin = join(process.cwd(), "node_modules", ".bin", "plurnk-service");
    if (existsSync(localBin)) {
        return { file: localBin, args: ["start"] };
    }
    try {
        const pkgPath = require.resolve("@plurnk/plurnk-service/package.json");
        const serviceJs = join(dirname(pkgPath), "dist", "service.js");
        if (existsSync(serviceJs)) {
            return { file: process.execPath, args: [serviceJs, "start"] };
        }
    } catch {
        // fallback to PATH
    }
    return { file: "plurnk-service", args: ["start"] };
};

export class ClientCliError extends Error {
    readonly problem: {
        readonly type: string;
        readonly title: string;
        readonly status: number;
        readonly detail: string;
    };
    readonly exitCode: number;

    constructor(
        problem: {
            readonly type: string;
            readonly title: string;
            readonly status: number;
            readonly detail: string;
        },
        exitCode = 1,
    ) {
        super(problem.detail);
        this.name = "ClientCliError";
        this.problem = problem;
        this.exitCode = exitCode;
    }
}

export const ensureDaemonConnected = async (client: AcpClient, options: CliCommonOptions): Promise<void> => {
    try {
        await client.connect();
        return;
    } catch (firstErr) {
        if (!options.autostart || options.explicitAcpUrl || !isLoopbackHost(options.host)) {
            const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
            if (/fetch failed|ECONNREFUSED|connect/iu.test(msg)) {
                throw new ClientCliError(
                    {
                        type: "https://problems.plurnk.xyz/client/connection/refused",
                        title: "Connection refused",
                        status: 503,
                        detail: `Could not reach the configured service at ${options.url}. Start it with \`plurnk-service start\` or check PLURNK_ACP_URL.`,
                    },
                    1,
                );
            }
            throw firstErr;
        }
    }

    const stateHome = options.env.XDG_STATE_HOME || join(options.env.HOME || homedir(), ".local", "state");
    const logDir = join(stateHome, "plurnk");
    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, "service.log");
    const logFd = openSync(logPath, "a");

    try {
        const cmd = resolveServiceCommand(options.serviceBin);
        await new Promise<void>((resolveSpawn, rejectSpawn) => {
            const child = spawn(cmd.file, cmd.args, {
                cwd: options.cwd,
                env: {
                    ...process.env,
                    ...options.env,
                },
                detached: true,
                stdio: ["ignore", logFd, logFd],
            });
            child.once("error", (err: NodeJS.ErrnoException) => {
                if (err.code === "ENOENT") {
                    rejectSpawn(
                        new ClientCliError(
                            {
                                type: "https://problems.plurnk.xyz/client/daemon/not-installed",
                                title: "Service not installed",
                                status: 503,
                                detail: "Could not find `plurnk-service` to start the daemon automatically. Install `@plurnk/plurnk-service` (`npm install -g @plurnk/plurnk-service`).",
                            },
                            127,
                        ),
                    );
                    return;
                }
                rejectSpawn(err);
            });
            child.once("spawn", () => {
                child.unref();
                resolveSpawn();
            });
        });
    } finally {
        closeSync(logFd);
    }

    const deadline = Date.now() + options.daemonTimeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        try {
            await client.connect();
            return;
        } catch (err) {
            lastError = err;
        }
    }
    throw new ClientCliError(
        {
            type: "https://problems.plurnk.xyz/client/connection/refused",
            title: "Connection refused",
            status: 503,
            detail:
                lastError instanceof Error
                    ? `Could not reach the configured service at ${options.url} (${lastError.message}). Run \`plurnk-service start\`.`
                    : `Timed out after ${options.daemonTimeoutMs}ms waiting for plurnk-service to start.`,
        },
        1,
    );
};

const mergeSessionMeta = (
    prev: Record<string, unknown> | undefined,
    next: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
    if (next === undefined) return prev;
    const prevPlurnk = (prev?.plurnk ?? {}) as Record<string, unknown>;
    const nextPlurnk = (next.plurnk ?? {}) as Record<string, unknown>;
    const prevStatus = (prevPlurnk.status ?? {}) as Record<string, unknown>;
    const nextStatus = (nextPlurnk.status ?? {}) as Record<string, unknown>;
    return {
        ...(prev ?? {}),
        ...next,
        plurnk: {
            ...prevPlurnk,
            ...nextPlurnk,
            ...(Object.keys(prevStatus).length > 0 || Object.keys(nextStatus).length > 0
                ? { status: { ...prevStatus, ...nextStatus } }
                : {}),
        },
    };
};

const applyInitialConfig = async (
    client: AcpClient,
    session: AcpSession,
    options: CliCommonOptions,
): Promise<void> => {
    if (options.persona !== undefined && options.persona.length > 0) {
        const res = await client.setConfigOption(session.sessionId, "persona", options.persona);
        session.configOptions = [...res.configOptions];
        if (res._meta !== undefined && res._meta !== null) {
            session.meta = mergeSessionMeta(session.meta, res._meta as Record<string, unknown>);
        }
    }
    if (options.model !== undefined && options.model.length > 0) {
        const res = await client.setConfigOption(session.sessionId, "model", options.model);
        session.configOptions = [...res.configOptions];
        if (res._meta !== undefined && res._meta !== null) {
            session.meta = mergeSessionMeta(session.meta, res._meta as Record<string, unknown>);
        }
    }
    if (options.effort !== undefined && options.effort.length > 0) {
        const res = await client.setConfigOption(session.sessionId, "thought_level", options.effort);
        session.configOptions = [...res.configOptions];
        if (res._meta !== undefined && res._meta !== null) {
            session.meta = mergeSessionMeta(session.meta, res._meta as Record<string, unknown>);
        }
    }
    if (options.sessionEnv !== undefined && Object.keys(options.sessionEnv).length > 0) {
        for (const [alias, value] of Object.entries(options.sessionEnv)) {
            await client.action(
                "session.env.replace",
                { alias, definition: { value } },
                { sessionId: session.sessionId, workspace: options.workspace, session: options.sessionId },
            );
        }
    }
};

export const openCliSession = async (
    client: AcpClient,
    options: CliCommonOptions,
    onLiveUpdate?: (update: SessionUpdate, session: AcpSession) => void,
    replayHistory = false,
): Promise<AcpSession> => {
    let session: AcpSession | null = null;
    const bufferedNotifications: { readonly sessionId: string; readonly update: SessionUpdate }[] = [];

    const matchesSession = (incomingId: string, boundId: string): boolean =>
        incomingId === boundId ||
        (!boundId.includes("#") && incomingId.endsWith(`#${boundId}`));

    client.onSessionUpdate((notification) => {
        if (session === null) {
            bufferedNotifications.push(notification);
            return;
        }
        if (matchesSession(notification.sessionId, session.sessionId)) {
            session.applyUpdate(notification.update);
        }
    });

    const plurnkMeta: Record<string, unknown> = {
        create: true,
        ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
        ...(options.sessionId !== undefined ? { session: options.sessionId, name: options.sessionId } : {}),
        ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
        ...(options.workspaceSettings !== undefined ? { settings: options.workspaceSettings } : {}),
    };

    const systemPrompt =
        options.systemPrompt !== undefined && options.systemPrompt.length > 0
            ? {
                  mode: "append" as const,
                  content: [{ type: "text" as const, text: options.systemPrompt }],
              }
            : undefined;
    const created = await client.newSession(options.cwd, {
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
        _meta: { plurnk: plurnkMeta },
    });
    session = new AcpSession(created.sessionId, {
        configOptions: created.configOptions,
        meta: (created._meta ?? undefined) as Record<string, unknown> | undefined,
    });
    if (replayHistory) {
        const resumed = await client.resumeSession(created.sessionId, options.cwd, {
            replayFrom: { type: "start" },
            _meta: { plurnk: plurnkMeta },
        });
        if (resumed.configOptions && resumed.configOptions.length > 0) {
            session.configOptions = [...resumed.configOptions];
        }
        if (resumed._meta !== undefined && resumed._meta !== null) {
            const prevPlurnk = (session.meta?.plurnk ?? {}) as Record<string, unknown>;
            const nextPlurnk = ((resumed._meta as Record<string, unknown>).plurnk ?? {}) as Record<string, unknown>;
            session.meta = {
                ...(session.meta ?? {}),
                ...(resumed._meta as Record<string, unknown>),
                plurnk: { ...prevPlurnk, ...nextPlurnk },
            };
        }
    }

    for (const notification of bufferedNotifications) {
        if (matchesSession(notification.sessionId, session.sessionId)) {
            session.applyUpdate(notification.update);
        }
    }
    bufferedNotifications.length = 0;

    if (onLiveUpdate !== undefined) {
        session.onUpdate(onLiveUpdate);
    }

    await applyInitialConfig(client, session, options);
    return session;
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

        const replayCount = session.items.length;
        let timedOut = false;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

        const onSigInt = () => {
            void client.cancel(session.sessionId).catch(() => {});
        };
        process.once("SIGINT", onSigInt);

        const startedAt = Date.now();
        promptDispatched = true;
        session.state = "running";

        if (options.timeoutSec !== undefined && options.timeoutSec > 0) {
            timeoutHandle = setTimeout(() => {
                timedOut = true;
                void client.cancel(session.sessionId).catch(() => {});
            }, options.timeoutSec * 1000);
        }

        try {
            const promptMeta: Record<string, unknown> = {
                plurnk: {
                    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
                    ...(options.auto ? { envelope: { auto: true } } : {}),
                },
            };
            const promptRes = await client.prompt(session.sessionId, promptText, promptMeta);
            await Promise.race([
                turnIdlePromise,
                client.closed,
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
            const agentMessages = turnItems
                .filter((item): item is AcpMessageItem => item.kind === "agent_message")
                .map((item) => item.text);
            const finalAnswer = agentMessages.at(-1) ?? "";

            const plurnkSessionMeta = (session.meta?.plurnk ?? {}) as Record<string, unknown>;
            const terminalMeta = ((session.lastStateMeta?.plurnk as Record<string, unknown> | undefined)?.terminal ?? {}) as Record<string, unknown>;
            let loopId: number | null = typeof terminalMeta.loopId === "number" ? terminalMeta.loopId : null;

            const turnsById = new Map<number, Record<string, unknown>[]>();
            for (const item of turnItems) {
                const p = (item.meta?.plurnk ?? undefined) as Record<string, unknown> | undefined;
                if (loopId === null && typeof p?.loopId === "number") {
                    loopId = p.loopId;
                }
                if (p !== undefined && typeof p.op === "string") {
                    const turnId = typeof p.turnId === "number" ? p.turnId : 1;
                    let bucket = turnsById.get(turnId);
                    if (bucket === undefined) {
                        bucket = [];
                        turnsById.set(turnId, bucket);
                    }
                    bucket.push({
                        id: p.id,
                        op: p.op,
                        origin: p.origin ?? "model",
                        status: p.status ?? 200,
                        scope: p.scope ?? null,
                        coordinate: p.coordinate,
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

            const turnCount = typeof terminalMeta.turnCount === "number"
                ? terminalMeta.turnCount
                : turns.length > 0
                    ? turns.length + 1
                    : 1;

            const mergedUsage = !turnSettled
                ? null
                : terminalMeta.usage !== undefined && typeof terminalMeta.usage === "object" && terminalMeta.usage !== null
                  ? { ...(session.usage ?? {}), ...(terminalMeta.usage as Record<string, unknown>) }
                  : session.usage;

            const problemRecord =
                disconnectProblem ??
                ((terminalMeta.problem as Record<string, unknown> | undefined) ?? reportedProblem ?? null);

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

            if (!turnSettled) return 4;
            if (timedOut || stopReason === "cancelled" || finalStatus === 499) return 3;
            if (stopReason === "max_turn_requests" || finalStatus === 429) return 2;
            if (stopReason === "error" || stopReason === "refusal" || finalStatus >= 400) return 4;
            return 0;
        } finally {
            if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
            process.removeListener("SIGINT", onSigInt);
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
    return await runTuiViewport(options, customStreams);
};
