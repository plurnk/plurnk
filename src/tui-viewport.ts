// Pure TUI viewport composed atop the 5-stream contract ([stdin, stdout, stderr, events, reasoning]).
// Holds no reference to AcpClient or AcpSession ({§cli-repl-mode}, {§cli-output-channels}).

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as readline from "node:readline";
import { PassThrough } from "node:stream";
import type {
    SessionUpdate,
    ToolCallContent,
    ToolCallLocation,
    ToolCallStatus,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { matchesKey, type Terminal } from "@earendil-works/pi-tui";
import type { CliCommonOptions } from "./cli-runner.ts";
import { runReplSession, type ClientStreams } from "./repl-session.ts";
import { formatModelRoute, SessionPresenter, type PresentationFrame } from "./session-presenter.ts";
import { makeAutocompleteProvider } from "./tui-completion.ts";
import Review, { isElicitationGateEvent, isPermissionGateEvent } from "./tui-review.ts";
import TuiSurface, {
    attention,
    bell,
    buildHeader,
    concluded,
    formatLoopMetrics,
    ModelText,
    paint,
    renderLoopSummary,
    renderModelReply,
    renderNoteBlock,
    renderOperationBlock,
    renderReasoning,
    renderSubmittedInput,
    windowTitle,
} from "./tui-surface.ts";

export const ALT_SHORTCUTS: Readonly<Record<string, string>> = Object.freeze({
    m: "/models",
    s: "/workspaces",
    R: "/sessions",
    L: "/loops",
    Y: "/yolo",
    N: "/workspace",
    M: "/members",
    x: "/stop",
    "?": "/help",
    e: "/editor",
    h: "/parent",
    l: "/enter",
    j: "/older",
    k: "/newer",
});

export const altShortcut = (forward: string): string | null => {
    const m = forward.match(/^\x1b([a-zA-Z?])$/u);
    return m ? (ALT_SHORTCUTS[m[1]!] ?? null) : null;
};

export const backTabShortcut = (forward: string): string | null =>
    forward === "\x1b[Z" ? "/yolo" : null;

export const runTuiViewport = async (
    options: CliCommonOptions,
    outerStreams?: Partial<Pick<ClientStreams, "stdin" | "stdout" | "stderr">> & {
        readonly terminal?: Terminal;
    },
): Promise<number> => {
    const replStdin = new PassThrough();
    const replStdout = new PassThrough();
    const replStderr = new PassThrough();
    const replEvents = new PassThrough();
    const replReasoning = new PassThrough();

    const termIn = outerStreams?.stdin ?? process.stdin;
    const termOut = outerStreams?.stdout ?? process.stdout;
    const termErr = outerStreams?.stderr ?? process.stderr;

    const useSurface =
        outerStreams?.terminal !== undefined ||
        (outerStreams === undefined && process.stdin.isTTY === true && process.stdout.isTTY === true);
    const surface = useSurface ? new TuiSurface(outerStreams?.terminal) : null;

    const attend = attention(options.bell ? [bell(termOut as { readonly isTTY?: boolean; write(chunk: string): unknown })] : []);

    const presenter = new SessionPresenter({
        workspaceName: options.workspace ?? "default",
        sessionName: options.sessionId ?? options.tuiSession ?? "user",
        model: options.model ?? "default",
        yolo: options.yolo,
    });

    let initialPromptPrinted = false;
    let initialWorkspaceConsumed = false;
    let boundProjectRoot: string | null = options.projectRoot ?? options.cwd;
    let cachedModels: string[] = [];
    let cachedEfforts: string[] = ["low", "medium", "high"];
    let cachedPersonas: string[] = ["none"];
    let cachedSessions: string[] = [];
    let cachedWorkspaces: string[] = [];
    let liveReasoningBuffer = "";
    let liveReasoningTurnEnded = false;
    let currentTurns = 0;
    const focusedGateIds: string[] = [];
    const suppressedStdoutQueue: string[] = [];

    const editInExternalEditor = (initialText: string): string | null => {
        const editorCmd = options.env.VISUAL || options.env.EDITOR || "vi";
        const tmpDir = mkdtempSync(join(tmpdir(), "plurnk-tui-editor-"));
        const tmpFile = join(tmpDir, "buffer.md");
        try {
            writeFileSync(tmpFile, initialText, "utf8");
            const res = spawnSync(editorCmd, [tmpFile], {
                stdio: "inherit",
                shell: true,
                env: options.env as NodeJS.ProcessEnv,
            });
            if (res.status === 0) {
                return readFileSync(tmpFile, "utf8");
            }
            return null;
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    };

    const review =
        surface !== null
            ? new Review(surface, {
                  sendStdin: (cmd) => {
                      replStdin.write(cmd);
                  },
                  editBody: async (initialBody) => {
                      return await surface.handOff(() => editInExternalEditor(initialBody));
                  },
                  record: (text) => {
                      surface.append(text);
                  },
              })
            : null;

    const updateSurfaceStatus = (): void => {
        if (surface === null) return;
        const loopNum = presenter.loopSeq ?? 1;
        const turns = presenter.turns > 0 ? presenter.turns : currentTurns;
        const place =
            turns > 0
                ? `[${presenter.workspaceName}/~${presenter.sessionName}(${String(loopNum)}/${String(turns)})]`
                : `[${presenter.workspaceName}/~${presenter.sessionName}]`;
        const modelLabel = formatModelRoute(presenter.model, presenter.effort, presenter.effortSource);
        const activity =
            presenter.lastStatusLine.length > 0
                ? presenter.lastStatusLine
                : `${presenter.lifecycle === "running" ? "⌛︎ " : presenter.lifecycle} · ${modelLabel}`;
        surface.setStatus(`${place} ${activity}`);
    };

    const ensureSurfaceStarted = (): void => {
        if (surface === null || initialPromptPrinted) return;
        initialPromptPrinted = true;
        surface.start();
        const header = buildHeader({
            workspaceName: presenter.workspaceName,
            sessionName: presenter.sessionName,
            modelSelector: presenter.model,
            effort: presenter.effort,
            yolo: presenter.yolo,
        });
        surface.append(paint(header, "dim"));
        surface.setTitle(windowTitle(presenter.workspaceName, presenter.sessionName));
        surface.append("");
        updateSurfaceStatus();
        surface.renderNow();
    };

    const renderToolCallToSurface = (frame: Extract<PresentationFrame, { kind: "tool_call" }>): void => {
        if (surface === null) return;
        if (frame.op === "NOTE" && frame.origin === "model") {
            const rendered = renderNoteBlock({
                glyph: frame.glyph,
                aside: frame.aside,
                body: frame.noteBody ?? frame.contentLines.join("\n"),
                columns: surface.columns,
            });
            surface.append(rendered);
            if (rendered.includes("\n")) {
                surface.append("");
            }
        } else {
            const rendered = renderOperationBlock({
                glyph: frame.glyph,
                op: frame.op,
                title: frame.title,
                target: frame.target,
                scope: frame.scope,
                destination: frame.destination,
                pattern: frame.pattern,
                count: frame.count,
                aside: frame.aside,
                status: frame.status,
                statusCode: frame.statusCode,
                outcome: frame.outcome,
                contentLines: frame.contentLines,
                outputLines: frame.outputLines,
                coordinate: frame.toolCallId,
                previewLimit: options.previewLines,
                columns: surface.columns,
            });
            surface.append(rendered);
            if (rendered.includes("\n")) {
                surface.append("");
            }
        }
    };

    const statusTicker =
        surface !== null
            ? setInterval(() => {
                  if (presenter.lifecycle === "running" || presenter.lifecycle === "parked") {
                      presenter.buildStatusBar();
                      updateSurfaceStatus();
                  }
              }, 1000).unref()
            : null;

    const GATE_VERBS = new Set(["approve", "accept", "reject", "cancel", "edit", "answer"]);

    const routeAndSendLine = (rawSubmission: string): void => {
        const trimmed = rawSubmission.trim();
        if (trimmed.length === 0) return;
        if (trimmed.startsWith("/")) {
            const tokens = trimmed.slice(1).split(/\s+/u);
            const verb = tokens[0]?.toLowerCase() ?? "";
            const firstArg = tokens[1];
            const focusedId = focusedGateIds[0];
            if (
                GATE_VERBS.has(verb) &&
                focusedId !== undefined &&
                (firstArg === undefined || !firstArg.startsWith("@"))
            ) {
                const afterVerb = trimmed.slice(1 + verb.length).trimStart();
                const routed = afterVerb.length > 0 ? `/${verb} @${focusedId} ${afterVerb}` : `/${verb} @${focusedId}`;
                replStdin.write(
                    routed.includes("\n") ? `\x1b[200~${routed}\x1b[201~\n` : `${routed}\n`,
                );
                return;
            }
        }
        if (!trimmed.startsWith("/") && !trimmed.startsWith("!")) {
            presenter.markTurnStart();
            presenter.buildStatusBar();
            updateSurfaceStatus();
        }
        replStdin.write(
            rawSubmission.includes("\n")
                ? `\x1b[200~${rawSubmission}\x1b[201~\n`
                : `${rawSubmission}\n`,
        );
    };

    let cancelArmed = false;
    const cancelRun = (): void => {
        replStdin.write("/stop\n");
        if (!cancelArmed && surface !== null) {
            cancelArmed = true;
            surface.append(paint("  cancelling… (ctrl-c again to quit)", "dim"));
            surface.renderNow();
        }
    };

    let removeInputListener: (() => void) | null = null;
    if (surface !== null) {
        surface.setAutocompleteProvider(
            makeAutocompleteProvider({
                cwd: options.cwd,
                getProjectRoot: () => boundProjectRoot,
                getModels: () => cachedModels,
                getEfforts: () => cachedEfforts,
                getPersonas: () => cachedPersonas,
                getSessionNames: () => cachedSessions,
                getWorkspaceNames: () => cachedWorkspaces,
                getPendingGateIds: () => focusedGateIds,
            }),
        );

        removeInputListener = surface.addInputListener((text) => {
            if (surface.dialogOpen) return undefined;
            if (matchesKey(text, "escape")) {
                if (surface.leaveReview()) return { consume: true };
                if (
                    presenter.lifecycle === "running" ||
                    presenter.lifecycle === "parked" ||
                    presenter.lifecycle === "requires_action" ||
                    focusedGateIds.length > 0
                ) {
                    cancelRun();
                    return { consume: true };
                }
                if (surface.editor.getText().length > 0) {
                    surface.setInput("");
                }
                return { consume: true };
            }
            if (matchesKey(text, "ctrl+c")) {
                if (cancelArmed) {
                    cancelArmed = false;
                    replStdin.write("/quit\n");
                } else if (
                    presenter.lifecycle === "running" ||
                    presenter.lifecycle === "parked" ||
                    presenter.lifecycle === "requires_action" ||
                    focusedGateIds.length > 0
                ) {
                    cancelRun();
                } else if (surface.editor.getText().length > 0) {
                    surface.setInput("");
                } else {
                    replStdin.write("/quit\n");
                }
                return { consume: true };
            }
            if (matchesKey(text, "ctrl+d") && !surface.reviewing && surface.editor.getText().length === 0) {
                replStdin.write("/quit\n");
                return { consume: true };
            }
            if (surface.reviewing) return undefined;
            const shortcut = altShortcut(text) ?? backTabShortcut(text);
            if (shortcut !== null) {
                if (shortcut === "/editor") {
                    const draft = surface.editor.getText();
                    void surface.handOff(() => editInExternalEditor(draft)).then((edited) => {
                        if (edited !== null) {
                            surface.setInput(edited.replace(/\r?\n$/u, ""));
                        }
                    });
                } else {
                    replStdin.write(`${shortcut}\n`);
                }
                return { consume: true };
            }
            return undefined;
        });

        surface.editor.onSubmit = (rawText: string) => {
            const trimmed = rawText.trim();
            if (trimmed.length === 0) return;
            surface.editor.addToHistory(rawText);
            surface.append("");
            surface.append(renderSubmittedInput(rawText));
            surface.append("");

            if (trimmed === "/review" && review !== null && review.waiting > 0) {
                surface.openReview();
                return;
            }

            if (trimmed === "/editor") {
                void surface.handOff(() => editInExternalEditor("")).then((edited) => {
                    if (edited !== null) {
                        surface.setInput(edited.replace(/\r?\n$/u, ""));
                    }
                });
                return;
            }

            const importMatch = trimmed.match(/^\/import(?:\s+(.+))?$/u);
            if (importMatch) {
                const filePath = importMatch[1]?.trim() ?? "";
                if (!filePath) {
                    replStdin.write("/import\n");
                    return;
                }
                try {
                    const content = readFileSync(resolve(options.cwd, filePath), "utf8");
                    surface.insertInput(content);
                } catch (err) {
                    surface.append(
                        paint(
                            `error: ${ModelText.plain(err instanceof Error ? err.message : String(err))}`,
                            "failure",
                        ),
                    );
                }
                return;
            }

            routeAndSendLine(rawText);
        };
    }

    const retireLiveReasoning = (): void => {
        if (liveReasoningBuffer.length > 0) {
            liveReasoningBuffer = "";
            liveReasoningTurnEnded = false;
            surface?.setLive(null);
        }
    };

    replStdout.setEncoding("utf8");
    replStdout.on("data", (chunk: string) => {
        if (surface !== null) {
            if (!initialWorkspaceConsumed && chunk.startsWith("workspace: ")) {
                initialWorkspaceConsumed = true;
                ensureSurfaceStarted();
                return;
            }
            let remaining = chunk;
            while (suppressedStdoutQueue.length > 0 && remaining.startsWith(suppressedStdoutQueue[0]!)) {
                remaining = remaining.slice(suppressedStdoutQueue.shift()!.length);
            }
            if (remaining.length === 0) return;
            const trimmed = remaining.replace(/\r?\n$/u, "");
            if (trimmed === "cancelled (final 499)" && cancelArmed) {
                return;
            }
            if (trimmed === "yolo: on" || trimmed === "yolo: off") {
                presenter.yolo = trimmed === "yolo: on";
                updateSurfaceStatus();
            }
            if (trimmed.length > 0) {
                surface.append(trimmed);
            }
            return;
        }

        if (
            !initialPromptPrinted &&
            chunk.startsWith("workspace: ") &&
            presenter.workspaceName &&
            presenter.sessionName
        ) {
            initialPromptPrinted = true;
            termOut.write(`${chunk}[${presenter.workspaceName}/~${presenter.sessionName}] `);
            return;
        }
        if (chunk.startsWith("● ") && presenter.lastStatusLine.length > 0 && !chunk.includes(presenter.lastStatusLine)) {
            const trimmed = chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk;
            termOut.write(`${trimmed}\n${presenter.lastStatusLine}\n`);
            return;
        }
        termOut.write(chunk);
    });

    replStderr.setEncoding("utf8");
    let stderrBuf = "";
    replStderr.on("data", (chunk: string) => {
        stderrBuf += chunk;
        const lines = stderrBuf.split("\n");
        stderrBuf = lines.pop() ?? "";
        for (const line of lines) {
            if (line.trim().length === 0) continue;
            try {
                const parsed = JSON.parse(line) as Record<string, unknown>;
                if (
                    typeof parsed.type === "string" &&
                    parsed.type.startsWith("https://problems.plurnk.xyz/client/")
                ) {
                    if (parsed.type === "https://problems.plurnk.xyz/client/prompt-failed") {
                        cancelArmed = false;
                        retireLiveReasoning();
                        presenter.lifecycle = "failed";
                        presenter.lifecycleGlyph = "❌";
                        presenter.doing = null;
                        presenter.buildStatusBar();
                        if (surface !== null) {
                            updateSurfaceStatus();
                        }
                    }
                    const detail =
                        typeof parsed.detail === "string"
                            ? parsed.detail
                            : typeof parsed.title === "string"
                              ? parsed.title
                              : line;
                    if (surface !== null) {
                        surface.append(paint(ModelText.plain(detail), "failure"));
                    } else {
                        termErr.write(`${detail}\n`);
                    }
                }
            } catch {
                if (surface !== null) {
                    surface.append(paint(ModelText.plain(line), "failure"));
                } else {
                    termErr.write(`${line}\n`);
                }
            }
        }
    });

    replReasoning.setEncoding("utf8");
    replReasoning.on("data", (chunk: string) => {
        if (surface !== null) {
            if (liveReasoningTurnEnded) {
                liveReasoningBuffer = "";
                liveReasoningTurnEnded = false;
            }
            liveReasoningBuffer += chunk;
            const rendered = renderReasoning(liveReasoningBuffer);
            if (rendered.length > 0) {
                surface.setLive(rendered);
            }
            return;
        }
        const trimmed = chunk.replace(/\r?\n$/u, "");
        if (trimmed.length > 0) {
            termOut.write(`${trimmed}\n`);
        }
    });

    const isToolCallStatus = (value: unknown): value is ToolCallStatus =>
        value === "pending" || value === "in_progress" || value === "completed" || value === "failed";

    const isSessionUpdatePayload = (value: Record<string, unknown>): value is SessionUpdate =>
        typeof value.sessionUpdate === "string";

    const renderHistoryItemsToSurface = (items: readonly unknown[], addToEditorHistory: boolean): void => {
        if (surface === null) return;
        for (const rawItem of items) {
            if (typeof rawItem !== "object" || rawItem === null) continue;
            const rec = rawItem as Record<string, unknown>;
            if (rec.kind === "user_message" && typeof rec.text === "string" && rec.text.length > 0) {
                const plurnkMeta = (
                    rec.meta as
                        | {
                              plurnk?: {
                                  answering?: string;
                                  source?: string;
                              };
                          }
                        | undefined
                )?.plurnk;
                if (typeof plurnkMeta?.answering === "string") {
                    const sender =
                        typeof plurnkMeta.source === "string" && plurnkMeta.source.length > 0
                            ? plurnkMeta.source
                            : plurnkMeta.answering;
                    surface.append(`🐜 ${ModelText.plain(sender)}: ${ModelText.plain(rec.text)}`);
                } else {
                    if (addToEditorHistory) {
                        surface.editor.addToHistory(rec.text);
                    }
                    surface.append("");
                    surface.append(renderSubmittedInput(rec.text));
                    surface.append("");
                }
            } else if (rec.kind === "tool_call" && typeof rec.toolCallId === "string") {
                const effectiveStatus: ToolCallStatus =
                    rec.status === "in_progress" || rec.status === "pending" || !isToolCallStatus(rec.status)
                        ? "completed"
                        : rec.status;
                const toolCallUpdate: SessionUpdate = {
                    sessionUpdate: "tool_call_update",
                    toolCallId: rec.toolCallId,
                    ...(typeof rec.name === "string" ? { name: rec.name } : {}),
                    ...(typeof rec.title === "string" ? { title: rec.title } : {}),
                    status: effectiveStatus,
                    ...(Array.isArray(rec.locations) ? { locations: rec.locations as ToolCallLocation[] } : {}),
                    ...(Array.isArray(rec.content) ? { content: rec.content as ToolCallContent[] } : {}),
                    ...(rec.rawInput !== undefined ? { rawInput: rec.rawInput } : {}),
                    ...(rec.rawOutput !== undefined ? { rawOutput: rec.rawOutput } : {}),
                    ...(rec.meta !== undefined && typeof rec.meta === "object" && rec.meta !== null
                        ? { _meta: rec.meta as Record<string, unknown> }
                        : {}),
                };
                const tcFrames = presenter.apply(toolCallUpdate);
                for (const f of tcFrames) {
                    if (f.kind === "tool_call") {
                        renderToolCallToSurface(f);
                    }
                }
            } else if (
                rec.kind === "agent_message" &&
                typeof rec.text === "string" &&
                rec.text.length > 0
            ) {
                const plurnkMeta = (
                    rec.meta as
                        | {
                              plurnk?: {
                                  op?: string;
                                  status?: number;
                                  loopSeq?: number;
                                  turnSeq?: number;
                                  attrs?: { aside?: string };
                              };
                          }
                        | undefined
                )?.plurnk;
                if (typeof plurnkMeta?.loopSeq === "number") {
                    presenter.loopSeq = plurnkMeta.loopSeq;
                }
                if (typeof plurnkMeta?.turnSeq === "number" && plurnkMeta.turnSeq > 0) {
                    presenter.turns = Math.max(presenter.turns, plurnkMeta.turnSeq);
                }
                surface.append(
                    renderModelReply(rec.text, surface.columns, {
                        op: plurnkMeta?.op ?? "SEND",
                        status: plurnkMeta?.status ?? 200,
                        aside: plurnkMeta?.attrs?.aside ?? null,
                    }),
                );
            }
        }
    };

    replEvents.setEncoding("utf8");
    let eventsBuf = "";
    replEvents.on("data", (chunk: string) => {
        eventsBuf += chunk;
        const lines = eventsBuf.split("\n");
        eventsBuf = lines.pop() ?? "";
        for (const line of lines) {
            if (line.trim().length === 0) continue;
            let event: Record<string, unknown>;
            try {
                event = JSON.parse(line) as Record<string, unknown>;
            } catch {
                continue;
            }

            if (event.sessionUpdate === "session_bound") {
                cancelArmed = false;
                const prevWorkspace = presenter.workspaceName;
                const prevSession = presenter.sessionName;
                const wasStarted = initialPromptPrinted;
                if (typeof event.workspace === "string" && event.workspace.length > 0) {
                    presenter.workspaceName = event.workspace;
                }
                if (typeof event.session === "string" && event.session.length > 0) {
                    presenter.sessionName = event.session;
                }
                if (typeof event.cwd === "string") {
                    boundProjectRoot = event.cwd.length > 0 ? event.cwd : null;
                }
                if (Array.isArray(event.sessions)) {
                    cachedSessions = event.sessions
                        .map((s) => (s && typeof s === "object" ? String((s as { name?: unknown }).name ?? "") : ""))
                        .filter(Boolean);
                }
                if (Array.isArray(event.workspaces)) {
                    cachedWorkspaces = event.workspaces
                        .map((w) => (w && typeof w === "object" ? String((w as { name?: unknown }).name ?? "") : ""))
                        .filter(Boolean);
                }
                if (Array.isArray(event.configOptions)) {
                    for (const rawOpt of event.configOptions) {
                        const opt = rawOpt as {
                            configId?: string;
                            currentValue?: string;
                            options?: ReadonlyArray<{ value?: string }>;
                        };
                        if (opt.configId === "model") {
                            if (typeof opt.currentValue === "string") {
                                presenter.model = opt.currentValue.length > 0 ? opt.currentValue : "none";
                            }
                            if (Array.isArray(opt.options)) {
                                cachedModels = opt.options.map((o) => String(o.value ?? "")).filter(Boolean);
                            }
                        } else if (opt.configId === "thought_level") {
                            if (typeof opt.currentValue === "string") {
                                presenter.effort = opt.currentValue.length > 0 ? opt.currentValue : null;
                            }
                            if (Array.isArray(opt.options)) {
                                cachedEfforts = opt.options.map((o) => String(o.value ?? "")).filter(Boolean);
                            }
                        } else if (opt.configId === "persona") {
                            if (Array.isArray(opt.options)) {
                                cachedPersonas = opt.options
                                    .map((o) => String(o.value ?? ""))
                                    .filter((v) => v.length > 0 && v !== "custom");
                            }
                        }
                    }
                }
                if (event._meta && typeof event._meta === "object") {
                    presenter.ingestMeta(event._meta as Record<string, unknown>);
                }
                const historyLostFrame = presenter.consumeHistoryLostFrame();
                if (surface !== null) {
                    ensureSurfaceStarted();
                    if (!wasStarted && (presenter.model === "none" || presenter.model === "")) {
                        surface.append(
                            paint(
                                "⚠️  Supply a provider's API key to the backend (for example, export DEEPSEEK_API_KEY before launching); /models then lists its models and /model <selector> chooses one.",
                                "warning",
                            ),
                        );
                    }
                    if (historyLostFrame !== null) {
                        surface.append(paint(ModelText.plain(historyLostFrame.formatted), "failure"));
                    }
                    if (!wasStarted || presenter.workspaceName !== prevWorkspace || presenter.sessionName !== prevSession) {
                        presenter.resetSessionHistory();
                    }
                    if (Array.isArray(event.history) && event.history.length > 0) {
                        renderHistoryItemsToSurface(event.history, true);
                    }
                    if (wasStarted && (presenter.workspaceName !== prevWorkspace || presenter.sessionName !== prevSession)) {
                        currentTurns = 0;
                        presenter.turns = 0;
                        presenter.lastLoopStatus = null;
                        presenter.lastStatusLine = "";
                    }
                    currentTurns = presenter.turns;
                    presenter.buildStatusBar();
                    surface.setTitle(windowTitle(presenter.workspaceName, presenter.sessionName));
                    updateSurfaceStatus();
                    surface.renderNow();
                } else if (historyLostFrame !== null) {
                    termOut.write(`${historyLostFrame.formatted}\n`);
                }
                continue;
            }

            if (event.sessionUpdate === "loop_replay") {
                if (typeof event.loopSeq === "number") {
                    presenter.loopSeq = event.loopSeq;
                    presenter.turns = 0;
                    currentTurns = 0;
                }
                if (surface !== null) {
                    ensureSurfaceStarted();
                    presenter.resetSessionHistory();
                    const seqLabel = typeof event.loopSeq === "number" ? String(event.loopSeq) : "?";
                    surface.append(paint(`── loop ${seqLabel} ──`, "dim"));
                    if (Array.isArray(event.history) && event.history.length > 0) {
                        renderHistoryItemsToSurface(event.history, false);
                    }
                    if (presenter.turns === 0 && typeof event.loopSeq === "number") {
                        presenter.turns = 1;
                    }
                    currentTurns = presenter.turns;
                    updateSurfaceStatus();
                    surface.renderNow();
                } else if (typeof event.text === "string" && event.text.length > 0) {
                    termOut.write(event.text);
                }
                continue;
            }

            if (event.sessionUpdate === "composer_updated") {
                if (surface !== null && typeof event.text === "string") {
                    surface.setInput(event.text);
                }
                continue;
            }

            if (event.sessionUpdate === "connection_lost") {
                presenter.markDisconnected();
                if (surface !== null) {
                    updateSurfaceStatus();
                    surface.renderNow();
                } else if (presenter.lastStatusLine.length > 0) {
                    termOut.write(`${presenter.lastStatusLine}\n`);
                }
                continue;
            }

            if (event.sessionUpdate === "permission_request") {
                if (typeof event.id === "string" && event.id.length > 0 && !focusedGateIds.includes(event.id)) {
                    focusedGateIds.push(event.id);
                }
                if (review !== null && isPermissionGateEvent(event)) {
                    review.addPermissionGate(event);
                    attend("review");
                }
                continue;
            }

            if (event.sessionUpdate === "elicitation_request") {
                if (typeof event.id === "string" && event.id.length > 0 && !focusedGateIds.includes(event.id)) {
                    focusedGateIds.push(event.id);
                }
                if (review !== null && isElicitationGateEvent(event)) {
                    review.addElicitationGate(event);
                    attend("question");
                }
                continue;
            }

            if (event.sessionUpdate === "gate_resolved") {
                if (typeof event.id === "string") {
                    const idx = focusedGateIds.indexOf(event.id);
                    if (idx >= 0) focusedGateIds.splice(idx, 1);
                    review?.remove(event.id);
                }
                continue;
            }

            if (!isSessionUpdatePayload(event)) continue;
            const frames = presenter.apply(event);
            for (const frame of frames) {
                switch (frame.kind) {
                    case "reasoning_tail":
                    case "reasoning_retired":
                    case "subagent":
                        break;
                    case "status_update":
                        currentTurns = presenter.turns;
                        if (frame.newTurn) {
                            liveReasoningTurnEnded = true;
                            surface?.archiveTurn();
                        }
                        if (surface !== null) {
                            updateSurfaceStatus();
                        } else if (frame.status.lifecycle === "parked") {
                            termOut.write(`${frame.status.formattedStatusLine}\n`);
                        }
                        break;
                    case "reply_chunk":
                        currentTurns = presenter.turns;
                        if (surface !== null && frame.text.length > 0) {
                            suppressedStdoutQueue.push(frame.text.endsWith("\n") ? frame.text : `${frame.text}\n`);
                            surface.addResponse(
                                renderModelReply(frame.text, surface.columns, {
                                    op: frame.op,
                                    status: frame.status,
                                    aside: frame.aside,
                                }),
                            );
                        }
                        break;
                    case "tool_call":
                        currentTurns = presenter.turns;
                        if (surface !== null) {
                            renderToolCallToSurface(frame);
                            updateSurfaceStatus();
                        } else {
                            if (frame.title) {
                                termOut.write(`${frame.title}\n`);
                            }
                            for (const cLine of frame.contentLines) {
                                termOut.write(`${cLine}\n`);
                            }
                        }
                        break;
                    case "terminal_output":
                        // Stream telemetry never writes directly to the TUI waterfall ({§cli-rendering});
                        // concluded output is previewed beneath the launching operation row when it finishes.
                        if (surface === null) {
                            termOut.write(`${frame.rawData}\n`);
                        }
                        break;
                    case "session_message":
                        if (surface !== null) {
                            surface.append(`🐜 ${ModelText.plain(frame.senderSessionId)}: ${ModelText.plain(frame.text)}`);
                        } else {
                            termOut.write(`🐜 ${frame.senderSessionId}: ${frame.text}\n`);
                        }
                        break;
                    case "notice":
                        if (surface !== null) {
                            const accent = frame.severity === "info" ? "dim" : "failure";
                            surface.append(paint(ModelText.plain(frame.formatted), accent));
                            updateSurfaceStatus();
                        } else {
                            termOut.write(`${frame.formatted}\n`);
                        }
                        break;
                    case "status_bar":
                        cancelArmed = false;
                        retireLiveReasoning();
                        currentTurns = frame.turns;
                        if (surface !== null) {
                            const metricsOpts = {
                                turns: frame.turns,
                                elapsedMs: frame.elapsedMs,
                                inputTokens: frame.loopInputTokens ?? frame.status.inputTokens,
                                outputTokens: frame.loopOutputTokens ?? frame.status.outputTokens,
                                curationWeight: frame.status.curationWeight,
                                curationBudget: frame.status.curationBudget,
                                contextTokens: frame.status.contextTokens,
                                contextCapacity: frame.status.contextCapacity,
                                costUsd:
                                    frame.loopCostUsd !== undefined ? frame.loopCostUsd : frame.status.costUsd,
                            };
                            const attachedToHamster = surface.archiveTurn(
                                frame.statusCode === 200 && !frame.hitMaxTurns
                                    ? formatLoopMetrics(metricsOpts)
                                    : null,
                            );
                            if (frame.terminalDetail) {
                                surface.append(paint(`⛔ ${ModelText.plain(frame.terminalDetail)}`, "failure"));
                            }
                            if (!attachedToHamster) {
                                surface.append(
                                    renderLoopSummary({
                                        status: frame.statusCode,
                                        hitMaxTurns: frame.hitMaxTurns,
                                        ...metricsOpts,
                                    }),
                                );
                            }
                            updateSurfaceStatus();
                            attend(concluded(frame.statusCode, frame.hitMaxTurns));
                        } else {
                            if (frame.terminalDetail) {
                                termOut.write(`${frame.terminalDetail}\n`);
                            }
                            const loopNum = presenter.loopSeq ?? 1;
                            termOut.write(
                                `${frame.status.formattedStatusLine}\n[${presenter.workspaceName}/~${presenter.sessionName}(${String(loopNum)}/${String(frame.turns)})] `,
                            );
                        }
                        break;
                }
            }
        }
    });

    const userRl = surface === null ? readline.createInterface({ input: termIn, terminal: false }) : null;
    if (userRl !== null) {
        userRl.on("line", (line: string) => {
            routeAndSendLine(line);
        });
        userRl.on("close", () => {
            replStdin.end();
        });
    }

    try {
        return await runReplSession(options, {
            stdin: replStdin,
            stdout: replStdout,
            stderr: replStderr,
            events: replEvents,
            reasoning: replReasoning,
        });
    } finally {
        if (statusTicker !== null) {
            clearInterval(statusTicker);
        }
        removeInputListener?.();
        surface?.stop();
        userRl?.close();
        if (termIn === process.stdin) {
            process.stdin.pause();
        }
    }
};
