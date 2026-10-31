// Pure ACP v2 client-side session state & stream materializer.
// Consumes standard `session/update` notifications identically during `session/resume`
// replay and live turns.

import {
    ContentBlock,
    SessionUpdate,
    StateUpdate,
    type AvailableCommand,
    type NoticeSeverity,
    type PlanUpdateContent,
    type SessionConfigOption,
    type TerminalExitStatus,
    type ToolCallContent,
    type ToolCallLocation,
    type ToolCallStatus,
    type ToolKind,
    type UpdateSessionNotification,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";

export type MetaRecord = Record<string, unknown>;

export const patchMeta = (
    current: MetaRecord | undefined,
    patch: Record<string, unknown> | null | undefined,
): MetaRecord | undefined => {
    if (patch === undefined) return current;
    if (patch === null) return undefined;
    const keys = Object.keys(patch);
    if (keys.length === 0) return current;
    const next: MetaRecord = { ...(current ?? {}) };
    for (const key of keys) {
        const val = patch[key];
        if (val === null) {
            delete next[key];
        } else {
            next[key] = val;
        }
    }
    return Object.keys(next).length > 0 ? next : undefined;
};

export const contentBlockToText = (content: ContentBlock): string => {
    if (ContentBlock.isText(content)) {
        return content.text;
    }
    if (ContentBlock.isResourceLink(content)) {
        return `[${content.name ?? content.uri}](${content.uri})`;
    }
    if (ContentBlock.isResource(content)) {
        const res = content.resource;
        if ("text" in res && typeof res.text === "string") {
            return res.text;
        }
        return `[resource: ${res.uri}]`;
    }
    if (ContentBlock.isImage(content)) {
        return `[image: ${content.mimeType}]`;
    }
    if (ContentBlock.isAudio(content)) {
        return `[audio: ${content.mimeType}]`;
    }
    return "";
};

export interface AcpMessageItem {
    readonly kind: "user_message" | "agent_thought" | "agent_message";
    readonly id?: string;
    text: string;
    blocks: ContentBlock[];
    meta?: MetaRecord;
}

export interface AcpToolCallState {
    readonly kind: "tool_call";
    readonly toolCallId: string;
    name?: string | null;
    title?: string | null;
    toolKind?: ToolKind | null;
    status?: ToolCallStatus | null;
    locations: ToolCallLocation[];
    content: ToolCallContent[];
    rawInput?: unknown;
    rawOutput?: unknown;
    meta?: MetaRecord;
}

export interface AcpTerminalState {
    readonly kind: "terminal";
    readonly terminalId: string;
    command?: string | null;
    cwd?: string | null;
    outputText: string;
    exitStatus?: TerminalExitStatus | null;
    meta?: MetaRecord;
}

export interface AcpPlanState {
    readonly kind: "plan";
    plan: PlanUpdateContent;
    meta?: MetaRecord;
}

export interface AcpSubagentState {
    readonly kind: "subagent";
    readonly sessionId: string;
    title?: string | null;
    description?: string | null;
    state?: string | null;
    meta?: MetaRecord;
}

export interface AcpNoticeItem {
    readonly kind: "notice";
    readonly severity: NoticeSeverity;
    readonly title: string;
    readonly description?: string | null;
    readonly meta?: MetaRecord;
}

export type AcpTranscriptItem =
    | AcpMessageItem
    | AcpToolCallState
    | AcpTerminalState
    | AcpPlanState
    | AcpSubagentState
    | AcpNoticeItem;

export interface AcpUsageSnapshot {
    readonly used: number;
    readonly size: number;
    readonly cost?: {
        readonly amount: number;
        readonly currency: string;
    } | null;
    readonly meta?: MetaRecord;
}

export type AcpSessionEventListener = (update: SessionUpdate, session: AcpSession) => void;

export class AcpSession {
    readonly sessionId: string;
    state: string = "idle";
    stopReason: string | undefined = undefined;
    title: string | null = null;
    configOptions: SessionConfigOption[] = [];
    availableCommands: AvailableCommand[] = [];
    usage: AcpUsageSnapshot | null = null;
    meta: MetaRecord | undefined = undefined;
    lastStateMeta: MetaRecord | undefined = undefined;
    readonly items: AcpTranscriptItem[] = [];
    readonly toolCalls = new Map<string, AcpToolCallState>();
    readonly terminals = new Map<string, AcpTerminalState>();
    readonly subagents = new Map<string, AcpSubagentState>();
    #activeStreamMessage: AcpMessageItem | null = null;
    readonly #listeners = new Set<AcpSessionEventListener>();
    readonly #disposeCallbacks = new Set<() => void>();

    constructor(
        sessionId: string,
        initial?: {
            configOptions?: SessionConfigOption[] | null;
            meta?: MetaRecord | null;
        },
    ) {
        this.sessionId = sessionId;
        if (initial?.configOptions) {
            this.configOptions = [...initial.configOptions];
        }
        if (initial?.meta) {
            this.meta = { ...initial.meta };
        }
    }

    onUpdate(listener: AcpSessionEventListener): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    onDispose(cb: () => void): () => void {
        this.#disposeCallbacks.add(cb);
        return () => {
            this.#disposeCallbacks.delete(cb);
        };
    }

    dispose(): void {
        this.#activeStreamMessage = null;
        this.#listeners.clear();
        for (const cb of [...this.#disposeCallbacks]) {
            this.#disposeCallbacks.delete(cb);
            cb();
        }
    }

    endActiveStream(): void {
        this.#activeStreamMessage = null;
    }

    #findMessageItem(
        kind: AcpMessageItem["kind"],
        id: string | undefined,
        meta: MetaRecord | undefined,
    ): AcpMessageItem | undefined {
        const plurnk = (meta?.plurnk ?? undefined) as
            | { id?: unknown; coordinate?: unknown }
            | undefined;
        const coord =
            typeof plurnk?.coordinate === "string" && plurnk.coordinate.length > 0
                ? plurnk.coordinate
                : undefined;
        const entryId = typeof plurnk?.id === "number" ? plurnk.id : undefined;
        if (id === undefined && coord === undefined && entryId === undefined) {
            return undefined;
        }
        for (const item of this.items) {
            if (item.kind !== kind) continue;
            if (id !== undefined && item.id === id) return item;
            const itemPlurnk = (item.meta?.plurnk ?? undefined) as
                | { id?: unknown; coordinate?: unknown }
                | undefined;
            if (coord !== undefined && itemPlurnk?.coordinate === coord) return item;
            if (entryId !== undefined && itemPlurnk?.id === entryId) return item;
        }
        return undefined;
    }

    applyNotification(notification: UpdateSessionNotification): void {
        if (notification.sessionId !== this.sessionId) return;
        this.applyUpdate(notification.update);
    }

    applyUpdate(update: SessionUpdate): void {
        if (
            SessionUpdate.isUserMessage(update) ||
            SessionUpdate.isAgentThought(update) ||
            SessionUpdate.isAgentMessage(update)
        ) {
            this.#activeStreamMessage = null;
            const blocks = [...(update.content ?? [])];
            const text = blocks.map(contentBlockToText).join("");
            const id = "messageId" in update && typeof update.messageId === "string" && update.messageId.length > 0
                ? update.messageId
                : undefined;
            const incomingMeta = patchMeta(undefined, update._meta);
            const existing = this.#findMessageItem(update.sessionUpdate, id, incomingMeta);
            if (existing !== undefined) {
                const incomingPlurnk = (incomingMeta?.plurnk ?? undefined) as Record<string, unknown> | undefined;
                const existingPlurnk = (existing.meta?.plurnk ?? undefined) as Record<string, unknown> | undefined;
                if (incomingPlurnk?.published === false && existingPlurnk?.published !== false) {
                    return;
                }
                const wasUnpublished = existingPlurnk?.published === false && incomingPlurnk?.published !== false;
                if (!wasUnpublished && existing.text.startsWith(text)) {
                    existing.meta = patchMeta(existing.meta, update._meta);
                    return;
                }
                if (wasUnpublished || text.startsWith(existing.text)) {
                    existing.meta = patchMeta(existing.meta, update._meta);
                    existing.text = text;
                    existing.blocks = blocks;
                } else {
                    const item: AcpMessageItem = {
                        kind: update.sessionUpdate,
                        ...(id !== undefined ? { id } : {}),
                        text,
                        blocks,
                        meta: incomingMeta,
                    };
                    this.items.push(item);
                }
            } else {
                const item: AcpMessageItem = {
                    kind: update.sessionUpdate,
                    ...(id !== undefined ? { id } : {}),
                    text,
                    blocks,
                    meta: incomingMeta,
                };
                this.items.push(item);
            }
        } else if (
            SessionUpdate.isUserMessageChunk(update) ||
            SessionUpdate.isAgentThoughtChunk(update) ||
            SessionUpdate.isAgentMessageChunk(update)
        ) {
            const targetKind = update.sessionUpdate === "user_message_chunk"
                ? "user_message"
                : update.sessionUpdate === "agent_thought_chunk"
                    ? "agent_thought"
                    : "agent_message";
            const chunkId = typeof update.messageId === "string" && update.messageId.length > 0
                ? update.messageId
                : undefined;
            const chunkText = contentBlockToText(update.content);
            const incomingMeta = patchMeta(undefined, update._meta);
            const incomingPlurnk = (incomingMeta?.plurnk ?? undefined) as Record<string, unknown> | undefined;
            const activePlurnk = (this.#activeStreamMessage?.meta?.plurnk ?? undefined) as
                | Record<string, unknown>
                | undefined;
            const isSameLogEntryAsActive =
                this.#activeStreamMessage !== null &&
                ((typeof incomingPlurnk?.id === "number" && incomingPlurnk.id === activePlurnk?.id) ||
                    (typeof incomingPlurnk?.coordinate === "string" &&
                        incomingPlurnk.coordinate.length > 0 &&
                        incomingPlurnk.coordinate === activePlurnk?.coordinate));

            if (
                this.#activeStreamMessage !== null &&
                this.#activeStreamMessage.kind === targetKind &&
                !isSameLogEntryAsActive &&
                (chunkId === undefined ||
                    this.#activeStreamMessage.id === undefined ||
                    this.#activeStreamMessage.id === chunkId)
            ) {
                this.#activeStreamMessage.text += chunkText;
                this.#activeStreamMessage.blocks.push(update.content);
                this.#activeStreamMessage.meta = patchMeta(this.#activeStreamMessage.meta, update._meta);
            } else {
                const existing = this.#findMessageItem(targetKind, chunkId, incomingMeta);
                if (existing !== undefined) {
                    const existingPlurnk = (existing.meta?.plurnk ?? undefined) as
                        | Record<string, unknown>
                        | undefined;
                    if (incomingPlurnk?.published === false && existingPlurnk?.published !== false) {
                        return;
                    }
                    const wasUnpublished =
                        existingPlurnk?.published === false && incomingPlurnk?.published !== false;
                    if (!wasUnpublished && existing.text.startsWith(chunkText)) {
                        existing.meta = patchMeta(existing.meta, update._meta);
                        return;
                    }
                    if (wasUnpublished || chunkText.startsWith(existing.text)) {
                        existing.meta = patchMeta(existing.meta, update._meta);
                        existing.text = chunkText;
                        existing.blocks = [update.content];
                    } else {
                        const item: AcpMessageItem = {
                            kind: targetKind,
                            ...(chunkId !== undefined ? { id: chunkId } : {}),
                            text: chunkText,
                            blocks: [update.content],
                            meta: incomingMeta,
                        };
                        this.#activeStreamMessage = item;
                        this.items.push(item);
                    }
                } else {
                    const item: AcpMessageItem = {
                        kind: targetKind,
                        ...(chunkId !== undefined ? { id: chunkId } : {}),
                        text: chunkText,
                        blocks: [update.content],
                        meta: incomingMeta,
                    };
                    this.#activeStreamMessage = item;
                    this.items.push(item);
                }
            }
        } else if (SessionUpdate.isToolCallUpdate(update)) {
            this.#activeStreamMessage = null;
            let tc = this.toolCalls.get(update.toolCallId);
            const isNew = tc === undefined;
            const prevStatus = tc?.status;
            const prevHasOutput = tc?.rawOutput !== undefined;
            const prevContentLen = tc?.content.length ?? 0;
            const prevTitle = tc?.title;
            const prevName = tc?.name;
            if (tc === undefined) {
                tc = {
                    kind: "tool_call",
                    toolCallId: update.toolCallId,
                    locations: [],
                    content: [],
                };
                this.toolCalls.set(update.toolCallId, tc);
                this.items.push(tc);
            }
            if (update.name !== undefined) tc.name = update.name;
            if (update.title !== undefined) tc.title = update.title;
            if (update.kind !== undefined) tc.toolKind = update.kind;
            if (
                update.status !== undefined &&
                !(
                    (tc.status === "completed" || tc.status === "failed") &&
                    (update.status === "in_progress" || update.status === "pending")
                )
            ) {
                tc.status = update.status;
            }
            if (update.locations !== undefined && update.locations !== null) {
                tc.locations = [...update.locations];
            }
            if (update.content !== undefined && update.content !== null) {
                tc.content = [...update.content];
            }
            if (update.rawInput !== undefined) tc.rawInput = update.rawInput;
            if (update.rawOutput !== undefined) tc.rawOutput = update.rawOutput;
            tc.meta = patchMeta(tc.meta, update._meta);
            if (
                !isNew &&
                (prevStatus === "completed" || prevStatus === "failed") &&
                tc.status === prevStatus &&
                tc.title === prevTitle &&
                tc.name === prevName &&
                (update.rawOutput === undefined || prevHasOutput) &&
                tc.content.length === prevContentLen
            ) {
                return;
            }
        } else if (SessionUpdate.isToolCallContentChunk(update)) {
            this.#activeStreamMessage = null;
            let tc = this.toolCalls.get(update.toolCallId);
            if (tc === undefined) {
                tc = {
                    kind: "tool_call",
                    toolCallId: update.toolCallId,
                    locations: [],
                    content: [],
                };
                this.toolCalls.set(update.toolCallId, tc);
                this.items.push(tc);
            }
            tc.content.push(update.content);
        } else if (SessionUpdate.isTerminalUpdate(update)) {
            this.#activeStreamMessage = null;
            let term = this.terminals.get(update.terminalId);
            const isNew = term === undefined;
            const prevOutput = term?.outputText ?? "";
            const prevExitCode = term?.exitStatus?.exitCode;
            if (term === undefined) {
                term = {
                    kind: "terminal",
                    terminalId: update.terminalId,
                    outputText: "",
                };
                this.terminals.set(update.terminalId, term);
                this.items.push(term);
            }
            if (update.command !== undefined) term.command = update.command;
            if (update.cwd !== undefined) term.cwd = update.cwd;
            if (update.output !== undefined) {
                term.outputText = update.output === null
                    ? ""
                    : Buffer.from(update.output.data, "base64").toString("utf8");
            }
            if (update.exitStatus !== undefined) term.exitStatus = update.exitStatus;
            term.meta = patchMeta(term.meta, update._meta);
            if (
                !isNew &&
                term.outputText === prevOutput &&
                term.exitStatus?.exitCode === prevExitCode &&
                prevExitCode !== undefined
            ) {
                return;
            }
        } else if (SessionUpdate.isTerminalOutputChunk(update)) {
            let term = this.terminals.get(update.terminalId);
            if (term === undefined) {
                term = {
                    kind: "terminal",
                    terminalId: update.terminalId,
                    outputText: "",
                };
                this.terminals.set(update.terminalId, term);
                this.items.push(term);
            } else if (term.exitStatus !== undefined && term.exitStatus !== null) {
                return;
            }
            term.outputText += Buffer.from(update.data, "base64").toString("utf8");
        } else if (SessionUpdate.isPlanUpdate(update)) {
            this.#activeStreamMessage = null;
            const existing = this.items.find((item): item is AcpPlanState => item.kind === "plan");
            if (existing !== undefined) {
                existing.plan = update.plan;
                existing.meta = patchMeta(existing.meta, update._meta);
            } else {
                this.items.push({
                    kind: "plan",
                    plan: update.plan,
                    meta: patchMeta(undefined, update._meta),
                });
            }
        } else if (SessionUpdate.isPlanRemoved(update)) {
            const idx = this.items.findIndex((item) => item.kind === "plan");
            if (idx >= 0) this.items.splice(idx, 1);
        } else if (SessionUpdate.isSubagentUpdate(update)) {
            let sub = this.subagents.get(update.sessionId);
            if (sub === undefined) {
                sub = {
                    kind: "subagent",
                    sessionId: update.sessionId,
                };
                this.subagents.set(update.sessionId, sub);
                this.items.push(sub);
            }
            if (update.title !== undefined) sub.title = update.title;
            if (update.description !== undefined) sub.description = update.description;
            if (update.state !== undefined) {
                sub.state = update.state === null ? null : update.state.state;
            }
            sub.meta = patchMeta(sub.meta, update._meta);
        } else if (SessionUpdate.isConfigOptionUpdate(update)) {
            this.configOptions = [...update.configOptions];
        } else if (SessionUpdate.isAvailableCommandsUpdate(update)) {
            this.availableCommands = [...update.availableCommands];
        } else if (SessionUpdate.isSessionInfoUpdate(update)) {
            if (update.title !== undefined) {
                this.title = update.title;
            }
        } else if (SessionUpdate.isUsageUpdate(update)) {
            this.usage = {
                used: update.used,
                size: update.size,
                ...(update.cost !== undefined ? { cost: update.cost } : {}),
                meta: patchMeta(undefined, update._meta),
            };
        } else if (SessionUpdate.isNotice(update)) {
            this.#activeStreamMessage = null;
            this.items.push({
                kind: "notice",
                severity: update.severity,
                title: update.title,
                ...(update.description !== undefined ? { description: update.description } : {}),
                meta: patchMeta(undefined, update._meta),
            });
        } else if (SessionUpdate.isStateUpdate(update)) {
            this.#activeStreamMessage = null;
            this.state = update.state;
            this.lastStateMeta = patchMeta(
                undefined,
                (update as { _meta?: Record<string, unknown> | null })._meta,
            );
            if (StateUpdate.isIdle(update)) {
                this.stopReason = typeof update.stopReason === "string"
                    ? update.stopReason
                    : undefined;
            } else {
                this.stopReason = undefined;
            }
        }

        for (const listener of this.#listeners) {
            listener(update, this);
        }
    }

    lastAgentMessageText(): string {
        for (let i = this.items.length - 1; i >= 0; i -= 1) {
            const item = this.items[i];
            if (item?.kind === "agent_message") {
                return item.text;
            }
        }
        return "";
    }
}
