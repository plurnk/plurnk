// Interactive `/` command dispatch for the 5-stream REPL engine
// ({§cli-repl-mode}, {§cli-subcommands}, {§cli-interactive-command-discovery}).

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
    ForkSessionResponse,
    SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { AcpClient } from "./acp-client.ts";
import { AcpSession } from "./acp-session.ts";
import type { CliCommonOptions } from "./cli-connection.ts";
import {
    formatConfigOption,
    formatServiceUpdateResult,
} from "./cli-subcommands.ts";
import { parseModelsArgs } from "./collection-commands.ts";
import { INTERACTIVE_COMMANDS, renderCommandReference } from "./commands.ts";
import {
    executeFamilyCommand,
    extractChronologicalHistory,
    formatExecResultLine,
    formatLogEntries,
    formatModelsRows,
    formatWorkspacesRows,
    writeErrorJsonl,
    writeEventJsonl,
    type ClientStreams,
} from "./repl-commands.ts";
import {
    dispatchGateSlashCommand,
    type PendingElicitationGate,
    type PendingGate,
    type PendingPermissionGate,
} from "./repl-gate-commands.ts";
import { ScheduleCommandUsageError, tokenizeSlashArgs } from "./schedule-command.ts";
import { lifecycleGlyphFor } from "./session-presenter.ts";

export {
    type PendingElicitationGate,
    type PendingGate,
    type PendingPermissionGate,
};

export interface ReplSlashCommandContext {
    readonly client: AcpClient;
    readonly options: CliCommonOptions;
    readonly streams: ClientStreams;
    readonly hasCustomEventsStream: boolean;
    readonly pendingGates: Map<string, PendingGate>;
    getSession(): AcpSession;
    setSession(next: AcpSession): void;
    getWorkspace(): string;
    setWorkspace(next: string): void;
    getSessionName(): string;
    getProjectRoot(): string;
    getLifecycle(): string;
    getYolo(): boolean;
    setYolo(next: boolean): void;
    clearForceReviewNextRun(): void;
    getStagedComposerText(): string;
    setStagedComposerText(next: string): void;
    adjustLocalMcpOAuth(delta: number): void;
    bindSession(
        workspaceName: string | undefined,
        sessionName: string,
        bindOpts?: { readonly initial?: boolean; readonly isChild?: boolean },
    ): Promise<AcpSession>;
    adoptForkedSession(forked: ForkSessionResponse, requestedName?: string): Promise<AcpSession>;
    emitSessionBound(session: AcpSession): void;
    dispatchLine(rawLine: string): Promise<"continue" | "quit">;
    forwardPromptLine?(rawLine: string): Promise<"continue" | "quit">;
}

export const dispatchSlashCommand = async (
    line: string,
    ctx: ReplSlashCommandContext,
): Promise<"continue" | "quit"> => {
    const { client, options, streams } = ctx;
    const parts = line.slice(1).split(/\s+/u);
    const cmd = parts[0]?.toLowerCase() ?? "";
    const args = parts.slice(1);

    const bindingContext = () => ({
        sessionId: ctx.getSession().sessionId,
        workspace: ctx.getWorkspace(),
        session: ctx.getSessionName(),
    });

    const handleFamilyCommand = async (family: string, familyArgs: readonly string[]): Promise<void> => {
        const isLocalMcpOAuth = family === "mcp" && familyArgs[0] === "oauth" && familyArgs.length === 2;
        if (isLocalMcpOAuth) ctx.adjustLocalMcpOAuth(1);
        try {
            await executeFamilyCommand(client, family, familyArgs, bindingContext(), options.cwd, {
                surface: "repl",
                stdout: streams.stdout,
                oauthTimeoutMs: options.oauthTimeoutMs,
                onError: (problem) => writeErrorJsonl(streams.stderr, problem),
            });
        } finally {
            if (isLocalMcpOAuth) ctx.adjustLocalMcpOAuth(-1);
        }
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
        const currentSessionName = ctx.getSessionName();
        const currentWorkspace = ctx.getWorkspace();
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
            ctx.setSession(
                await ctx.bindSession(currentWorkspace, parent.name, {
                    isChild: parentOf(parent) !== null,
                }),
            );
            streams.stdout.write(`session: ${ctx.getSessionName()} (bound)\n`);
            return;
        }
        if (direction === "enter") {
            const children = current?.id !== undefined ? sessions.filter((s) => parentOf(s) === current.id) : [];
            const newest = children.at(-1);
            if (!newest) {
                streams.stdout.write("(no children)\n");
                return;
            }
            ctx.setSession(await ctx.bindSession(currentWorkspace, newest.name, { isChild: true }));
            streams.stdout.write(`session: ${ctx.getSessionName()} (bound)\n`);
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
        ctx.setSession(
            await ctx.bindSession(currentWorkspace, target.name, {
                isChild: parentId !== null,
            }),
        );
        streams.stdout.write(`session: ${ctx.getSessionName()} (bound)\n`);
    };

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

        if (await dispatchGateSlashCommand(cmd, args, line, ctx)) {
            return "continue";
        }

        if (cmd === "sessions") {
            const currentSessionName = ctx.getSessionName();
            const currentLifecycle = ctx.getLifecycle();
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
                    `session: ${ctx.getSessionName()} [/~/${ctx.getWorkspace()}#${ctx.getSessionName()}]\n`,
                );
                return "continue";
            }
            ctx.setSession(await ctx.bindSession(ctx.getWorkspace(), targetName));
            streams.stdout.write(`session: ${ctx.getSessionName()} (bound)\n`);
            return "continue";
        }

        if (cmd === "fork") {
            const session = ctx.getSession();
            const requestedName = args[0] && args[0].length > 0 ? args[0] : undefined;
            const forked = await client.forkSession(
                session.sessionId,
                ctx.getProjectRoot(),
                requestedName !== undefined ? { sessionName: requestedName } : undefined,
            );
            ctx.setSession(await ctx.adoptForkedSession(forked, requestedName));
            streams.stdout.write(`session: ${ctx.getSessionName()} (forked)\n`);
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
                streams.stdout.write(`workspace: ${ctx.getWorkspace()}\n`);
                return "continue";
            }
            ctx.setSession(await ctx.bindSession(targetWs, options.termSession || "session1"));
            streams.stdout.write(`workspace: ${ctx.getWorkspace()}\n`);
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
                { from: ctx.getWorkspace(), name: newName },
                bindingContext(),
            );
            ctx.setWorkspace(newName);
            ctx.emitSessionBound(ctx.getSession());
            streams.stdout.write(`workspace: ${ctx.getWorkspace()}\n`);
            return "continue";
        }

        if (cmd === "models") {
            const rawTail = line.replace(/^\/\S+(?:\s+)?/u, "");
            let modelsParams: ReturnType<typeof parseModelsArgs>;
            try {
                const tokenized = rawTail.length > 0 ? tokenizeSlashArgs(rawTail) : [];
                modelsParams = parseModelsArgs(tokenized);
            } catch (err) {
                if (err instanceof ScheduleCommandUsageError) {
                    writeErrorJsonl(streams.stderr, err.problem);
                    return "continue";
                }
                throw err;
            }
            const result = await client.action<Record<string, unknown>>("models.list", modelsParams);
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
                const opening = typeof l.opening === "string" ? l.opening : "";
                const clipped = opening.length > 240 ? opening.slice(0, 240) : opening;
                const ellipsis = l.continued === true || opening.length > 240 ? "…" : "";
                const rawSource = typeof l.source === "string" ? l.source : "";
                const sender =
                    rawSource.length > 0 && !rawSource.startsWith("acp:")
                        ? `${rawSource.replace(/^session:\/\//u, "~")}: `
                        : "";
                const status = typeof l.status === "number" ? l.status : 200;
                const lifecycle = typeof l.lifecycle === "string" ? l.lifecycle : "";
                const mark =
                    status === 100 || lifecycle === "queued"
                        ? " ⏳"
                        : status === 102 || lifecycle === "running"
                          ? " ⌛︎"
                          : status === 202 || lifecycle === "parked"
                            ? " 💤"
                            : status === 499 || lifecycle === "cancelled"
                              ? " 🛑"
                              : status >= 400 || lifecycle === "failed"
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
            const session = ctx.getSession();
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
            const loopOpening = typeof targetLoop.opening === "string" ? targetLoop.opening : "";
            if (loopOpening.length > 0 && !history.some((h) => h.kind === "user_message")) {
                history.unshift({
                    kind: "user_message",
                    id: `loop-${String(targetSeq)}`,
                    text: loopOpening,
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
            if (!ctx.hasCustomEventsStream) {
                streams.stdout.write(plainText);
            }
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
            const result = await client.action("session.rollback", { to }, bindingContext());
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
            const prev = ctx.getStagedComposerText();
            const nextStaged = prev.length > 0 ? `${prev}\n${content}` : content;
            ctx.setStagedComposerText(nextStaged);
            writeEventJsonl(streams.events, {
                sessionUpdate: "composer_updated",
                source: "import",
                path: filePath,
                text: nextStaged,
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
                writeFileSync(tmpFile, ctx.getStagedComposerText(), "utf8");
                const res = spawnSync(editorCmd, [tmpFile], {
                    stdio: "inherit",
                    shell: true,
                    env: options.env as NodeJS.ProcessEnv,
                });
                if (res.status === 0) {
                    const edited = readFileSync(tmpFile, "utf8").trim();
                    ctx.setStagedComposerText("");
                    writeEventJsonl(streams.events, {
                        sessionUpdate: "composer_updated",
                        source: "editor",
                        text: edited,
                    });
                    if (edited.length > 0) {
                        return await ctx.dispatchLine(edited);
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
            const res = await client.action("op.exec", { text }, bindingContext());
            for (const r of res.results ?? []) {
                const out = formatExecResultLine(r);
                streams.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
            }
            return "continue";
        }

        const configMap: Record<string, string> = {
            model: "model",
            effort: "thought_level",
            child: "child",
            mode: "mode",
            persona: "persona",
        };
        const mappedConfigId = configMap[cmd];
        if (mappedConfigId !== undefined) {
            const session = ctx.getSession();
            const arg = args[0];
            if (arg === undefined || arg.length === 0) {
                const opt = session.configOptions.find((o) => o.configId === mappedConfigId);
                if (opt !== undefined) {
                    streams.stdout.write(`${formatConfigOption(opt)}\n`);
                } else if (mappedConfigId === "model") {
                    streams.stdout.write("model (Model): none\n");
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

        if (["mcp", "skills", "members", "env", "schedule", "personas"].includes(cmd)) {
            const rawTail = line.replace(/^\/\S+(?:\s+)?/u, "");
            let familyArgs: readonly string[];
            try {
                familyArgs = rawTail.length > 0 ? tokenizeSlashArgs(rawTail) : [];
            } catch (err) {
                if (err instanceof ScheduleCommandUsageError) {
                    writeErrorJsonl(streams.stderr, err.problem);
                    return "continue";
                }
                throw err;
            }
            await handleFamilyCommand(cmd, familyArgs);
            return "continue";
        }

        if (cmd === "login") {
            const grant = await options.credential.login(options.url, {
                signal: AbortSignal.timeout(options.oauthTimeoutMs),
                write: (message) => streams.stdout.write(message),
            });
            streams.stdout.write(`authorized: ${grant.issuer} (${options.credential.grantsPath()})\n`);
            return "continue";
        }

        if (cmd === "logout") {
            try {
                await client.logout();
            } catch {
                // best-effort ACP logout
            }
            const { revoked, origin } = await options.credential.logout(options.url);
            streams.stdout.write(revoked ? `logged out: ${origin}\n` : `no stored grant for ${origin}\n`);
            return "continue";
        }

        const rawCmd = parts[0] ?? "";
        const advertisedMatch = ctx.getSession().availableCommands.some(
            (c) => c.type === "command" && c.name.toLowerCase() === rawCmd.toLowerCase(),
        );
        if (advertisedMatch && ctx.forwardPromptLine !== undefined) {
            return await ctx.forwardPromptLine(line);
        }

        writeErrorJsonl(streams.stderr, {
            type: "https://problems.plurnk.xyz/client/unknown-command",
            title: "Unknown command",
            status: 400,
            detail: `Unknown interactive command: /${rawCmd || cmd}`,
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
};
