// Standard ACP v2 CLI runner for one-shot prompts, session operations, and PLURNK subcommands.

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import {
    CreateElicitationRequest,
    ElicitationPropertySchema,
    SessionConfigOption,
    SessionUpdate,
    ToolCallContent,
    type CreateElicitationResponse,
    type ElicitationContentValue,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { AcpClient } from "./acp-client.ts";
import { AcpSession, contentBlockToText, type AcpMessageItem } from "./acp-session.ts";
import Credential from "./credential.ts";
import {
    mintGateHash,
    openProcessStreams,
    runReplSession,
    runTuiViewport,
    writeErrorJsonl,
    writeEventJsonl,
    type ClientStreams,
} from "./repl-session.ts";

export { openProcessStreams, runReplSession, runTuiViewport, type ClientStreams };

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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

export const ensureDaemonConnected = async (client: AcpClient, options: CliCommonOptions): Promise<void> => {
    try {
        await client.connect();
        return;
    } catch (firstErr) {
        if (!options.autostart || options.explicitAcpUrl || !isLoopbackHost(options.host)) {
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
        const child = spawn(cmd.file, cmd.args, {
            cwd: options.cwd,
            env: {
                ...process.env,
                ...options.env,
            },
            detached: true,
            stdio: ["ignore", logFd, logFd],
        });
        child.unref();
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
    throw lastError instanceof Error
        ? lastError
        : new Error(`Timed out after ${options.daemonTimeoutMs}ms waiting for plurnk-service to start.`);
};

const promptLineWithAbort = (question: string, signal: AbortSignal): Promise<string | null> =>
    new Promise((resolvePrompt) => {
        if (signal.aborted || !process.stdin.isTTY) {
            resolvePrompt(null);
            return;
        }
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stderr,
        });
        const onAbort = () => {
            rl.close();
            resolvePrompt(null);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        rl.question(question, (answer) => {
            signal.removeEventListener("abort", onAbort);
            rl.close();
            resolvePrompt(answer.trim());
        });
    });

export const createCliPermissionHandler = (yolo: boolean) =>
    async (
        request: RequestPermissionRequest,
        signal: AbortSignal,
    ): Promise<RequestPermissionResponse> => {
        if (signal.aborted) {
            return { outcome: { outcome: "cancelled" } };
        }
        if (yolo) {
            const allowOption = request.options.find(
                (opt) => opt.kind === "allow_once" || opt.kind === "allow_always",
            ) ?? request.options[0];
            if (allowOption !== undefined) {
                return {
                    outcome: {
                        outcome: "selected",
                        optionId: allowOption.optionId,
                    },
                };
            }
            return { outcome: { outcome: "cancelled" } };
        }

        if (!process.stdin.isTTY) {
            const rejectOption = request.options.find(
                (opt) => opt.kind === "reject_once" || opt.kind === "reject_always",
            );
            if (rejectOption !== undefined) {
                return {
                    outcome: {
                        outcome: "selected",
                        optionId: rejectOption.optionId,
                    },
                };
            }
            return { outcome: { outcome: "cancelled" } };
        }

        process.stderr.write(`\n[permission] ${request.title}\n`);
        if (request.description) {
            process.stderr.write(`${request.description}\n`);
        }
        for (let i = 0; i < request.options.length; i += 1) {
            const opt = request.options[i]!;
            process.stderr.write(`  ${String(i + 1)}) ${opt.name} (${opt.optionId})\n`);
        }
        const answer = await promptLineWithAbort("Select option [1]: ", signal);
        if (answer === null || signal.aborted) {
            return { outcome: { outcome: "cancelled" } };
        }
        const idx = answer === "" ? 0 : Number.parseInt(answer, 10) - 1;
        const chosen = request.options[idx] ?? request.options[0];
        if (chosen === undefined) {
            return { outcome: { outcome: "cancelled" } };
        }
        return {
            outcome: {
                outcome: "selected",
                optionId: chosen.optionId,
            },
        };
    };

export const createCliElicitationHandler = () =>
    async (
        request: CreateElicitationRequest,
        signal: AbortSignal,
    ): Promise<CreateElicitationResponse> => {
        if (signal.aborted) {
            return { action: "cancel" };
        }
        if (!process.stdin.isTTY) {
            return { action: "decline" };
        }
        if (CreateElicitationRequest.isUrl(request)) {
            process.stderr.write(`\n[elicitation] ${request.message}\n  URL: ${request.url}\n`);
            const answer = await promptLineWithAbort("  Open/Confirm [y/N]: ", signal);
            if (answer === null || signal.aborted) {
                return { action: "cancel" };
            }
            const normalized = answer.trim().toLowerCase();
            return normalized === "y" || normalized === "yes"
                ? { action: "accept" }
                : { action: "decline" };
        }
        if (!CreateElicitationRequest.isForm(request)) {
            return { action: "decline" };
        }

        process.stderr.write(`\n[elicitation] ${request.message}\n`);
        const content: Record<string, ElicitationContentValue> = {};
        const properties = request.requestedSchema.properties ?? {};
        for (const [key, prop] of Object.entries(properties)) {
            const label =
                (ElicitationPropertySchema.isString(prop) ||
                    ElicitationPropertySchema.isNumber(prop) ||
                    ElicitationPropertySchema.isInteger(prop) ||
                    ElicitationPropertySchema.isBoolean(prop) ||
                    ElicitationPropertySchema.isArray(prop)) &&
                typeof prop.title === "string" &&
                prop.title.length > 0
                    ? prop.title
                    : key;
            const answer = await promptLineWithAbort(`  ${label}: `, signal);
            if (answer === null || signal.aborted) {
                return { action: "cancel" };
            }
            if (ElicitationPropertySchema.isBoolean(prop)) {
                content[key] = answer === "true" || answer === "1" || answer === "yes" || answer === "y";
            } else if (
                ElicitationPropertySchema.isNumber(prop) ||
                ElicitationPropertySchema.isInteger(prop)
            ) {
                content[key] = Number(answer);
            } else {
                content[key] = answer;
            }
        }
        return {
            action: "accept",
            content,
        };
    };

const applyInitialConfig = async (
    client: AcpClient,
    session: AcpSession,
    options: CliCommonOptions,
): Promise<void> => {
    if (options.model !== undefined && options.model.length > 0) {
        const res = await client.setConfigOption(session.sessionId, "model", options.model);
        session.configOptions = [...res.configOptions];
    }
    if (options.effort !== undefined && options.effort.length > 0) {
        const res = await client.setConfigOption(session.sessionId, "thought_level", options.effort);
        session.configOptions = [...res.configOptions];
    }
    if (options.sessionEnv !== undefined && Object.keys(options.sessionEnv).length > 0) {
        await client.action(
            "session.env.replace",
            { entries: options.sessionEnv },
            { sessionId: session.sessionId, workspace: options.workspace, session: options.sessionId },
        ).catch(() => undefined);
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

    const created = await client.newSession(options.cwd, {
        _meta: { plurnk: plurnkMeta },
    });
    session = new AcpSession(created.sessionId, {
        configOptions: created.configOptions,
        meta: (created._meta ?? undefined) as Record<string, unknown> | undefined,
    });
    if (replayHistory) {
        const resumed = await client.resumeSession(created.sessionId, options.cwd, {
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
    const basePermHandler = createCliPermissionHandler(effectiveYolo);
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

    await ensureDaemonConnected(client, options);

    try {
        let promptDispatched = false;
        let reasoningOpenOnLine = false;
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
                if (!options.json && update.severity === "error") {
                    writeErrorJsonl(streams.stderr, update);
                }
                writeEventJsonl(streams.events, update);
                return;
            }

            if (SessionUpdate.isStateUpdate(update)) {
                if (update.state === "idle") {
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
                    if (!options.json && termProblem !== undefined) {
                        writeErrorJsonl(streams.stderr, termProblem);
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

            const stopReason = session.stopReason ?? "end_turn";
            const turnItems = session.items.slice(replayCount);
            const agentMessages = turnItems
                .filter((item): item is AcpMessageItem => item.kind === "agent_message")
                .map((item) => item.text);
            const finalAnswer = agentMessages.at(-1) ?? "";

            const plurnkSessionMeta = (session.meta?.plurnk ?? {}) as Record<string, unknown>;
            const terminalMeta = ((session.lastStateMeta?.plurnk as Record<string, unknown> | undefined)?.terminal ?? {}) as Record<string, unknown>;

            const turnsById = new Map<number, Record<string, unknown>[]>();
            for (const item of turnItems) {
                const p = (item.meta?.plurnk ?? undefined) as Record<string, unknown> | undefined;
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

            const finalStatus = typeof terminalMeta.status === "number"
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
                : typeof terminalMeta.turns === "number"
                    ? terminalMeta.turns
                    : turns.length > 0
                        ? turns.length + 1
                        : 1;

            const mergedUsage = terminalMeta.usage !== undefined && typeof terminalMeta.usage === "object" && terminalMeta.usage !== null
                ? { ...(session.usage ?? {}), ...(terminalMeta.usage as Record<string, unknown>) }
                : session.usage;

            if (options.json) {
                const payload = {
                    sessionId: session.sessionId,
                    messageId: promptRes.messageId,
                    stopReason,
                    state: session.state,
                    finalStatus,
                    timedOut,
                    turnCount,
                    workspace: plurnkSessionMeta.workspace ?? { name: options.workspace ?? "default" },
                    session: plurnkSessionMeta.session ?? { name: options.sessionId ?? "user" },
                    turns,
                    response: finalAnswer,
                    usage: mergedUsage,
                    configOptions: session.configOptions,
                    items: turnItems,
                };
                streams.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
            } else if (finalAnswer.length > 0) {
                streams.stdout.write(finalAnswer.endsWith("\n") ? finalAnswer : `${finalAnswer}\n`);
            }

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

export const runCliListSessions = async (options: CliCommonOptions): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    await ensureDaemonConnected(client, options);
    try {
        const res = await client.listSessions(options.cwd);
        if (options.json) {
            process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
            return 0;
        }
        if (res.sessions.length === 0) {
            process.stdout.write("No sessions.\n");
            return 0;
        }
        for (const s of res.sessions) {
            const title = s.title ? `  ${s.title}` : "";
            const updated = s.updatedAt ? `  (${s.updatedAt})` : "";
            process.stdout.write(`${s.sessionId}\t${s.cwd}${title}${updated}\n`);
        }
        return 0;
    } finally {
        client.close();
    }
};

export const runCliNewSession = async (options: CliCommonOptions): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    await ensureDaemonConnected(client, options);
    try {
        const session = await openCliSession(client, { ...options, sessionId: undefined });
        if (options.json) {
            process.stdout.write(
                `${JSON.stringify(
                    {
                        sessionId: session.sessionId,
                        configOptions: session.configOptions,
                    },
                    null,
                    2,
                )}\n`,
            );
        } else {
            process.stdout.write(`${session.sessionId}\n`);
        }
        return 0;
    } finally {
        client.close();
    }
};

export const runCliResumeSession = async (
    sessionId: string,
    options: CliCommonOptions,
): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    await ensureDaemonConnected(client, options);
    try {
        const session = await openCliSession(client, { ...options, sessionId }, undefined, true);
        if (options.json) {
            process.stdout.write(
                `${JSON.stringify(
                    {
                        sessionId: session.sessionId,
                        state: session.state,
                        stopReason: session.stopReason,
                        configOptions: session.configOptions,
                        usage: session.usage,
                        items: session.items,
                    },
                    null,
                    2,
                )}\n`,
            );
            return 0;
        }
        for (const item of session.items) {
            switch (item.kind) {
                case "user_message":
                    process.stdout.write(`> ${item.text}\n`);
                    break;
                case "agent_thought":
                    process.stdout.write(`[thought] ${item.text}\n`);
                    break;
                case "agent_message":
                    process.stdout.write(`${item.text}\n`);
                    break;
                case "tool_call": {
                    const label = item.title ?? item.name ?? item.toolCallId;
                    process.stdout.write(`[tool:${item.status ?? "pending"}] ${label}\n`);
                    for (const c of item.content) {
                        if (ToolCallContent.isContent(c)) {
                            process.stdout.write(`  ${contentBlockToText(c.content)}\n`);
                        } else if (ToolCallContent.isDiff(c)) {
                            process.stdout.write(`  [diff]\n`);
                        }
                    }
                    break;
                }
                case "terminal":
                    process.stdout.write(`[terminal] ${item.command ?? item.terminalId}\n`);
                    if (item.outputText.length > 0) {
                        process.stdout.write(
                            item.outputText.endsWith("\n") ? item.outputText : `${item.outputText}\n`,
                        );
                    }
                    break;
                case "notice":
                    process.stdout.write(
                        `[${item.severity}] ${item.title}${item.description ? `: ${item.description}` : ""}\n`,
                    );
                    break;
                default:
                    break;
            }
        }
        return 0;
    } finally {
        client.close();
    }
};

export const runCliForkSession = async (
    sessionId: string,
    options: CliCommonOptions,
): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    await ensureDaemonConnected(client, options);
    try {
        const res = await client.forkSession(sessionId, options.cwd);
        if (options.json) {
            process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
        } else {
            process.stdout.write(`${res.sessionId}\n`);
        }
        return 0;
    } finally {
        client.close();
    }
};

export const runCliDeleteSession = async (
    sessionId: string,
    options: CliCommonOptions,
): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    await ensureDaemonConnected(client, options);
    try {
        await client.deleteSession(sessionId);
        if (options.json) {
            process.stdout.write(`${JSON.stringify({ deleted: sessionId }, null, 2)}\n`);
        } else {
            process.stdout.write(`Deleted ${sessionId}\n`);
        }
        return 0;
    } finally {
        client.close();
    }
};

export const formatConfigOption = (opt: SessionConfigOption): string => {
    if (SessionConfigOption.isBoolean(opt)) {
        return `${opt.configId} (${opt.name}): ${String(opt.currentValue)}`;
    }
    if (SessionConfigOption.isSelect(opt)) {
        const choices: string[] = [];
        for (const entry of opt.options) {
            if ("options" in entry) {
                for (const sub of entry.options) {
                    choices.push(sub.value === opt.currentValue ? `*${sub.value}` : sub.value);
                }
            } else {
                choices.push(entry.value === opt.currentValue ? `*${entry.value}` : entry.value);
            }
        }
        return `${opt.configId} (${opt.name}): ${opt.currentValue} [${choices.join(", ")}]`;
    }
    return `${opt.configId} (${opt.name})`;
};

export const runCliConfig = async (
    configId: string | undefined,
    value: string | undefined,
    options: CliCommonOptions,
): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    await ensureDaemonConnected(client, options);
    try {
        const session = await openCliSession(client, options);
        if (configId !== undefined && value !== undefined) {
            const existing = session.configOptions.find((o) => o.configId === configId);
            const parsedValue = existing !== undefined && SessionConfigOption.isBoolean(existing)
                ? (value === "true" || value === "1" || value === "on")
                : value;
            const res = await client.setConfigOption(session.sessionId, configId, parsedValue);
            session.configOptions = [...res.configOptions];
        }
        if (options.json) {
            process.stdout.write(
                `${JSON.stringify(
                    {
                        sessionId: session.sessionId,
                        configOptions: session.configOptions,
                    },
                    null,
                    2,
                )}\n`,
            );
            return 0;
        }
        for (const opt of session.configOptions) {
            if (configId === undefined || opt.configId === configId) {
                process.stdout.write(`${formatConfigOption(opt)}\n`);
            }
        }
        return 0;
    } finally {
        client.close();
    }
};

export const formatServiceUpdateResult = (res: Record<string, unknown>): string => {
    const cat = (res.catalog ?? {}) as Record<string, unknown>;
    const npm = (res.npm ?? {}) as Record<string, unknown>;
    const added = typeof cat.addedModels === "number" && cat.addedModels > 0 ? `, +${String(cat.addedModels)} new` : "";
    const catLine = `catalog: ${String(cat.status ?? "updated")} (${String(cat.models ?? 0)} models across ${String(cat.providers ?? 0)} providers${added})`;
    const pkg = String(npm.package ?? "@plurnk/plurnk-service");
    const prev = String(npm.previousVersion ?? "");
    const curr = String(npm.currentVersion ?? prev);
    const npmLine = npm.status === "source"
        ? `npm: ${pkg}@${curr} (source checkout)`
        : npm.status === "updated"
            ? `npm: ${pkg} ${prev} -> ${curr}`
            : `npm: ${pkg}@${curr} (unchanged)`;
    return `${catLine}\n${npmLine}`;
};

export const runCliUpdate = async (options: CliCommonOptions): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    await ensureDaemonConnected(client, options);
    try {
        const result = await client.action<Record<string, unknown>>("service.update", {});
        if (options.json) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
            process.stdout.write(`${formatServiceUpdateResult(result)}\n`);
        }
        return 0;
    } finally {
        client.close();
    }
};

export const runCliModels = async (
    searchTerms: readonly string[],
    query: { readonly provider?: string; readonly all?: boolean; readonly offset?: number; readonly limit?: number },
    options: CliCommonOptions,
): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    await ensureDaemonConnected(client, options);
    try {
        let result: unknown;
        try {
            result = await client.action("models.list", {
                ...(searchTerms.length > 0 ? { search: searchTerms.join(" ") } : {}),
                ...(query.provider !== undefined ? { provider: query.provider } : {}),
                ...(query.all !== undefined ? { all: query.all } : {}),
                ...(query.offset !== undefined ? { offset: query.offset } : {}),
                ...(query.limit !== undefined ? { limit: query.limit } : {}),
            });
        } catch {
            result = await client.listProviders();
        }
        if (options.json) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            return 0;
        }
        const rec = result as Record<string, unknown>;
        const items = Array.isArray(rec.items)
            ? rec.items
            : Array.isArray(rec.providers)
                ? rec.providers
                : [];
        for (const item of items) {
            const r = item as Record<string, unknown>;
            process.stdout.write(`${String(r.id ?? r.providerId ?? r.alias ?? "")}\t${String(r.name ?? r.model ?? "")}\n`);
        }
        return 0;
    } finally {
        client.close();
    }
};

export const runCliWorkspace = async (
    sub: string | undefined,
    arg1: string | undefined,
    arg2: string | undefined,
    options: CliCommonOptions,
): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    await ensureDaemonConnected(client, options);
    try {
        if (sub === "list" || sub === undefined) {
            let result: unknown;
            try {
                result = await client.action("workspace.list", {});
            } catch {
                result = await client.listSessions(options.cwd);
            }
            if (options.json) {
                process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
                return 0;
            }
            const rec = result as Record<string, unknown>;
            const list = Array.isArray(rec.workspaces)
                ? rec.workspaces
                : Array.isArray(rec.sessions)
                    ? rec.sessions
                    : [];
            for (const item of list) {
                const w = item as Record<string, unknown>;
                process.stdout.write(`${String(w.name ?? w.sessionId ?? w.id)}\t${String(w.project_root ?? w.cwd ?? "")}\n`);
            }
            return 0;
        }
        if (sub === "sessions") {
            const wsName = arg1 ?? options.workspace;
            const result = await client.action("workspace.sessions", {}, { workspace: wsName });
            if (options.json) {
                process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
                return 0;
            }
            const rec = result as Record<string, unknown>;
            const sessions = Array.isArray(rec.sessions) ? rec.sessions : [];
            for (const s of sessions) {
                const r = s as Record<string, unknown>;
                process.stdout.write(`${String(r.name)}\t${String(r.lifecycle ?? "idle")}\n`);
            }
            return 0;
        }
        if (sub === "rename") {
            if (!arg1 || !arg2) {
                process.stderr.write("plurnk workspace rename requires <name> <newname>.\n");
                return 64;
            }
            const result = await client.action("workspace.rename", { from: arg1, name: arg2 }, { workspace: arg1 });
            if (options.json) {
                process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            } else {
                process.stdout.write(`${arg2}\n`);
            }
            return 0;
        }
        process.stderr.write(`Unknown workspace subcommand: ${sub}\n`);
        return 64;
    } finally {
        client.close();
    }
};

export const runCliLogRead = async (
    filters: { readonly loopId?: number; readonly turnId?: number; readonly sinceId?: number; readonly limit?: number },
    options: CliCommonOptions,
): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    await ensureDaemonConnected(client, options);
    try {
        const result = await client.action<{ readonly entries?: unknown[] }>(
            "log.read",
            {
                ...(filters.loopId !== undefined ? { loopId: filters.loopId } : {}),
                ...(filters.turnId !== undefined ? { turnId: filters.turnId } : {}),
                ...(filters.sinceId !== undefined ? { sinceId: filters.sinceId } : {}),
                limit: filters.limit ?? 100,
            },
            {
                workspace: options.workspace,
                session: options.sessionId ?? options.tuiSession,
                cwd: options.cwd,
            },
        );
        if (options.json) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            return 0;
        }
        const entries = Array.isArray(result.entries) ? result.entries : [];
        for (const entry of entries) {
            const e = entry as Record<string, unknown>;
            process.stdout.write(`${String(e.loop_seq ?? e.loop_id)}/${String(e.turn_seq ?? e.turn_id)}/${String(e.sequence)}\t${String(e.op ?? "")}\t${String(e.status ?? "")}\n`);
        }
        return 0;
    } finally {
        client.close();
    }
};

export const runCliReadCoord = async (
    coord: string,
    options: CliCommonOptions,
): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    await ensureDaemonConnected(client, options);
    try {
        const target = coord.includes("://") ? coord : `log:///${coord}`;
        const result = await client.action(
            "entry.read",
            { target },
            {
                workspace: options.workspace,
                session: options.sessionId ?? options.tuiSession,
                cwd: options.cwd,
            },
        );
        if (options.json) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            return 0;
        }
        const rec = result as Record<string, unknown>;
        const entry = rec.entry as Record<string, unknown> | undefined;
        const channels = (entry?.channels ?? {}) as Record<string, { readonly content?: string }>;
        const body = channels.body?.content ?? channels.stdout?.content ?? JSON.stringify(result, null, 2);
        process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
        return 0;
    } finally {
        client.close();
    }
};

export const runCliCapabilities = async (
    policyJson: string | undefined,
    options: CliCommonOptions,
): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    await ensureDaemonConnected(client, options);
    try {
        const result = policyJson !== undefined
            ? await client.action(
                  "workspace.capabilities.set",
                  { policy: JSON.parse(policyJson) as unknown },
                  { workspace: options.workspace, cwd: options.cwd },
              )
            : await client.action("workspace.capabilities.get", {}, { workspace: options.workspace, cwd: options.cwd });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
    } finally {
        client.close();
    }
};

export const runCliScript = async (
    filePath: string,
    options: CliCommonOptions,
): Promise<number> => {
    const text = readFileSync(resolve(options.cwd, filePath), "utf8");
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    await ensureDaemonConnected(client, options);
    try {
        const res = await client.action<{ readonly results?: Array<{ readonly status?: number; readonly content?: string; readonly message?: string }> }>(
            "op.parse",
            { text },
            { workspace: options.workspace, session: options.sessionId ?? options.tuiSession, cwd: options.cwd },
        );
        if (options.json) {
            process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
        } else {
            for (const r of res.results ?? []) {
                const line = r.content ?? r.message ?? String(r.status ?? 200);
                process.stdout.write(line.endsWith("\n") ? line : `${line}\n`);
            }
        }
        const worst = Math.max(200, ...(res.results ?? []).map((r) => r.status ?? 200));
        return worst >= 400 ? 4 : 0;
    } finally {
        client.close();
    }
};

export const runCliCompletion = (shell: string | undefined): number => {
    const map: Record<string, string> = {
        bash: "completions/plurnk.bash",
        zsh: "completions/_plurnk",
        fish: "completions/plurnk.fish",
    };
    const rel = shell !== undefined ? map[shell] : undefined;
    if (rel === undefined) {
        process.stderr.write("usage: plurnk completion <bash|zsh|fish>\n");
        return 64;
    }
    const content = readFileSync(resolve(ROOT, rel), "utf8");
    process.stdout.write(content);
    return 0;
};

export const runCliFamily = async (
    family: string,
    familyArgs: readonly string[],
    options: CliCommonOptions,
): Promise<number> => {
    if (familyArgs.includes("--help") || familyArgs.includes("-h")) {
        process.stdout.write(`usage: plurnk ${family} [list|add|remove|enable|disable] [options]\n`);
        return 0;
    }
    const sub = familyArgs[0] ?? "list";
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    await ensureDaemonConnected(client, options);
    try {
        const scopePrefix = family === "env" && familyArgs.includes("session") ? "session" : "workspace";
        const actionName = `${scopePrefix}.${family}.${sub}`;
        const session = await openCliSession(client, {
            ...options,
            sessionId: options.sessionId ?? options.tuiSession,
        });
        const result = await client.action<Record<string, unknown>>(
            actionName,
            {},
            {
                sessionId: session.sessionId,
                workspace: options.workspace,
                session: options.sessionId ?? options.tuiSession,
            },
        );
        if (options.json) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            return 0;
        }
        const definitions = Array.isArray(result.definitions)
            ? result.definitions
            : Array.isArray(result.items)
                ? result.items
                : [];
        if (definitions.length === 0) {
            process.stdout.write(`${family}: none\n`);
            return 0;
        }
        for (const item of definitions) {
            const d = item as Record<string, unknown>;
            const alias = String(d.alias ?? d.name ?? "");
            const state = String(d.state ?? "active");
            const def = (d.definition ?? {}) as Record<string, unknown>;
            const type = typeof def.type === "string" ? def.type : "";
            const cmd = typeof def.command === "string" ? def.command : typeof def.url === "string" ? def.url : "";
            const prov = (d.provenance ?? {}) as Record<string, unknown>;
            const source = typeof prov.source === "string" ? `source=${prov.source}` : "";
            const parts = [alias, state, type, cmd, source].filter((p) => p.length > 0);
            process.stdout.write(`${parts.join("  ")}\n`);
        }
        return 0;
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
