// Pure Term viewport composed atop the 5-stream contract ([stdin, stdout, stderr, events, reasoning]).
// Holds no reference to AcpClient or AcpSession ({§cli-repl-mode}, {§cli-output-channels}, {§cli-rendering}, {§cli-markdown-projection}).

import * as readline from "node:readline";
import { PassThrough } from "node:stream";
import { wrapTextWithAnsi, type Terminal } from "@earendil-works/pi-tui";
import stringWidth from "string-width";
import type { CliCommonOptions } from "./cli-connection.ts";
import { runReplSession, type ClientStreams } from "./repl-session.ts";
import {
    formatModelRoute,
    SessionPresenter,
    type PresentationFrame,
} from "./session-presenter.ts";
import Review from "./term-review.ts";
import TermSurface, {
    attention,
    bell,
    buildHeader,
    formatComposerHint,
    ModelText,
    paint,
    renderActiveLiveLine,
    renderNoteBlock,
    renderOperationBlock,
    renderReasoning,
    windowTitle,
} from "./term-surface.ts";
import { attachViewportOutputListeners } from "./term-viewport-events.ts";
import {
    ALT_SHORTCUTS,
    altShortcut,
    attachViewportSurfaceInput,
    backTabShortcut,
    editInExternalEditor,
    routeAndSendLine,
    type TermViewportState,
} from "./term-viewport-input.ts";

export { ALT_SHORTCUTS, altShortcut, backTabShortcut };

const createLiveReasoningController = (surface: TermSurface | null) => {
    const liveReasoningLines: string[] = [];
    let liveReasoningPending = "";
    let liveReasoningTurnEnded = false;
    let liveReasoningFlushTimer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = (): void => {
        if (liveReasoningFlushTimer !== null) {
            clearTimeout(liveReasoningFlushTimer);
            liveReasoningFlushTimer = null;
        }
    };

    const flushToSurface = (includePending: boolean): void => {
        if (surface === null) return;
        const trailing = includePending ? liveReasoningPending.trimEnd() : "";
        const lines =
            trailing.length > 0
                ? [...liveReasoningLines, trailing].slice(-3)
                : liveReasoningLines.slice(-3);
        if (lines.length === 0) return;
        const rendered = renderReasoning(lines.join("\n"));
        surface.setLive(rendered.length > 0 ? rendered : null);
    };

    const retire = (): void => {
        clearTimer();
        liveReasoningLines.length = 0;
        liveReasoningPending = "";
        liveReasoningTurnEnded = false;
        surface?.setLive(null);
    };

    const handleChunk = (chunk: string, termOut: NodeJS.WritableStream): void => {
        if (surface !== null) {
            if (liveReasoningTurnEnded) {
                clearTimer();
                liveReasoningLines.length = 0;
                liveReasoningPending = "";
                liveReasoningTurnEnded = false;
            }
            const cleanChunk = ModelText.plain(chunk).replace(/\r\n/gu, "\n").replace(/\t/gu, "   ");
            if (
                liveReasoningLines.length === 0 &&
                liveReasoningPending.length === 0 &&
                cleanChunk.trim().length === 0
            ) {
                return;
            }
            liveReasoningPending += cleanChunk;
            const maxLineCols = Math.max(20, surface.columns - 3);
            let advanced = false;

            const pushCompletedLine = (rawLine: string): void => {
                const trimmedLine = rawLine.trimEnd();
                if (trimmedLine.length === 0) return;
                const wrapped = wrapTextWithAnsi(trimmedLine, maxLineCols);
                for (const wLine of wrapped) {
                    if (wLine.trim().length === 0) continue;
                    liveReasoningLines.push(wLine);
                    advanced = true;
                }
                if (liveReasoningLines.length > 3) {
                    liveReasoningLines.splice(0, liveReasoningLines.length - 3);
                }
            };

            if (liveReasoningPending.includes("\n")) {
                const segments = liveReasoningPending.split("\n");
                liveReasoningPending = segments.pop() ?? "";
                for (const seg of segments) {
                    pushCompletedLine(seg);
                }
            }
            if (stringWidth(liveReasoningPending) > maxLineCols) {
                const wrappedPending = wrapTextWithAnsi(liveReasoningPending, maxLineCols);
                if (wrappedPending.length > 1) {
                    liveReasoningPending = wrappedPending.pop() ?? "";
                    for (const wLine of wrappedPending) {
                        if (wLine.trim().length === 0) continue;
                        liveReasoningLines.push(wLine);
                        advanced = true;
                    }
                    if (liveReasoningLines.length > 3) {
                        liveReasoningLines.splice(0, liveReasoningLines.length - 3);
                    }
                }
            }

            clearTimer();
            if (advanced) {
                flushToSurface(false);
            }
            if (liveReasoningPending.trim().length > 0) {
                liveReasoningFlushTimer = setTimeout(() => {
                    liveReasoningFlushTimer = null;
                    flushToSurface(true);
                }, 40).unref();
            }
            return;
        }
        const trimmed = chunk.replace(/\r?\n$/u, "");
        if (trimmed.length > 0) {
            termOut.write(`${trimmed}\n`);
        }
    };

    return { handleChunk, retire, clearTimer };
};

export const runTermViewport = async (
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
    const surface = useSurface ? new TermSurface(outerStreams?.terminal) : null;

    const attend = attention(
        options.bell ? [bell(termOut as { readonly isTTY?: boolean; write(chunk: string): unknown })] : [],
    );

    const presenter = new SessionPresenter({
        workspaceName: options.workspace ?? "default",
        sessionName: options.sessionId ?? options.termSession ?? "session1",
        model: options.model ?? "default",
        yolo: options.yolo,
    });

    const review =
        surface !== null
            ? new Review(surface, {
                  sendStdin: (cmd) => {
                      replStdin.write(cmd);
                  },
                  editBody: async (initialBody) => {
                      return await surface.handOff(() => editInExternalEditor(initialBody, options.env));
                  },
                  record: (text) => {
                      surface.append(text);
                  },
              })
            : null;

    const reasoning = createLiveReasoningController(surface);

    const state: TermViewportState = {
        options,
        replStdin,
        termOut,
        termErr,
        surface,
        review,
        attend,
        presenter,
        initialPromptPrinted: false,
        initialWorkspaceConsumed: false,
        boundProjectRoot: options.projectRoot ?? options.cwd,
        cachedModels: [],
        cachedEfforts: ["low", "medium", "high"],
        cachedPersonas: ["none"],
        cachedSessions: [],
        cachedWorkspaces: [],
        cachedSkills: [],
        cachedAvailableCommands: [],
        currentPersona:
            options.persona !== undefined && options.persona.length > 0 && options.persona !== "none"
                ? options.persona
                : null,
        currentMode: null,
        providerModelsFetcher: null,
        modelSearchFetcher: null,
        modelEffortsFetcher: null,
        cachedFamilyAliases: new Map<string, string[]>(),
        currentTurns: 0,
        cancelArmed: false,
        focusedGateIds: [],
        suppressedStdoutQueue: [],
        localSubmittedPrompts: [],
        updateSurfaceStatus: (): void => {
            if (surface === null) return;
            const isLoopActive =
                presenter.lifecycle === "running" ||
                presenter.lifecycle === "queued" ||
                presenter.lifecycle === "parked" ||
                presenter.lifecycle === "requires_action";
            surface.setLoopActive(isLoopActive);
            const activeLine = renderActiveLiveLine(presenter.activeLiveEntries, surface.columns);
            surface.setLiveActivity(activeLine.length > 0 ? activeLine : null);
            const loopNum = presenter.loopSeq ?? 1;
            const turns = presenter.turns > 0 ? presenter.turns : state.currentTurns;
            const yoloLead = presenter.yolo || state.currentMode === "accept" ? "🔥 " : "";
            const place =
                turns > 0
                    ? `[/~/${presenter.workspaceName}#${presenter.sessionName}(${String(loopNum)}/${String(turns)})]`
                    : `[/~/${presenter.workspaceName}#${presenter.sessionName}]`;
            const modelLabel = formatModelRoute(presenter.model, presenter.effort, presenter.effortSource);
            const activity =
                presenter.lastStatusLine.length > 0
                    ? presenter.lastStatusLine
                    : `${presenter.lifecycle === "running" ? "⌛︎ " : presenter.lifecycle} · ${modelLabel}`;
            surface.setStatus(`${yoloLead}${place} ${activity}`);
            const leadSuggestion = !isLoopActive ? presenter.promptSuggestions[0] : undefined;
            surface.setPlaceholder(
                leadSuggestion !== undefined
                    ? `→ ${leadSuggestion.replace(/\s+/gu, " ").trim()} (Tab)`
                    : formatComposerHint({
                          yolo: presenter.yolo,
                          mode: state.currentMode,
                          persona: state.currentPersona,
                          childModel: presenter.childModel,
                      }),
            );
        },
        ensureSurfaceStarted: (): void => {
            if (surface === null || state.initialPromptPrinted) return;
            state.initialPromptPrinted = true;
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
            state.updateSurfaceStatus();
            surface.renderNow();
        },
        retireLiveReasoning: (): void => {
            reasoning.retire();
        },
        renderToolCallToSurface: (frame: Extract<PresentationFrame, { kind: "tool_call" }>): void => {
            if (surface === null) return;
            if (frame.op === "note") {
                const rendered = renderNoteBlock({
                    glyph: frame.glyph,
                    aside: frame.aside,
                    body: frame.noteBody ?? frame.contentLines.join("\n"),
                    columns: surface.columns,
                    mermaidTimeoutMs: options.mermaidTimeoutMs,
                });
                surface.upsertToolCall(frame.toolCallId, rendered, rendered.includes("\n"));
            } else {
                const rendered = renderOperationBlock({
                    glyph: frame.glyph,
                    op: frame.op,
                    title: frame.title,
                    target: frame.target,
                    scope: frame.scope,
                    destination: frame.destination,
                    pattern: frame.pattern,
                    fields: frame.fields,
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
                surface.upsertToolCall(frame.toolCallId, rendered, rendered.includes("\n"));
            }
        },
    };

    const statusTicker =
        surface !== null
            ? setInterval(() => {
                  if (
                      presenter.lifecycle === "running" ||
                      presenter.lifecycle === "parked" ||
                      presenter.activeLiveEntries.length > 0
                  ) {
                      presenter.buildStatusBar();
                      state.updateSurfaceStatus();
                  }
              }, 1000).unref()
            : null;

    const removeInputListener = attachViewportSurfaceInput(state);
    attachViewportOutputListeners(
        state,
        { replStdout, replStderr, replEvents, replReasoning },
        reasoning,
    );

    const userRl = surface === null ? readline.createInterface({ input: termIn, terminal: false }) : null;
    if (userRl !== null) {
        userRl.on("line", (line: string) => {
            routeAndSendLine(state, line);
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
            onProviderModelsFetcher: (fetcher) => {
                state.providerModelsFetcher = fetcher;
            },
            onModelSearchFetcher: (fetcher) => {
                state.modelSearchFetcher = fetcher;
            },
            onModelEffortsFetcher: (fetcher) => {
                state.modelEffortsFetcher = fetcher;
            },
        });
    } finally {
        reasoning.clearTimer();
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
