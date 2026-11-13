// Terminal substrate on `@earendil-works/pi-tui` ({§cli-repl-mode},
// {§cli-color-policy}, {§cli-rendering}, {§cli-markdown-projection}).

import { stripVTControlCharacters } from "node:util";
import {
    Container,
    CURSOR_MARKER,
    Editor,
    getKeybindings,
    ProcessTerminal,
    renderFakeCursor,
    Spacer,
    Text,
    truncateToWidth,
    TuiMainScreen,
    visibleWidth,
    type AutocompleteProvider,
    type Component,
    type EditorOptions,
    type EditorTheme,
    type Terminal,
    type TerminalColorScheme,
    type TerminalColors,
    type TUI,
    type TuiInputListener,
} from "@earendil-works/pi-tui";
import {
    attention,
    backgroundScheme,
    bell,
    buildHeader,
    colorEnabled,
    colorFgBgScheme,
    concluded,
    editorTheme,
    hyperlink,
    isColorMode,
    learnScheme,
    ModelText,
    paint,
    renderSubmittedInput,
    resumeCommand,
    styled,
    windowTitle,
    withColorOutput,
    type AttentionReason,
    type AttentionSink,
    type ColorOutput,
    type Role,
} from "./color.ts";
import {
    formatCompactCount,
    formatDurationSummary,
    formatLoopMetrics,
    markdownTheme,
    previewLines,
    renderActiveLiveLine,
    renderLoopSummary,
    renderMarkdownDocument,
    renderMermaid,
    renderModelReply,
    renderNoteBlock,
    renderOperationBlock,
    renderReasoning,
} from "./markdown.ts";

export {
    attention,
    backgroundScheme,
    bell,
    buildHeader,
    colorEnabled,
    colorFgBgScheme,
    concluded,
    editorTheme,
    formatCompactCount,
    formatDurationSummary,
    formatLoopMetrics,
    hyperlink,
    isColorMode,
    learnScheme,
    markdownTheme,
    ModelText,
    paint,
    previewLines,
    renderActiveLiveLine,
    renderLoopSummary,
    renderMarkdownDocument,
    renderMermaid,
    renderModelReply,
    renderNoteBlock,
    renderOperationBlock,
    renderReasoning,
    renderSubmittedInput,
    resumeCommand,
    windowTitle,
    withColorOutput,
    type AttentionReason,
    type AttentionSink,
    type ColorOutput,
    type Role,
};

// {§cli-session-status} — Single-line muted footer/banner that truncates to terminal width instead of wrapping.
class SingleLineText implements Component {
    #text = "";

    setText(text: string): void {
        this.#text = text;
    }

    invalidate(): void {}

    render(width: number): string[] {
        const normalized = this.#text.replace(/\t/gu, "   ");
        if (normalized.trim().length === 0) return [];
        const single = normalized.split("\n", 1)[0] ?? "";
        const safeWidth = Math.max(1, width);
        return [styled("dim")(truncateToWidth(single, safeWidth, "…", true))];
    }
}

type CoordinateTuple = readonly [number, number, number];

const parseCoordinate = (id: string | null | undefined): CoordinateTuple | null => {
    if (typeof id !== "string") return null;
    const m = /^(\d+)\/(\d+)\/(\d+)$/u.exec(id.trim());
    if (!m) return null;
    const loopSeq = Number(m[1]);
    const turnSeq = Number(m[2]);
    const seq = Number(m[3]);
    if (!Number.isSafeInteger(loopSeq) || !Number.isSafeInteger(turnSeq) || !Number.isSafeInteger(seq)) {
        return null;
    }
    return [loopSeq, turnSeq, seq];
};

const compareCoordinates = (a: CoordinateTuple, b: CoordinateTuple): number => {
    if (a[0] !== b[0]) return a[0] - b[0];
    if (a[1] !== b[1]) return a[1] - b[1];
    return a[2] - b[2];
};

// {§cli-rendering} {§cli-session-status} — Anchored transcript slot for in-place operation materialization.
class TranscriptSlot implements Component {
    readonly epoch: number;
    readonly coordinate: CoordinateTuple | null;
    #inner: Text | null = null;
    #rawText = "";
    #trailingBlankLine = false;

    constructor(epoch: number, coordinate: CoordinateTuple | null, text = "", trailingBlankLine = false) {
        this.epoch = epoch;
        this.coordinate = coordinate;
        if (text.length > 0) {
            this.setText(text, trailingBlankLine);
        }
    }

    get rawText(): string {
        return this.#rawText;
    }

    get hasContent(): boolean {
        return this.#inner !== null;
    }

    get trailingBlankLine(): boolean {
        return this.#trailingBlankLine;
    }

    setText(text: string, trailingBlankLine = false): void {
        const normalized = text.replace(/\n$/u, "");
        this.#rawText = normalized;
        this.#trailingBlankLine = trailingBlankLine && normalized.length > 0;
        if (normalized.length === 0) {
            this.#inner = null;
        } else if (this.#inner !== null) {
            this.#inner.setText(normalized);
        } else {
            this.#inner = new Text(normalized, 0, 0);
        }
    }

    invalidate(): void {
        this.#inner?.invalidate();
    }

    render(width: number): string[] {
        if (this.#inner === null) return [];
        const lines = this.#inner.render(width);
        if (this.#trailingBlankLine && lines.length > 0) {
            return [...lines, ""];
        }
        return lines;
    }
}

// Live reasoning ticker (at most 3 rolling lines) plus 1 active streams/workers strip above the composer ({§cli-markdown-projection}, {§cli-rendering}).
export class TailText implements Component {
    #text = "";
    #activity = "";
    #reserved = false;
    readonly #maxLines: () => number;

    constructor(maxLines: () => number = () => 3) {
        this.#maxLines = maxLines;
    }

    get hasText(): boolean {
        return this.#text.length > 0;
    }

    get hasActivity(): boolean {
        return this.#activity.length > 0;
    }

    get reserved(): boolean {
        return this.#reserved;
    }

    setText(text: string): void {
        this.#text = text;
    }

    setActivity(activity: string): void {
        this.#activity = activity;
    }

    setReserved(reserved: boolean): void {
        this.#reserved = reserved;
    }

    invalidate(): void {}

    render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        const max = Math.max(1, this.#maxLines());
        let reasoningLines: string[] = [];
        if (this.#text.length > 0) {
            const rawLines = this.#text.replace(/\t/gu, "   ").split("\n");
            const tailRaw = rawLines.length <= max ? rawLines : rawLines.slice(rawLines.length - max);
            reasoningLines = tailRaw.map((line) => truncateToWidth(line, safeWidth, "…"));
        }
        let activityLine = "";
        if (this.#activity.length > 0) {
            const singleActivity = this.#activity.replace(/\t/gu, "   ").split("\n", 1)[0] ?? "";
            activityLine = truncateToWidth(singleActivity, safeWidth, "…");
        }
        if (this.#reserved) {
            const paddedReasoning = [
                ...reasoningLines,
                ...Array.from({ length: Math.max(0, max - reasoningLines.length) }, () => ""),
            ];
            return [...paddedReasoning, activityLine];
        }
        const out: string[] = [...reasoningLines];
        if (activityLine.length > 0) {
            out.push(activityLine);
        }
        return out;
    }
}

export interface ComposerHintState {
    readonly yolo?: boolean;
    readonly mode?: string | null;
    readonly persona?: string | null;
    readonly childModel?: string | null;
}

export const formatComposerHint = (state: ComposerHintState = {}): string => {
    const segments: string[] = [];
    if (typeof state.persona === "string" && state.persona.length > 0 && state.persona !== "none") {
        segments.push(`persona:${state.persona}`);
    }
    if (
        typeof state.childModel === "string" &&
        state.childModel.length > 0 &&
        state.childModel !== "inherit"
    ) {
        segments.push(`child:${state.childModel}`);
    }
    if (state.mode === "deny") {
        segments.push("mode:deny");
    }
    const yoloOn = state.yolo === true || state.mode === "allow";
    if (yoloOn) {
        segments.push("yolo: on (Shift-Tab)", "?review");
    } else {
        segments.push("yolo: off (Shift-Tab)");
    }
    segments.push("!cmd", "@file", "/help");
    return segments.join(" · ");
};

const EMPTY_COMPOSER_HINT = formatComposerHint();

class ComposerEditor extends Editor {
    #placeholder: string;

    constructor(tui: TUI, theme: EditorTheme, options: EditorOptions, placeholder = "") {
        super(tui, theme, options);
        this.#placeholder = placeholder;
    }

    get placeholder(): string {
        return this.#placeholder;
    }

    setPlaceholder(placeholder: string): boolean {
        if (this.#placeholder === placeholder) return false;
        this.#placeholder = placeholder;
        return true;
    }

    override render(width: number): string[] {
        const lines = super.render(width);
        if (this.#placeholder.length === 0 || this.getText().length > 0 || lines.length < 3 || width <= 2) {
            return lines;
        }
        const safeHint = truncateToWidth(this.#placeholder, Math.max(1, width), "…", true);
        const firstChar = [...safeHint][0] ?? " ";
        const rest = safeHint.slice(firstChar.length);
        const marker = this.focused ? CURSOR_MARKER : "";
        const lead = `${marker}${renderFakeCursor(styled("dim")(firstChar))}${rest.length > 0 ? styled("dim")(rest) : ""}`;
        const pad = " ".repeat(Math.max(0, width - visibleWidth(safeHint)));
        const copy = [...lines];
        copy[1] = `${lead}${pad}`;
        return copy;
    }
}

export default class TermSurface {
    readonly #terminal: Terminal;
    readonly #screen: TuiMainScreen;
    readonly #transcript = new Container();
    readonly #live = new TailText(() => 3);
    readonly #turn = new Container();
    #turnResponses: Array<{ text: string; coordinate: CoordinateTuple | null }> = [];
    #slotEpoch = 0;
    readonly #toolCallSlots = new Map<string, TranscriptSlot>();
    #lastLoopHamster: TranscriptSlot | null = null;
    #promptHistory: string[] = [];
    readonly #status = new SingleLineText();
    readonly #input = new Container();
    readonly #pending = new SingleLineText();
    readonly #composer: ComposerEditor;
    readonly editor: Editor;
    #review: Component | null = null;
    #reviewing = false;
    #dialog: Component | null = null;
    #started = false;
    #titled = false;
    #lastWasSpacer = false;

    constructor(terminal: Terminal = new ProcessTerminal()) {
        getKeybindings().setUserBindings({
            "tui.input.submit": ["enter", "ctrl+enter", "super+enter"],
            "tui.select.confirm": ["enter", "ctrl+enter", "super+enter"],
        });
        this.#terminal = terminal;
        this.#screen = new TuiMainScreen(terminal, true);
        this.#composer = new ComposerEditor(
            this.#screen,
            editorTheme,
            { paddingX: 0, autocompleteMaxVisible: 8 },
            EMPTY_COMPOSER_HINT,
        );
        this.editor = this.#composer;
        this.#input.addChild(this.editor);
        this.#screen.addChild(this.#transcript);
        this.#screen.addChild(this.#turn);
        this.#screen.addChild(this.#live);
        this.#screen.addChild(this.#input);
        this.#screen.addChild(this.#status);
        this.#screen.setFocus(this.editor);
        this.#screen.onTerminalColorSchemeChange((scheme) => this.#askScheme(scheme));
    }

    get columns(): number {
        return this.#terminal.columns;
    }

    get rows(): number {
        return this.#terminal.rows;
    }

    get chromeChildCount(): number {
        return this.#screen.children.length;
    }

    renderLiveLines(width = this.#terminal.columns): string[] {
        return this.#live.render(width);
    }

    renderStatusLines(width = this.#terminal.columns): string[] {
        return this.#status.render(width);
    }

    createEditor(placeholder = ""): Editor {
        return new ComposerEditor(this.#screen, editorTheme, { paddingX: 0, autocompleteMaxVisible: 8 }, placeholder);
    }

    get reviewing(): boolean {
        return this.#reviewing;
    }

    get dialogOpen(): boolean {
        return this.#dialog !== null;
    }

    requestRender(): void {
        this.#screen.requestRender();
    }

    renderNow(): void {
        if (this.#started) {
            this.#screen.renderNow();
        }
    }

    setDialog(component: Component | null): void {
        if (component !== null && this.#dialog !== null) {
            throw new Error("An input dialog is already open.");
        }
        this.#dialog = component;
        this.#showInput();
    }

    get #focus(): Component {
        return this.#dialog ?? (this.#reviewing ? this.#review : null) ?? this.editor;
    }

    // {§cli-inline-review} — swap components, never reconstruct the composer's editing state.
    setReview(component: Component | null, count: number): void {
        if (component === null) {
            this.#reviewing = false;
        } else if (this.#review === null && this.editor.getText().length === 0) {
            this.#reviewing = true;
        }
        this.#review = component;
        this.#pending.setText(`${String(count)} pending review${count === 1 ? "" : "s"} · /review · /cancel`);
        this.#showInput();
    }

    openReview(): boolean {
        if (this.#review === null) return false;
        this.#reviewing = true;
        this.#showInput();
        return true;
    }

    leaveReview(): boolean {
        if (!this.#reviewing) return false;
        this.#reviewing = false;
        this.#showInput();
        return true;
    }

    #showInput(): void {
        this.#input.clear();
        if (this.#dialog !== null) {
            this.#input.addChild(this.#dialog);
        } else if (this.#reviewing && this.#review !== null) {
            this.#input.addChild(this.#review);
        } else {
            if (this.#review !== null) {
                this.#input.addChild(this.#pending);
            }
            this.#input.addChild(this.editor);
        }
        this.#screen.setFocus(this.#focus);
        this.#screen.requestRender();
    }

    start(): void {
        if (this.#started) return;
        this.#started = true;
        this.#screen.start();
        this.#screen.setFocus(this.#focus);
        if (colorEnabled()) {
            this.#screen.setTerminalColorSchemeNotifications(true);
            const apply = ({ background }: TerminalColors): void => {
                if (background !== undefined) {
                    learnScheme(backgroundScheme(background));
                    this.#screen.invalidate();
                    this.#screen.requestRender();
                }
            };
            void this.#screen.queryTerminalColors({ timeoutMs: 100, onLateReply: apply }).then(apply);
        }
    }

    async learnGround(): Promise<void> {
        if (!colorEnabled()) return;
        const probe = new TuiMainScreen(this.#terminal, true);
        probe.start();
        try {
            const { background } = await probe.queryTerminalColors({ timeoutMs: 100 });
            if (background !== undefined) {
                learnScheme(backgroundScheme(background));
            }
        } finally {
            probe.stop();
        }
    }

    #askScheme(reported: TerminalColorScheme): void {
        const apply = ({ background }: TerminalColors): void => {
            learnScheme(background === undefined ? reported : backgroundScheme(background));
            this.#screen.invalidate();
            this.#screen.requestRender();
        };
        void this.#screen.queryTerminalColors({ timeoutMs: 100, onLateReply: apply }).then(apply);
    }

    stop(): void {
        if (!this.#started) return;
        this.#started = false;
        try {
            this.#screen.renderNow();
        } finally {
            this.#screen.stop();
            this.clearTitle();
        }
    }

    setTitle(title: string): void {
        if (!this.#titled) {
            this.#terminal.write("\x1b[22;0t");
            this.#titled = true;
        }
        this.#terminal.setTitle(title);
    }

    clearTitle(): void {
        if (!this.#titled) return;
        this.#titled = false;
        this.#terminal.write("\x1b[23;0t");
    }

    resetToolCallSlots(): void {
        this.#slotEpoch += 1;
        this.#toolCallSlots.clear();
        this.#lastLoopHamster = null;
        this.#promptHistory = [];
    }

    #insertSlot(slot: TranscriptSlot): void {
        if (slot.coordinate !== null) {
            const idx = this.#transcript.children.findIndex(
                (child) =>
                    child instanceof TranscriptSlot &&
                    child.epoch === this.#slotEpoch &&
                    child.coordinate !== null &&
                    compareCoordinates(slot.coordinate!, child.coordinate) < 0,
            );
            if (idx >= 0) {
                this.#transcript.children.splice(idx, 0, slot);
                return;
            }
        }
        if (this.#turnResponses.length > 0) {
            const firstResponseCoord = this.#turnResponses[0]?.coordinate ?? null;
            const sameTurnEndSlot =
                slot.coordinate !== null &&
                firstResponseCoord !== null &&
                slot.coordinate[0] === firstResponseCoord[0] &&
                slot.coordinate[1] === firstResponseCoord[1] &&
                slot.coordinate[2] === Number.MAX_SAFE_INTEGER;
            if (
                !sameTurnEndSlot &&
                (slot.coordinate === null ||
                    firstResponseCoord === null ||
                    compareCoordinates(slot.coordinate, firstResponseCoord) >= 0)
            ) {
                this.archiveTurn();
            }
        }
        this.#transcript.addChild(slot);
        if (slot.hasContent) {
            this.#lastWasSpacer = slot.trailingBlankLine;
        }
    }

    reserveToolCall(toolCallId: string): void {
        if (toolCallId.length === 0 || this.#toolCallSlots.has(toolCallId)) return;
        const slot = new TranscriptSlot(this.#slotEpoch, parseCoordinate(toolCallId));
        this.#toolCallSlots.set(toolCallId, slot);
        this.#insertSlot(slot);
    }

    upsertToolCall(toolCallId: string, text: string, trailingBlankLine = false): void {
        const existing = this.#toolCallSlots.get(toolCallId);
        if (existing !== undefined) {
            existing.setText(text, trailingBlankLine);
            if (this.#transcript.children.at(-1) === existing) {
                this.#lastWasSpacer = existing.trailingBlankLine;
            }
            this.#status.invalidate();
            this.#screen.requestRender();
            return;
        }
        if (text.replace(/\n$/u, "").length === 0) {
            return;
        }
        const slot = new TranscriptSlot(
            this.#slotEpoch,
            parseCoordinate(toolCallId),
            text,
            trailingBlankLine,
        );
        if (toolCallId.length > 0) {
            this.#toolCallSlots.set(toolCallId, slot);
        }
        this.#insertSlot(slot);
        this.#status.invalidate();
        this.#screen.requestRender();
    }

    append(text: string): void {
        if (this.#turnResponses.length > 0) {
            this.archiveTurn();
        }
        const normalized = text.replace(/\n$/u, "");
        if (normalized.length === 0) {
            if (this.#lastWasSpacer) return;
            this.#transcript.addChild(new Spacer(1));
            this.#lastWasSpacer = true;
        } else {
            this.#transcript.addChild(new Text(normalized, 0, 0));
            this.#lastWasSpacer = false;
        }
        this.#status.invalidate();
        this.#screen.requestRender();
    }

    // {§cli-markdown-projection} — Turn responses sit between #transcript and #live during the turn, then archive to #transcript.
    addResponse(text: string, coordinate?: string | null): void {
        const normalized = text.replace(/\n$/u, "");
        if (normalized.length === 0) return;
        this.#turnResponses.push({
            text: normalized,
            coordinate: parseCoordinate(coordinate),
        });
        this.#turn.addChild(new Text(normalized, 0, 0));
        this.#status.invalidate();
        this.#screen.requestRender();
    }

    static #isReplyHeaderLine(firstLine: string): boolean {
        const plain = stripVTControlCharacters(firstLine).trim();
        return plain === "🐹" || /^\[[^\]\s]+\]$/u.test(plain);
    }

    static #decorateHamsterHeader(raw: string, summaryAside: string): string | null {
        const nl = raw.indexOf("\n");
        const firstLine = nl >= 0 ? raw.slice(0, nl) : raw;
        if (!TermSurface.#isReplyHeaderLine(firstLine)) {
            return null;
        }
        const decoratedFirst = `${firstLine} ${paint(summaryAside, "dim")}`;
        return nl >= 0 ? `${decoratedFirst}${raw.slice(nl)}` : decoratedFirst;
    }

    archiveTurn(summaryAside?: string | null): boolean {
        const isLoopConclusion = summaryAside !== undefined;
        if (this.#turnResponses.length === 0) {
            if (isLoopConclusion && this.#lastLoopHamster !== null) {
                const target = this.#lastLoopHamster;
                this.#lastLoopHamster = null;
                if (typeof summaryAside === "string" && summaryAside.length > 0) {
                    const decorated = TermSurface.#decorateHamsterHeader(target.rawText, summaryAside);
                    if (decorated !== null) {
                        target.setText(decorated, target.trailingBlankLine);
                        this.#status.invalidate();
                        this.#screen.requestRender();
                        return true;
                    }
                }
            } else if (isLoopConclusion) {
                this.#lastLoopHamster = null;
            }
            return false;
        }
        const responses = [...this.#turnResponses];
        this.#turnResponses = [];
        this.#turn.clear();
        let attachedSummary = false;
        if (typeof summaryAside === "string" && summaryAside.length > 0) {
            const lastIdx = responses.length - 1;
            const last = responses[lastIdx]!;
            const decorated = TermSurface.#decorateHamsterHeader(last.text, summaryAside);
            if (decorated !== null) {
                responses[lastIdx] = { ...last, text: decorated };
                attachedSummary = true;
            }
        }
        for (const item of responses) {
            const slot = new TranscriptSlot(this.#slotEpoch, item.coordinate, item.text);
            this.#transcript.addChild(slot);
            this.#lastWasSpacer = false;
            const firstLine = item.text.split("\n", 1)[0] ?? "";
            if (TermSurface.#isReplyHeaderLine(firstLine)) {
                this.#lastLoopHamster = slot;
            }
        }
        if (isLoopConclusion) {
            this.#lastLoopHamster = null;
        }
        this.#status.invalidate();
        this.#screen.requestRender();
        return attachedSummary;
    }

    setLive(text: string | null): void {
        this.#live.setText(text ?? "");
        this.#screen.requestRender();
    }

    setLiveActivity(text: string | null): void {
        this.#live.setActivity(text ?? "");
        this.#screen.requestRender();
    }

    setLoopActive(active: boolean): void {
        if (this.#live.reserved === active) return;
        this.#live.setReserved(active);
        this.#screen.requestRender();
    }

    setStatus(text: string): void {
        this.#status.setText(text);
        this.#screen.requestRender();
    }

    setPlaceholder(placeholder: string): void {
        if (this.#composer.setPlaceholder(placeholder)) {
            this.#screen.requestRender();
        }
    }

    setInput(text: string): void {
        this.editor.setText(text);
        this.#screen.requestRender();
    }

    insertInput(text: string): void {
        this.editor.insertTextAtCursor(text);
        this.#screen.requestRender();
    }

    recordPrompt(prompt: string): void {
        const trimmed = prompt.trim();
        if (trimmed.length === 0) return;
        if (this.#promptHistory.at(-1) === trimmed) return;
        this.#promptHistory.push(trimmed);
        this.editor.addToHistory(prompt);
    }

    recordPromptHistory(promptsChronological: readonly string[]): void {
        for (const prompt of promptsChronological) {
            this.recordPrompt(prompt);
        }
    }

    addHistory(promptsNewestFirst: readonly string[]): void {
        this.recordPromptHistory(promptsNewestFirst.toReversed());
    }

    setAutocompleteProvider(provider: AutocompleteProvider): void {
        this.editor.setAutocompleteProvider({
            ...provider,
            applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
                const lcp = (item as { readonly lcp?: string }).lcp;
                const res = provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
                if (typeof lcp === "string" && lcp.length > prefix.length) {
                    queueMicrotask(() => {
                        if (!this.editor.isShowingAutocomplete()) {
                            this.editor.handleInput("\t");
                        }
                    });
                }
                return res;
            },
        });
    }

    addInputListener(listener: TuiInputListener): () => void {
        return this.#screen.addInputListener(listener);
    }

    async handOff<T>(work: () => Promise<T> | T): Promise<T> {
        const wasStarted = this.#started;
        if (wasStarted) {
            this.#screen.stop();
        }
        try {
            return await work();
        } finally {
            if (wasStarted && this.#started) {
                this.#screen.start();
                this.#screen.setFocus(this.#focus);
                this.#screen.requestRender();
            }
        }
    }
}
