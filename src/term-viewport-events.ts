// Term viewport stream projection (`stdout`, `stderr`, `events`, `reasoning`)
// and history replay ({§cli-repl-mode}, {§cli-rendering}, {§cli-markdown-projection}).

import type { PassThrough } from "node:stream";
import type {
    SessionUpdate,
    ToolCallContent,
    ToolCallLocation,
    ToolCallStatus,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { extractMessageActor } from "./session-presenter.ts";
import { isElicitationGateEvent, isPermissionGateEvent } from "./term-review.ts";
import {
    concluded,
    formatLoopMetrics,
    ModelText,
    paint,
    renderLoopSummary,
    renderModelReply,
    renderSubmittedInput,
    windowTitle,
} from "./term-surface.ts";
import {
    applyAvailableCommandsToCache,
    applyConfigOptionsToCache,
    type TermViewportState,
} from "./term-viewport-input.ts";

export interface LiveReasoningHandler {
    handleChunk(chunk: string, termOut: NodeJS.WritableStream): void;
}

const isToolCallStatus = (value: unknown): value is ToolCallStatus =>
    value === "pending" || value === "in_progress" || value === "completed" || value === "failed";

const isSessionUpdatePayload = (value: Record<string, unknown>): value is SessionUpdate =>
    typeof value.sessionUpdate === "string";

const extractUpdateBlockText = (b: unknown): string => {
    if (!b || typeof b !== "object") return "";
    if (typeof (b as { text?: unknown }).text === "string") {
        return (b as { text: string }).text;
    }
    if ((b as { type?: unknown }).type === "skill" && typeof (b as { name?: unknown }).name === "string") {
        return `$${(b as { name: string }).name}`;
    }
    return "";
};

export const extractUpdateText = (content: unknown): string => {
    if (!content || typeof content !== "object") return "";
    if (Array.isArray(content)) {
        return content.map(extractUpdateBlockText).join("");
    }
    return extractUpdateBlockText(content);
};

const consumeLocalSubmittedPrompt = (state: TermViewportState, text: string): boolean => {
    const trimmed = text.trim();
    const idx = state.localSubmittedPrompts.findIndex(
        (p) =>
            p === text ||
            p.trim() === trimmed ||
            (p.trim().startsWith("$") && /^<skill:\/\/\/[^>]+>$/u.test(trimmed)),
    );
    if (idx < 0) return false;
    state.localSubmittedPrompts.splice(idx, 1);
    return true;
};

export const renderHistoryItemsToSurface = (
    state: TermViewportState,
    items: readonly unknown[],
    addToEditorHistory: boolean,
): void => {
    const { surface, presenter, options } = state;
    if (surface === null) return;
    presenter.setHistoryReplay(true);
    try {
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
                                  actor?: string;
                                  address?: string;
                                  target?: string;
                              };
                          }
                        | undefined
                )?.plurnk;
                if (
                    typeof plurnkMeta?.answering === "string" ||
                    (typeof plurnkMeta?.source === "string" && plurnkMeta.source.startsWith("session://"))
                ) {
                    const sender =
                        typeof plurnkMeta?.source === "string" && plurnkMeta.source.length > 0
                            ? plurnkMeta.source
                            : (plurnkMeta?.answering ?? "session");
                    surface.append(`🐜 ${ModelText.plain(sender)}: ${ModelText.plain(rec.text)}`);
                } else {
                    const userActor = extractMessageActor(plurnkMeta);
                    if (addToEditorHistory && userActor === null) {
                        surface.recordPrompt(rec.text);
                    }
                    surface.append("");
                    surface.append(renderSubmittedInput(rec.text, userActor));
                    surface.append("");
                }
            } else if (rec.kind === "tool_call" && typeof rec.toolCallId === "string") {
                const streamAttr = (
                    rec.meta as { plurnk?: { attrs?: { stream?: unknown } } } | undefined
                )?.plurnk?.attrs?.stream;
                const holdOpenRow =
                    addToEditorHistory &&
                    (rec.status === "pending" ||
                        (rec.status === "in_progress" &&
                            presenter.isOpenStream(
                                rec.toolCallId,
                                typeof streamAttr === "string" ? streamAttr : null,
                            )));
                const effectiveStatus: ToolCallStatus = holdOpenRow
                    ? (rec.status as ToolCallStatus)
                    : rec.status === "in_progress" || rec.status === "pending" || !isToolCallStatus(rec.status)
                      ? "completed"
                      : rec.status;
                if (holdOpenRow) {
                    surface.reserveToolCall(rec.toolCallId);
                }
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
                for (const f of presenter.apply(toolCallUpdate)) {
                    if (f.kind === "tool_call") {
                        state.renderToolCallToSurface(f);
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
                                  actor?: string;
                                  source?: string;
                                  address?: string;
                                  target?: string;
                                  attrs?: { aside?: string };
                                  receipt?: {
                                      repliedTo?: readonly string[];
                                      repliedToSources?: readonly string[];
                                  };
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
                        op: plurnkMeta?.op ?? "send",
                        status: plurnkMeta?.status ?? 200,
                        aside: plurnkMeta?.attrs?.aside ?? null,
                        actor: extractMessageActor(plurnkMeta),
                        mermaidTimeoutMs: options.mermaidTimeoutMs,
                    }),
                );
            }
        }
    } finally {
        presenter.setHistoryReplay(false);
    }
};

export const attachViewportOutputListeners = (
    state: TermViewportState,
    streams: {
        readonly replStdout: PassThrough;
        readonly replStderr: PassThrough;
        readonly replEvents: PassThrough;
        readonly replReasoning: PassThrough;
    },
    reasoning: LiveReasoningHandler,
): void => {
    const { surface, presenter, termOut, termErr } = state;

    streams.replStdout.setEncoding("utf8");
    streams.replStdout.on("data", (chunk: string) => {
        if (surface !== null) {
            if (!state.initialWorkspaceConsumed && chunk.startsWith("workspace: ")) {
                state.initialWorkspaceConsumed = true;
                state.ensureSurfaceStarted();
                return;
            }
            let remaining = chunk;
            while (
                state.suppressedStdoutQueue.length > 0 &&
                remaining.startsWith(state.suppressedStdoutQueue[0]!)
            ) {
                remaining = remaining.slice(state.suppressedStdoutQueue.shift()!.length);
            }
            if (remaining.length === 0) return;
            const trimmed = remaining.replace(/\r?\n$/u, "");
            if (trimmed === "cancelled (final 499)" && state.cancelArmed) {
                return;
            }
            if (trimmed === "yolo: on" || trimmed === "yolo: off") {
                presenter.yolo = trimmed === "yolo: on";
                presenter.buildStatusBar();
                state.updateSurfaceStatus();
            }
            if (trimmed.length > 0) {
                surface.append(trimmed);
            }
            return;
        }

        if (
            !state.initialPromptPrinted &&
            chunk.startsWith("workspace: ") &&
            presenter.workspaceName &&
            presenter.sessionName
        ) {
            state.initialPromptPrinted = true;
            termOut.write(`${chunk}[/~/${presenter.workspaceName}#${presenter.sessionName}] `);
            return;
        }
        if (chunk.startsWith("● ") && presenter.lastStatusLine.length > 0 && !chunk.includes(presenter.lastStatusLine)) {
            const trimmed = chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk;
            termOut.write(`${trimmed}\n${presenter.lastStatusLine}\n`);
            return;
        }
        termOut.write(chunk);
    });

    streams.replStderr.setEncoding("utf8");
    let stderrBuf = "";
    streams.replStderr.on("data", (chunk: string) => {
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
                        state.cancelArmed = false;
                        state.retireLiveReasoning();
                        presenter.lifecycle = "failed";
                        presenter.lifecycleGlyph = "❌";
                        presenter.doing = null;
                        presenter.buildStatusBar();
                        if (surface !== null) {
                            state.updateSurfaceStatus();
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

    streams.replReasoning.setEncoding("utf8");
    streams.replReasoning.on("data", (chunk: string) => {
        reasoning.handleChunk(chunk, termOut);
    });

    streams.replEvents.setEncoding("utf8");
    let eventsBuf = "";
    streams.replEvents.on("data", (chunk: string) => {
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
            handleViewportEvent(state, event);
        }
    });
};

const handleViewportEvent = (state: TermViewportState, event: Record<string, unknown>): void => {
    const { surface, presenter, review, attend, options, termOut } = state;

    if (event.sessionUpdate === "local_oauth") {
        state.activeLocalOAuth = event.active === true;
        if (!state.activeLocalOAuth) {
            state.cancelArmed = false;
        }
        return;
    }

    if (event.sessionUpdate === "session_bound") {
        state.cancelArmed = false;
        state.retireLiveReasoning();
        const prevWorkspace = presenter.workspaceName;
        const prevSession = presenter.sessionName;
        const wasStarted = state.initialPromptPrinted;
        if (typeof event.workspace === "string" && event.workspace.length > 0) {
            presenter.workspaceName = event.workspace;
        }
        if (typeof event.session === "string" && event.session.length > 0) {
            presenter.sessionName = event.session;
        }
        if (typeof event.cwd === "string") {
            state.boundProjectRoot = event.cwd.length > 0 ? event.cwd : null;
        }
        if (Array.isArray(event.sessions)) {
            state.cachedSessions = event.sessions
                .map((s) => (s && typeof s === "object" ? String((s as { name?: unknown }).name ?? "") : ""))
                .filter(Boolean);
        }
        if (Array.isArray(event.workspaces)) {
            state.cachedWorkspaces = event.workspaces
                .map((w) => (w && typeof w === "object" ? String((w as { name?: unknown }).name ?? "") : ""))
                .filter(Boolean);
        }
        if (event._meta && typeof event._meta === "object") {
            presenter.ingestMeta(event._meta as Record<string, unknown>);
        }
        if (Array.isArray(event.configOptions)) {
            applyConfigOptionsToCache(state, event.configOptions);
        }
        if (Array.isArray(event.availableCommands)) {
            applyAvailableCommandsToCache(state, event.availableCommands);
        }
        const historyLostFrame = presenter.consumeHistoryLostFrame();
        if (surface !== null) {
            state.ensureSurfaceStarted();
            if (!wasStarted && (presenter.model === "none" || presenter.model === "")) {
                const hasReadyModels = state.cachedModels.length > 0;
                surface.append(
                    paint(
                        hasReadyModels
                            ? "⚠️  No model selected. /models lists ready models and /model <selector> chooses one."
                            : "⚠️  No model selected. Supply a provider's API key and choose one with /models and /model <selector>.",
                        "warning",
                    ),
                );
            }
            if (historyLostFrame !== null) {
                surface.append(paint(ModelText.plain(historyLostFrame.formatted), "failure"));
            }
            if (!wasStarted || presenter.workspaceName !== prevWorkspace || presenter.sessionName !== prevSession) {
                presenter.resetSessionHistory();
                surface.resetToolCallSlots();
                state.localSubmittedPrompts.length = 0;
            }
            if (Array.isArray(event.promptSuggestions)) {
                presenter.setPromptSuggestions(
                    event.promptSuggestions.map((s) =>
                        s && typeof s === "object" && Array.isArray((s as { prompt?: unknown }).prompt)
                            ? extractUpdateText((s as { prompt: unknown[] }).prompt)
                            : "",
                    ),
                );
            }
            if (Array.isArray(event.prompts)) {
                surface.recordPromptHistory(
                    event.prompts.filter((p): p is string => typeof p === "string"),
                );
            }
            if (Array.isArray(event.history) && event.history.length > 0) {
                renderHistoryItemsToSurface(state, event.history, true);
            }
            if (wasStarted && (presenter.workspaceName !== prevWorkspace || presenter.sessionName !== prevSession)) {
                state.currentTurns = 0;
                presenter.turns = 0;
                presenter.lastLoopStatus = null;
                presenter.lastStatusLine = "";
            }
            state.currentTurns = presenter.turns;
            presenter.buildStatusBar();
            surface.setTitle(windowTitle(presenter.workspaceName, presenter.sessionName));
            state.updateSurfaceStatus();
            surface.renderNow();
        } else if (historyLostFrame !== null) {
            termOut.write(`${historyLostFrame.formatted}\n`);
        }
        return;
    }

    if (event.sessionUpdate === "loop_replay") {
        state.retireLiveReasoning();
        if (typeof event.loopSeq === "number") {
            presenter.loopSeq = event.loopSeq;
            presenter.turns = 0;
            state.currentTurns = 0;
        }
        if (surface !== null) {
            state.ensureSurfaceStarted();
            presenter.resetSessionHistory();
            surface.resetToolCallSlots();
            const seqLabel = typeof event.loopSeq === "number" ? String(event.loopSeq) : "?";
            surface.append(paint(`── loop ${seqLabel} ──`, "dim"));
            if (Array.isArray(event.history) && event.history.length > 0) {
                renderHistoryItemsToSurface(state, event.history, false);
            }
            if (presenter.turns === 0 && typeof event.loopSeq === "number") {
                presenter.turns = 1;
            }
            state.currentTurns = presenter.turns;
            state.updateSurfaceStatus();
            surface.renderNow();
        } else if (typeof event.text === "string" && event.text.length > 0) {
            termOut.write(event.text);
        }
        return;
    }

    if (event.sessionUpdate === "composer_updated") {
        if (surface !== null && typeof event.text === "string") {
            surface.setInput(event.text);
        }
        return;
    }

    if (event.sessionUpdate === "connection_lost") {
        state.retireLiveReasoning();
        presenter.markDisconnected();
        if (surface !== null) {
            state.updateSurfaceStatus();
            surface.renderNow();
        } else if (presenter.lastStatusLine.length > 0) {
            termOut.write(`${presenter.lastStatusLine}\n`);
        }
        return;
    }

    if (event.sessionUpdate === "permission_request") {
        state.retireLiveReasoning();
        if (typeof event.id === "string" && event.id.length > 0 && !state.focusedGateIds.includes(event.id)) {
            state.focusedGateIds.push(event.id);
        }
        if (review !== null && isPermissionGateEvent(event)) {
            review.addPermissionGate(event);
            attend("review");
        }
        return;
    }

    if (event.sessionUpdate === "elicitation_request") {
        state.retireLiveReasoning();
        if (typeof event.id === "string" && event.id.length > 0 && !state.focusedGateIds.includes(event.id)) {
            state.focusedGateIds.push(event.id);
        }
        if (review !== null && isElicitationGateEvent(event)) {
            review.addElicitationGate(event);
            attend("question");
        }
        return;
    }

    if (event.sessionUpdate === "gate_resolved") {
        if (typeof event.id === "string") {
            const idx = state.focusedGateIds.indexOf(event.id);
            if (idx >= 0) state.focusedGateIds.splice(idx, 1);
            review?.remove(event.id);
        }
        return;
    }

    if (!isSessionUpdatePayload(event)) return;
    if (
        surface !== null &&
        (event.sessionUpdate === "user_message_chunk" || event.sessionUpdate === "user_message")
    ) {
        const plurnkMeta = (
            event._meta as
                | {
                      plurnk?: {
                          published?: boolean;
                          answering?: string;
                          source?: string;
                          actor?: string;
                          address?: string;
                          target?: string;
                          op?: string;
                      };
                  }
                | undefined
        )?.plurnk;
        if (plurnkMeta?.published !== false) {
            const userText = extractUpdateText(event.content);
            if (userText.length > 0) {
                if (
                    typeof plurnkMeta?.answering === "string" ||
                    (typeof plurnkMeta?.source === "string" && plurnkMeta.source.startsWith("session://"))
                ) {
                    if (plurnkMeta?.op === "send") {
                        const sender =
                            typeof plurnkMeta.source === "string" && plurnkMeta.source.length > 0
                                ? plurnkMeta.source
                                : (plurnkMeta?.answering ?? "session");
                        surface.append(`🐜 ${ModelText.plain(sender)}: ${ModelText.plain(userText)}`);
                    }
                } else {
                    const userActor = extractMessageActor(plurnkMeta);
                    if (userActor === null) {
                        surface.recordPrompt(userText);
                    }
                    if (
                        (plurnkMeta === undefined || plurnkMeta.op === "send") &&
                        (userActor !== null || !consumeLocalSubmittedPrompt(state, userText))
                    ) {
                        surface.append("");
                        surface.append(renderSubmittedInput(userText, userActor));
                        surface.append("");
                    }
                }
            }
        }
    }
    if (
        surface !== null &&
        event.sessionUpdate === "tool_call_update" &&
        typeof event.toolCallId === "string" &&
        (event.status === "pending" || event.status === "in_progress")
    ) {
        surface.reserveToolCall(event.toolCallId);
    }
    const frames = presenter.apply(event);
    if (event.sessionUpdate === "config_option_update" && Array.isArray(event.configOptions)) {
        applyConfigOptionsToCache(state, event.configOptions);
    }
    if (event.sessionUpdate === "available_commands_update" && Array.isArray(event.availableCommands)) {
        applyAvailableCommandsToCache(state, event.availableCommands);
    }
    if (
        event.sessionUpdate === "usage_update" ||
        event.sessionUpdate === "config_option_update" ||
        event.sessionUpdate === "terminal_update"
    ) {
        presenter.buildStatusBar();
        if (surface !== null) {
            state.updateSurfaceStatus();
        }
    }
    for (const frame of frames) {
        switch (frame.kind) {
            case "reasoning_tail":
                break;
            case "subagent":
            case "prompt_suggestions":
                if (surface !== null) {
                    state.updateSurfaceStatus();
                }
                break;
            case "reasoning_retired":
                state.retireLiveReasoning();
                break;
            case "status_update":
                state.currentTurns = presenter.turns;
                if (frame.newTurn) {
                    state.retireLiveReasoning();
                    surface?.archiveTurn();
                } else if (frame.status.lifecycle !== "running" || presenter.doing?.phase === "working") {
                    state.retireLiveReasoning();
                    if (frame.status.lifecycle === "parked") {
                        surface?.archiveTurn();
                    }
                }
                if (surface !== null) {
                    state.updateSurfaceStatus();
                } else if (frame.status.lifecycle === "parked") {
                    termOut.write(`${frame.status.formattedStatusLine}\n`);
                }
                break;
            case "reply_chunk":
                state.retireLiveReasoning();
                state.currentTurns = presenter.turns;
                if (surface !== null && frame.text.length > 0) {
                    state.suppressedStdoutQueue.push(frame.text.endsWith("\n") ? frame.text : `${frame.text}\n`);
                    surface.addResponse(
                        renderModelReply(frame.text, surface.columns, {
                            op: frame.op,
                            status: frame.status,
                            aside: frame.aside,
                            actor: frame.actor,
                            mermaidTimeoutMs: options.mermaidTimeoutMs,
                        }),
                        frame.messageId,
                    );
                    if (frame.op === "wait") {
                        state.updateSurfaceStatus();
                    }
                }
                break;
            case "tool_call":
                state.retireLiveReasoning();
                state.currentTurns = presenter.turns;
                if (surface !== null) {
                    state.renderToolCallToSurface(frame);
                    state.updateSurfaceStatus();
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
                // Stream telemetry never writes directly to the Term waterfall ({§cli-rendering}).
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
                    const accent = frame.severity === "info" ? "dim" : frame.severity === "warning" ? "warning" : "failure";
                    surface.append(paint(ModelText.plain(frame.formatted), accent));
                    state.updateSurfaceStatus();
                } else {
                    termOut.write(`${frame.formatted}\n`);
                }
                break;
            case "status_bar":
                state.cancelArmed = false;
                state.retireLiveReasoning();
                state.currentTurns = frame.turns;
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
                    state.updateSurfaceStatus();
                    attend(concluded(frame.statusCode, frame.hitMaxTurns));
                } else {
                    if (frame.terminalDetail) {
                        termOut.write(`${frame.terminalDetail}\n`);
                    }
                    const loopNum = presenter.loopSeq ?? 1;
                    termOut.write(
                        `${frame.status.formattedStatusLine}\n[/~/${presenter.workspaceName}#${presenter.sessionName}(${String(loopNum)}/${String(frame.turns)})] `,
                    );
                }
                break;
        }
    }
};
