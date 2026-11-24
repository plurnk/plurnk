// Chronological tool-call slot reservation, receipt materialization, runtime stream tracking,
// and subagent lifecycle projection for SessionPresenter ({§cli-rendering}, {§cli-session-status}).

import {
    ContentBlock,
    ToolCallContent,
    type SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { contentBlockToText } from "./acp-session.ts";
import {
    extractCoordinateSeqs,
    extractRawString,
    extractScopeToken,
    extractTitleAside,
    extractTitleTarget,
    extractToolFields,
    NO_PREVIEW_VERBS,
    normalizeWorkerKey,
    OPERATION_GLYPH_MAP,
    operationGlyphFor,
    receiptCountFor,
    WORKER_OPS,
} from "./presenter-formatters.ts";
import {
    buildPresenterStatusBar,
    retireReasoning,
    syncLoopAndTurn,
    type PresenterInternals,
    type PresenterState,
} from "./session-presenter-meta.ts";
import type { PresentationFrame } from "./session-presenter-types.ts";

export const projectToolCallUpdate = (
    state: PresenterState,
    internals: PresenterInternals,
    update: Extract<SessionUpdate, { readonly sessionUpdate: "tool_call_update" }>,
    frames: PresentationFrame[],
): void => {
    const incomingMetaPlurnk = (
        update._meta as
            | {
                  plurnk?: {
                      id?: number;
                      op?: string;
                      origin?: string;
                      status?: number;
                      attrs?: {
                          aside?: string;
                          kind?: string;
                          stream?: string;
                      };
                  };
              }
            | undefined
    )?.plurnk;
    const prior = internals.pendingToolCalls.get(update.toolCallId);
    if (
        internals.renderedToolCalls.has(update.toolCallId) &&
        update.status !== "in_progress" &&
        update.status !== "pending"
    ) {
        return;
    }
    const metaPlurnk = {
        ...(prior?.metaPlurnk ?? {}),
        ...(incomingMetaPlurnk ?? {}),
    } as {
        id?: number;
        op?: string;
        origin?: string;
        status?: number;
        loopSeq?: number;
        turnSeq?: number;
        attrs?: {
            aside?: string;
            kind?: string;
            stream?: string;
            session?: string;
            to?: string;
            waiting?: number;
        };
    };
    const toolCoord = extractCoordinateSeqs(update.toolCallId);
    syncLoopAndTurn(
        state,
        internals,
        metaPlurnk.loopSeq ?? toolCoord.loopSeq,
        metaPlurnk.turnSeq ?? toolCoord.turnSeq,
    );
    const incomingRawInput =
        update.rawInput && typeof update.rawInput === "object"
            ? (update.rawInput as Record<string, unknown>)
            : undefined;
    const rawInput = incomingRawInput ?? prior?.rawInput;
    const rawOutput =
        update.rawOutput && typeof update.rawOutput === "object"
            ? (update.rawOutput as Record<string, unknown>)
            : undefined;
    const effectiveName = update.name ?? prior?.name;
    const effectiveTitle = update.title ?? prior?.title;
    const effectiveLocations = update.locations ?? prior?.locations;
    const opName =
        metaPlurnk.op ?? effectiveName ?? effectiveTitle?.split(/[\s(—]/u)[0] ?? "tool";
    const origin = metaPlurnk.origin ?? "model";

    const incomingTerminalIds = (update.content ?? [])
        .filter(
            (c): c is { readonly type: "terminal"; readonly terminalId: string } =>
                c.type === "terminal" && typeof (c as { terminalId?: unknown }).terminalId === "string",
        )
        .map((c) => c.terminalId);
    const terminalIds =
        incomingTerminalIds.length > 0
            ? incomingTerminalIds
            : prior?.terminalIds && prior.terminalIds.length > 0
              ? prior.terminalIds
              : typeof metaPlurnk.id === "number"
                ? [`term:${String(metaPlurnk.id)}`]
                : [];

    const authoredTarget =
        opName === "copy" || opName === "move"
            ? extractRawString(rawInput?.source)
            : extractRawString(rawInput?.target);
    const attrSessionTarget =
        typeof metaPlurnk.attrs?.session === "string" && metaPlurnk.attrs.session.length > 0
            ? metaPlurnk.attrs.session.includes("://")
                ? metaPlurnk.attrs.session
                : `session://${metaPlurnk.attrs.session}`
            : typeof metaPlurnk.attrs?.to === "string" && metaPlurnk.attrs.to.length > 0
              ? metaPlurnk.attrs.to
              : null;
    const target =
        authoredTarget ??
        effectiveLocations?.[0]?.path ??
        attrSessionTarget ??
        extractTitleTarget(effectiveTitle);

    // Suppress internal _plurnk emission announcements and entry materializations ({§cli-rendering}).
    if (
        metaPlurnk.origin === "_plurnk" &&
        opName === "read" &&
        (metaPlurnk.attrs?.kind === "emission" ||
            (typeof target === "string" && target.startsWith("ops://")))
    ) {
        return;
    }
    if (
        metaPlurnk.origin === "_plurnk" &&
        opName === "edit" &&
        metaPlurnk.attrs?.kind === "entry_materialized"
    ) {
        return;
    }

    retireReasoning(internals, frames);

    const streamTarget =
        typeof metaPlurnk.attrs?.stream === "string" && metaPlurnk.attrs.stream.length > 0
            ? metaPlurnk.attrs.stream
            : target ?? update.toolCallId;
    const entryId = typeof metaPlurnk.id === "number" ? metaPlurnk.id : null;
    const concludedStreamCode =
        (typeof metaPlurnk.attrs?.stream === "string" && metaPlurnk.attrs.stream > ""
            ? internals.concludedStreams.get(metaPlurnk.attrs.stream)
            : undefined) ??
        (entryId !== null ? internals.concludedStreams.get(`term:${String(entryId)}`) : undefined) ??
        terminalIds.map((id) => internals.concludedStreams.get(id)).find((code) => code !== undefined);
    const effectiveStatus =
        (update.status === "in_progress" || update.status === "pending") &&
        concludedStreamCode !== undefined
            ? concludedStreamCode >= 400
                ? "failed"
                : "completed"
            : update.status;

    const rawAside =
        typeof rawInput?.aside === "string" && rawInput.aside.trim().length > 0
            ? rawInput.aside.trim()
            : typeof rawInput?.comment === "string" && rawInput.comment.trim().length > 0
              ? rawInput.comment.trim()
              : typeof metaPlurnk.attrs?.aside === "string" && metaPlurnk.attrs.aside.trim().length > 0
                ? metaPlurnk.attrs.aside.trim()
                : extractTitleAside(effectiveTitle);

    if (effectiveStatus === "in_progress" || effectiveStatus === "pending") {
        internals.pendingToolCalls.set(update.toolCallId, {
            ...(effectiveName !== undefined ? { name: effectiveName } : {}),
            ...(effectiveTitle !== undefined ? { title: effectiveTitle } : {}),
            ...(effectiveLocations !== undefined ? { locations: effectiveLocations } : {}),
            ...(rawInput !== undefined ? { rawInput } : {}),
            metaPlurnk: metaPlurnk as Record<string, unknown>,
            ...(terminalIds.length > 0 ? { terminalIds } : {}),
        });
        // {§cli-rendering}, {§cli-session-status} — Only open runtime streams (never synchronous verbs in OPERATION_GLYPH_MAP)
        // enter activeStreams while in_progress.
        if (effectiveStatus === "in_progress" && !(opName.toLowerCase() in OPERATION_GLYPH_MAP)) {
            const existing =
                internals.activeStreams.get(update.toolCallId) ??
                [...internals.activeStreams.values()].find(
                    (st) =>
                        st.target === streamTarget ||
                        (entryId !== null && st.entryId === entryId),
                );
            if (existing !== undefined && existing.key !== update.toolCallId) {
                internals.activeStreams.delete(existing.key);
            }
            const openedTurn =
                typeof metaPlurnk.turnSeq === "number" && metaPlurnk.turnSeq > 0
                    ? metaPlurnk.turnSeq
                    : Math.max(1, state.turns);
            internals.activeStreams.set(update.toolCallId, {
                key: update.toolCallId,
                entryId: entryId ?? existing?.entryId ?? null,
                terminalIds: terminalIds.length > 0 ? terminalIds : (existing?.terminalIds ?? []),
                op: opName,
                target: streamTarget,
                aside: rawAside ?? existing?.aside ?? null,
                startedAt: existing?.startedAt ?? Date.now(),
                openedTurn: existing?.openedTurn ?? openedTurn,
                survivedTurn:
                    existing?.survivedTurn ??
                    (internals.replayingHistory || state.turns > openedTurn),
            });
        }
        if (opName === "wait") {
            state.doing = null;
        } else if (state.lifecycle === "running") {
            state.doing = {
                phase: "working",
                since: Date.now(),
                op: opName,
                target,
            };
        }
        if (state.lifecycle === "running" || opName === "wait") {
            frames.push({
                kind: "status_update",
                status: buildPresenterStatusBar(state, internals),
            });
        }
        return;
    }

    internals.pendingToolCalls.delete(update.toolCallId);
    internals.renderedToolCalls.add(update.toolCallId);
    internals.activeStreams.delete(update.toolCallId);
    if (typeof metaPlurnk.attrs?.stream === "string" && metaPlurnk.attrs.stream.length > 0) {
        for (const [k, st] of [...internals.activeStreams.entries()]) {
            if (st.target === metaPlurnk.attrs.stream) {
                internals.activeStreams.delete(k);
            }
        }
    }

    const problemRec =
        rawOutput?.problem && typeof rawOutput.problem === "object"
            ? (rawOutput.problem as {
                  type?: unknown;
                  detail?: unknown;
                  title?: unknown;
                  diagnostic?: unknown;
                  recovery?: unknown;
              })
            : undefined;

    const glyph = operationGlyphFor(opName);
    const aside = rawAside;
    const scope = extractScopeToken(rawInput?.lineMarker);
    const destination =
        opName === "copy" || opName === "move"
            ? extractRawString(rawInput?.destination)
            : null;
    const pattern =
        extractRawString(rawInput?.matcher) ?? extractRawString(rawInput?.pattern);
    const fields = extractToolFields(opName, rawInput);
    const count = receiptCountFor(opName, rawOutput);

    const receiptLines: string[] = [];
    const textReceiptLines: string[] = [];
    for (const c of update.content ?? []) {
        if (ToolCallContent.isContent(c)) {
            const txt = contentBlockToText(c.content);
            receiptLines.push(txt);
            if (!ContentBlock.isResourceLink(c.content)) {
                textReceiptLines.push(txt);
            }
        } else if (ToolCallContent.isDiff(c) && typeof c.patch?.text === "string") {
            receiptLines.push(c.patch.text);
        } else if (ToolCallContent.isSession(c)) {
            receiptLines.push(`[session] ${c.sessionId}`);
        }
    }

    const authoredBody = extractRawString(rawInput?.body);
    let noteBody: string | null = null;
    if (opName === "note") {
        if (authoredBody !== null) {
            noteBody = authoredBody;
        } else if (textReceiptLines.length > 0) {
            noteBody = textReceiptLines.join("\n");
        } else if (receiptLines.length > 0) {
            noteBody = receiptLines.join("\n");
        } else {
            noteBody = "";
        }
    }

    // Authored request bodies (edit, work, fork, and undelivered send/done/fail)
    // receive a preview beneath the row ({§cli-rendering}). Runtime executions render as
    // single-line receipts without request-body or stream-output previews.
    const isRuntimeExec = !(opName in OPERATION_GLYPH_MAP);
    const previewBody =
        authoredBody ?? (textReceiptLines.length > 0 ? textReceiptLines.join("\n") : null);
    const contentLines: string[] = [];
    if (
        !isRuntimeExec &&
        !NO_PREVIEW_VERBS.has(opName) &&
        previewBody !== null &&
        previewBody.trim().length > 0
    ) {
        contentLines.push(previewBody);
    }

    const outputLines: string[] = [];

    const statusCode =
        typeof metaPlurnk.status === "number" &&
        (concludedStreamCode === undefined || metaPlurnk.status !== 202)
            ? metaPlurnk.status
            : concludedStreamCode !== undefined
              ? concludedStreamCode
              : effectiveStatus === "failed"
                ? 500
                : 200;
    const failed = statusCode >= 400 || effectiveStatus === "failed";
    const problemParts: string[] = [];
    for (const candidate of [
        problemRec?.title,
        problemRec?.detail,
        problemRec?.diagnostic,
        problemRec?.recovery,
    ]) {
        if (typeof candidate !== "string") continue;
        const trimmedCandidate = candidate.trim();
        if (trimmedCandidate.length === 0) continue;
        if (
            problemParts.some(
                (existing) =>
                    existing.toLowerCase() === trimmedCandidate.toLowerCase() ||
                    existing.includes(trimmedCandidate),
            )
        ) {
            continue;
        }
        problemParts.push(trimmedCandidate);
    }
    const outcome = failed
        ? problemParts.length > 0
            ? problemParts.join(": ")
            : typeof rawOutput?.detail === "string" && rawOutput.detail.length > 0
              ? rawOutput.detail
              : typeof rawOutput?.message === "string" && rawOutput.message.length > 0
                ? rawOutput.message
                : String(statusCode)
        : statusCode === 204 &&
            count === null &&
            typeof rawOutput?.detail === "string" &&
            rawOutput.detail.length > 0
          ? rawOutput.detail
          : opName === "wait"
            ? typeof rawOutput?.detail === "string" && rawOutput.detail.length > 0
                ? rawOutput.detail
                : typeof metaPlurnk.attrs?.waiting === "number"
                  ? `${String(metaPlurnk.attrs.waiting)}s`
                  : typeof rawInput?.seconds === "number"
                    ? `${String(rawInput.seconds)}s`
                    : null
            : null;

    if (!internals.replayingHistory && WORKER_OPS.has(opName) && !failed) {
        const rawWorkerRef =
            target ??
            (typeof metaPlurnk.attrs?.session === "string" && metaPlurnk.attrs.session.length > 0
                ? metaPlurnk.attrs.session
                : update.toolCallId);
        const workerKey = normalizeWorkerKey(rawWorkerRef);
        const existing = internals.activeWorkers.get(workerKey);
        internals.activeWorkers.set(workerKey, {
            key: workerKey,
            glyph: OPERATION_GLYPH_MAP[opName] ?? "🐜",
            op: opName,
            target: target ?? existing?.target ?? `session:///${workerKey}`,
            startedAt: existing?.startedAt ?? Date.now(),
        });
    }

    if (opName === "wait") {
        state.doing = null;
        buildPresenterStatusBar(state, internals);
    } else if (state.lifecycle === "running") {
        state.doing = {
            phase: "working",
            since: Date.now(),
            op: opName,
            target,
        };
        buildPresenterStatusBar(state, internals);
    }

    frames.push({
        kind: "tool_call",
        toolCallId: update.toolCallId,
        glyph,
        op: opName,
        origin,
        title: effectiveTitle ?? effectiveName ?? update.toolCallId,
        target,
        scope,
        destination,
        pattern,
        fields,
        count,
        aside,
        noteBody,
        status: effectiveStatus ?? "completed",
        statusCode,
        outcome,
        contentLines,
        outputLines,
    });
};

export const projectTerminalUpdate = (
    internals: PresenterInternals,
    update: Extract<SessionUpdate, { readonly sessionUpdate: "terminal_update" }>,
): void => {
    if (update.exitStatus === undefined) return;
    const metaPlurnk = (
        update._meta as { plurnk?: { target?: string; opId?: number } } | undefined
    )?.plurnk;
    const concludedTarget = metaPlurnk?.target;
    const opId = metaPlurnk?.opId;
    const exitCode = update.exitStatus?.exitCode;
    const concludedCode =
        typeof exitCode === "number"
            ? exitCode === 0
                ? 200
                : exitCode >= 400
                  ? exitCode
                  : 500
            : (update as { status?: unknown }).status === "failed"
              ? 500
              : 200;
    internals.concludedStreams.set(update.terminalId, concludedCode);
    if (typeof opId === "number") {
        internals.concludedStreams.set(`term:${String(opId)}`, concludedCode);
    }
    if (typeof concludedTarget === "string" && concludedTarget.length > 0) {
        internals.concludedStreams.set(concludedTarget, concludedCode);
        internals.openStreamKeys.delete(concludedTarget);
    }
    for (const [k, st] of [...internals.activeStreams.entries()]) {
        if (
            st.terminalIds.includes(update.terminalId) ||
            (st.entryId !== null && `term:${String(st.entryId)}` === update.terminalId) ||
            (typeof opId === "number" && st.entryId === opId) ||
            (typeof concludedTarget === "string" &&
                concludedTarget.length > 0 &&
                st.target === concludedTarget)
        ) {
            internals.activeStreams.delete(k);
        }
    }
};

export const projectTerminalOutputChunk = (
    internals: PresenterInternals,
    update: Extract<SessionUpdate, { readonly sessionUpdate: "terminal_output_chunk" }>,
    frames: PresentationFrame[],
): void => {
    const metaPlurnk = (update._meta as { plurnk?: { target?: string; opId?: number } } | undefined)?.plurnk;
    const target = metaPlurnk?.target ?? update.terminalId;
    internals.lastStreamTarget = target;
    let decodedText = update.data;
    try {
        decodedText = Buffer.from(update.data, "base64").toString("utf8");
    } catch {
        decodedText = update.data;
    }
    frames.push({
        kind: "terminal_output",
        terminalId: update.terminalId,
        target,
        rawData: update.data,
        decodedText,
    });
};

export const projectSubagentUpdate = (
    internals: PresenterInternals,
    update: Extract<SessionUpdate, { readonly sessionUpdate: "subagent_update" }>,
    frames: PresentationFrame[],
): void => {
    const subState =
        update.state && typeof update.state === "object" && "state" in update.state
            ? String(update.state.state)
            : "running";
    const workerKey = normalizeWorkerKey(update.title ?? update.sessionId);
    if (
        subState === "running" ||
        subState === "queued" ||
        subState === "parked" ||
        subState === "requires_action"
    ) {
        const existing = internals.activeWorkers.get(workerKey);
        internals.activeWorkers.set(workerKey, {
            key: workerKey,
            glyph: existing?.glyph ?? "🐜",
            op: existing?.op ?? "work",
            target: existing?.target ?? `session:///${workerKey}`,
            startedAt: existing?.startedAt ?? Date.now(),
        });
    } else {
        internals.activeWorkers.delete(workerKey);
    }
    frames.push({
        kind: "subagent",
        sessionId: update.sessionId,
        title: update.title ?? update.sessionId,
        state: subState,
        description: update.description,
    });
};
