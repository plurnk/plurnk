// REPL `fd 0` input framing (bracketed paste, multiline MCP fences, backslash continuations),
// submission dispatch (`!`, MCP expressions, `...`, `?`, `:`, `/stop`, `/quit`, `/learn`), and SIGINT loop
// ({§cli-repl-mode}, {§cli-output-channels}, {§cli-sessions-topology}, {§cli-problems-and-notices}).

import * as readline from "node:readline";
import type { ForkSessionResponse } from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { AcpClient } from "./acp-client.ts";
import type { AcpSession } from "./acp-session.ts";
import { resolveLearnCommand } from "./commands.ts";
import {
    buildPromptBlocks,
    extractOpenPaths,
    formatExecResultLine,
    writeErrorJsonl,
    writeEventJsonl,
} from "./repl-commands.ts";
import type { ReplRuntimeState } from "./repl-session-binding.ts";
import { dispatchSlashCommand } from "./repl-slash-commands.ts";

export interface ReplLineAccumulator {
    feedLine(rawLine: string): void;
    flush(): void;
}

export const createReplLineAccumulator = (
    onSubmission: (submission: string) => void,
): ReplLineAccumulator => {
    let inBracketedPaste = false;
    let pasteLines: string[] = [];
    let activeFenceClosing: RegExp | null = null;
    let fenceLines: string[] = [];
    let continuationLines: string[] = [];

    const feedLine = (rawLine: string): void => {
        if (inBracketedPaste) {
            const endIdx = rawLine.indexOf("\x1b[201~");
            if (endIdx >= 0) {
                pasteLines.push(rawLine.slice(0, endIdx) + rawLine.slice(endIdx + "\x1b[201~".length));
                const submission = pasteLines.join("\n");
                pasteLines = [];
                inBracketedPaste = false;
                onSubmission(submission);
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
                onSubmission(combined);
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
                onSubmission(submission);
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
            onSubmission(submission);
            return;
        }

        onSubmission(rawLine);
    };

    const flush = (): void => {
        if (pasteLines.length > 0) {
            onSubmission(pasteLines.join("\n"));
            pasteLines = [];
            inBracketedPaste = false;
        }
        if (fenceLines.length > 0) {
            onSubmission(fenceLines.join("\n"));
            fenceLines = [];
            activeFenceClosing = null;
        }
        if (continuationLines.length > 0) {
            onSubmission(continuationLines.join("\n"));
            continuationLines = [];
        }
    };

    return { feedLine, flush };
};

export interface ReplDispatchContext {
    readonly state: ReplRuntimeState;
    readonly client: AcpClient;
    readonly hasCustomEventsStream: boolean;
    getSession(): AcpSession;
    setSession(next: AcpSession): void;
    bindSession(
        workspaceName: string | undefined,
        sessionName: string,
        bindOpts?: { readonly initial?: boolean; readonly isChild?: boolean },
    ): Promise<AcpSession>;
    adoptForkedSession(forked: ForkSessionResponse, requestedName?: string): Promise<AcpSession>;
    emitSessionBound(session: AcpSession): void;
    flushReasoningNewline(): void;
}

export const dispatchReplSubmission = async (
    rawLine: string,
    ctx: ReplDispatchContext,
): Promise<"continue" | "quit"> => {
    const { state, client } = ctx;
    const { options, streams, pendingGates } = state;
    const line = rawLine.trim();
    if (line.length === 0) return "continue";

    if (line === "/quit" || line === "/exit") {
        return "quit";
    }

    const session = ctx.getSession();
    const bindingContext = () => ({
        sessionId: ctx.getSession().sessionId,
        workspace: state.currentWorkspace,
        session: state.currentSessionName,
    });

    const sendPromptLine = (promptText: string, isQuestionPrompt = false): "continue" => {
        let finalPrompt = promptText;
        if (state.stagedComposerText.length > 0) {
            finalPrompt = finalPrompt.startsWith(state.stagedComposerText)
                ? finalPrompt
                : `${state.stagedComposerText}\n${finalPrompt}`;
            state.stagedComposerText = "";
        }
        const activeSess = ctx.getSession();
        const openPaths = extractOpenPaths(finalPrompt, state.currentProjectRoot);
        state.currentLifecycle = "running";
        void client
            .prompt(activeSess.sessionId, buildPromptBlocks(finalPrompt, activeSess.availableCommands), {
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
                state.currentLifecycle = "failed";
                writeErrorJsonl(streams.stderr, {
                    type: "https://problems.plurnk.xyz/client/prompt-failed",
                    title: "Prompt failed",
                    status: 500,
                    detail: err instanceof Error ? err.message : String(err),
                });
            });
        return "continue";
    };

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
        state.boundWorkspaceProjectRoot === undefined
            ? undefined
            : { projectRoot: state.boundWorkspaceProjectRoot },
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

    if (expandedLearn === null && (line.startsWith("/") || line === "?")) {
        const slashLine = line === "?" ? "/help" : line;
        return await dispatchSlashCommand(slashLine, {
            client,
            options,
            streams,
            hasCustomEventsStream: ctx.hasCustomEventsStream,
            pendingGates,
            getSession: ctx.getSession,
            setSession: ctx.setSession,
            getWorkspace: () => state.currentWorkspace,
            setWorkspace: (next) => {
                state.currentWorkspace = next;
                const currentSession = ctx.getSession();
                const plurnk = (currentSession.meta?.plurnk ?? undefined) as Record<string, unknown> | undefined;
                const ws = (plurnk?.workspace ?? undefined) as Record<string, unknown> | undefined;
                if (currentSession.meta !== undefined && plurnk !== undefined && ws !== undefined) {
                    currentSession.meta = {
                        ...currentSession.meta,
                        plurnk: {
                            ...plurnk,
                            workspace: { ...ws, name: next },
                        },
                    };
                }
            },
            getSessionName: () => state.currentSessionName,
            getProjectRoot: () => state.currentProjectRoot,
            getLifecycle: () => state.currentLifecycle,
            getYolo: () => state.currentYolo,
            setYolo: (next) => {
                state.currentYolo = next;
            },
            clearForceReviewNextRun: () => {
                state.forceReviewNextRun = false;
            },
            getStagedComposerText: () => state.stagedComposerText,
            setStagedComposerText: (next) => {
                state.stagedComposerText = next;
            },
            adjustLocalMcpOAuth: (delta) => {
                state.activeLocalMcpOAuth += delta;
            },
            bindSession: ctx.bindSession,
            adoptForkedSession: ctx.adoptForkedSession,
            emitSessionBound: ctx.emitSessionBound,
            dispatchLine: (forwarded) => dispatchReplSubmission(forwarded, ctx),
            forwardPromptLine: async (forwarded) => sendPromptLine(forwarded, false),
        });
    }

    const leadingTrimmed = rawLine.trimStart();
    if (leadingTrimmed === ":" || /^:\s+$/u.test(leadingTrimmed)) {
        writeErrorJsonl(streams.stderr, {
            type: "https://problems.plurnk.xyz/client/usage",
            title: "Empty literal prompt",
            status: 400,
            detail: "usage: : <prompt>",
        });
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
        !leadingTrimmed.startsWith(": ") &&
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
        const injectedOpenPaths = extractOpenPaths(injected, state.currentProjectRoot);
        void client
            .prompt(session.sessionId, buildPromptBlocks(injected, session.availableCommands), {
                plurnk: {
                    interactive: !options.auto,
                    tools: !options.auto ? ["question", "mcp_input_required"] : [],
                    descendants: true,
                    control: true,
                    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
                    ...(options.auto ? { envelope: { auto: true } } : {}),
                    ...(injectedOpenPaths.length > 0 ? { openPaths: injectedOpenPaths } : {}),
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
        state.forceReviewNextRun = true;
        isQuestionPrompt = true;
        promptText = line.slice(1).trimStart();
    } else if (leadingTrimmed.startsWith(": ")) {
        promptText = leadingTrimmed.slice(2);
    }

    return sendPromptLine(promptText, isQuestionPrompt);
};

export const runReplInputLoop = async (ctx: ReplDispatchContext): Promise<number> => {
    const { state, client } = ctx;
    const { streams, pendingGates } = state;

    const rl = readline.createInterface({
        input: streams.stdin,
        terminal: false,
    });

    return await new Promise<number>((resolvePromise) => {
        let settled = false;
        let queue = Promise.resolve();

        const finish = (code: number): void => {
            if (settled) return;
            settled = true;
            process.removeListener("SIGINT", onSigInt);
            ctx.flushReasoningNewline();
            rl.close();
            if (streams.stdin === process.stdin) {
                process.stdin.pause();
            }
            client.close();
            resolvePromise(code);
        };

        const onSigInt = (): void => {
            if (state.currentLifecycle === "running" || state.currentLifecycle === "parked" || pendingGates.size > 0) {
                for (const gate of [...pendingGates.values()]) {
                    if (gate.kind === "permission") {
                        gate.resolveGate({ outcome: { outcome: "cancelled" } });
                    } else {
                        gate.resolveGate({ action: "cancel" });
                    }
                }
                void client.cancel(ctx.getSession().sessionId).catch(() => {});
                streams.stdout.write("cancelled (final 499)\n");
                return;
            }
            if (state.stagedComposerText.length > 0) {
                state.stagedComposerText = "";
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

        const enqueueSubmission = (submission: string): void => {
            queue = queue.then(async () => {
                if (settled) return;
                const action = await dispatchReplSubmission(submission, ctx);
                if (action === "quit") {
                    finish(0);
                }
            });
        };

        const accumulator = createReplLineAccumulator(enqueueSubmission);

        rl.on("line", (rawLine: string) => {
            accumulator.feedLine(rawLine);
        });

        rl.on("close", () => {
            accumulator.flush();
            void queue.then(() => {
                finish(0);
            });
        });
    });
};
