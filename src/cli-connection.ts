// Daemon connection, autostart, and ACP v2 session admission primitives
// ({§cli-invocation}, {§cli-subcommands}, {§cli-workspaces-and-sessions}).

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { AcpClient } from "./acp-client.ts";
import { AcpSession } from "./acp-session.ts";
import Credential from "./credential.ts";

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
    readonly interactive?: boolean;
    readonly debugNoMeta?: boolean;
    readonly shareFolder?: string;
    readonly previewLines: number;
    readonly historyEntries: number;
    readonly mermaidTimeoutMs: number;
    readonly color: string;
}

const isLoopbackHost = (host: string): boolean =>
    host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";

const DAEMON_POLL_MS = 100;

export const resolveServiceCommand = (
    serviceBin?: string,
    subcommandArgs: readonly string[] = ["start"],
): { readonly file: string; readonly args: string[] } => {
    if (serviceBin !== undefined && serviceBin.trim().length > 0) {
        const bin = serviceBin.trim();
        if (bin.endsWith(".js") || bin.endsWith(".mjs") || bin.endsWith(".ts")) {
            return { file: process.execPath, args: [resolve(bin), ...subcommandArgs] };
        }
        return { file: bin, args: [...subcommandArgs] };
    }
    const localBin = join(process.cwd(), "node_modules", ".bin", "plurnk-service");
    if (existsSync(localBin)) {
        return { file: localBin, args: [...subcommandArgs] };
    }
    try {
        const pkgPath = require.resolve("@plurnk/plurnk-service/package.json");
        const serviceJs = join(dirname(pkgPath), "dist", "service.js");
        if (existsSync(serviceJs)) {
            return { file: process.execPath, args: [serviceJs, ...subcommandArgs] };
        }
        const serviceTs = join(dirname(pkgPath), "src", "service.ts");
        if (existsSync(serviceTs)) {
            return { file: process.execPath, args: [serviceTs, ...subcommandArgs] };
        }
    } catch {
        // fallback to PATH
    }
    return { file: "plurnk-service", args: [...subcommandArgs] };
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
                        detail: `Could not reach the configured service at ${options.url}. Start it with \`plurnk daemon start\` or check PLURNK_ACP_URL.`,
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
                                detail: "Could not find `plurnk-service` to start the daemon automatically. Install `@plurnk/plurnk-service` (`npm install -g --ignore-scripts @plurnk/plurnk-service`).",
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
        await new Promise((r) => setTimeout(r, DAEMON_POLL_MS));
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
                    ? `Could not reach the configured service at ${options.url} (${lastError.message}). Run \`plurnk daemon start\`.`
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
        await Promise.all(
            Object.entries(options.sessionEnv).map(([alias, value]) =>
                client.action(
                    "session.env.replace",
                    { alias, value },
                    { sessionId: session.sessionId, workspace: options.workspace, session: options.sessionId },
                ),
            ),
        );
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
    const seenStartupNotices = new Set<string>();
    const isDuplicateNotice = (update: SessionUpdate): boolean => {
        if (!SessionUpdate.isNotice(update)) return false;
        if (!update.title?.startsWith("engine:configuration:")) return false;
        const key = `${update.severity}:${update.title}:${update.description ?? ""}`;
        if (seenStartupNotices.has(key)) return true;
        seenStartupNotices.add(key);
        return false;
    };

    const matchesSession = (incomingId: string, boundId: string): boolean => {
        if (incomingId === boundId) return true;
        if (/^\d+#/u.test(boundId)) return false;
        const boundSuffix = boundId.includes("#") ? boundId.slice(boundId.indexOf("#") + 1) : boundId;
        return incomingId.endsWith(`#${boundSuffix}`);
    };

    const offUpdate = client.onSessionUpdate((notification) => {
        if (session === null) {
            bufferedNotifications.push(notification);
            return;
        }
        if (matchesSession(notification.sessionId, session.sessionId)) {
            if (isDuplicateNotice(notification.update)) return;
            session.applyUpdate(notification.update);
        }
    });
    const offDisconnect = client.onDisconnect(() => {
        session?.endActiveStream();
    });

    try {
        const qualifiedMatch =
            options.sessionId !== undefined ? /^([^#]+)#(.+)$/u.exec(options.sessionId) : null;
        const qualifiedPrefix = qualifiedMatch !== null ? qualifiedMatch[1]! : undefined;
        const resolvedSessionName = qualifiedMatch !== null ? qualifiedMatch[2]! : options.sessionId;
        const resolvedWorkspaceId =
            qualifiedPrefix !== undefined && /^[1-9]\d*$/u.test(qualifiedPrefix)
                ? Number.parseInt(qualifiedPrefix, 10)
                : undefined;
        const resolvedWorkspaceName =
            qualifiedPrefix !== undefined && !/^\d+$/u.test(qualifiedPrefix)
                ? qualifiedPrefix
                : undefined;
        const attended = options.interactive === true && !options.auto;
        const plurnkMeta: Record<string, unknown> = {
            create: true,
            interactive: attended,
            tools: attended ? ["question", "mcp_input_required"] : [],
            descendants: true,
            control: true,
            ...(options.workspace !== undefined
                ? { workspace: options.workspace }
                : resolvedWorkspaceId !== undefined
                  ? { workspaceId: resolvedWorkspaceId }
                  : resolvedWorkspaceName !== undefined
                    ? { workspace: resolvedWorkspaceName }
                    : {}),
            ...(resolvedSessionName !== undefined
                ? { session: resolvedSessionName, name: resolvedSessionName }
                : {}),
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
        let nextSession: AcpSession | null = null;
        let alreadyReplayedOnResume = false;
        if (options.debugNoMeta && options.sessionId !== undefined && options.sessionId.length > 0) {
            try {
                const resumedFirst = await client.resumeSession(options.sessionId, options.cwd, {
                    ...(replayHistory ? { replayFrom: { type: "start" as const } } : {}),
                    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
                });
                const resolvedId =
                    typeof (resumedFirst as { sessionId?: unknown }).sessionId === "string"
                        ? (resumedFirst as unknown as { sessionId: string }).sessionId
                        : options.sessionId;
                nextSession = new AcpSession(resolvedId, {
                    configOptions: resumedFirst.configOptions,
                    meta: (resumedFirst._meta ?? undefined) as Record<string, unknown> | undefined,
                });
                alreadyReplayedOnResume = true;
            } catch (resumeErr) {
                const code = (resumeErr as { code?: unknown } | undefined)?.code;
                if (code !== -32002) {
                    throw resumeErr;
                }
            }
        }
        if (nextSession === null) {
            const created = await client.newSession(options.cwd, {
                ...(systemPrompt !== undefined ? { systemPrompt } : {}),
                _meta: { plurnk: plurnkMeta },
            });
            nextSession = new AcpSession(created.sessionId, {
                configOptions: created.configOptions,
                meta: (created._meta ?? undefined) as Record<string, unknown> | undefined,
            });
        }
        nextSession.onDispose(() => {
            offUpdate();
            offDisconnect();
        });
        if (replayHistory && !alreadyReplayedOnResume) {
            const resumed = await client.resumeSession(nextSession.sessionId, options.cwd, {
                replayFrom: { type: "start" },
                _meta: { plurnk: { ...plurnkMeta, window: true } },
            });
            if (resumed.configOptions && resumed.configOptions.length > 0) {
                nextSession.configOptions = [...resumed.configOptions];
            }
            if (resumed._meta !== undefined && resumed._meta !== null) {
                const prevPlurnk = (nextSession.meta?.plurnk ?? {}) as Record<string, unknown>;
                const nextPlurnk = ((resumed._meta as Record<string, unknown>).plurnk ?? {}) as Record<string, unknown>;
                nextSession.meta = {
                    ...(nextSession.meta ?? {}),
                    ...(resumed._meta as Record<string, unknown>),
                    plurnk: { ...prevPlurnk, ...nextPlurnk },
                };
            }
        }
        session = nextSession;

        for (const notification of bufferedNotifications) {
            if (matchesSession(notification.sessionId, session.sessionId)) {
                if (isDuplicateNotice(notification.update)) continue;
                session.applyUpdate(notification.update);
            }
        }
        bufferedNotifications.length = 0;

        if (onLiveUpdate !== undefined) {
            session.onUpdate(onLiveUpdate);
        }

        await applyInitialConfig(client, session, options);
        return session;
    } catch (err) {
        offUpdate();
        offDisconnect();
        throw err;
    }
};
