// Terminal substrate on `@earendil-works/pi-tui` ({§cli-repl-mode},
// {§cli-color-policy}, {§cli-rendering}, {§cli-markdown-projection}).

import { stripVTControlCharacters } from "node:util";
import {
    Container,
    Editor,
    getKeybindings,
    ProcessTerminal,
    Spacer,
    Text,
    TuiMainScreen,
    type AutocompleteProvider,
    type Component,
    type Terminal,
    type TerminalColorScheme,
    type TerminalColors,
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
    windowTitle,
    withColorOutput,
    type AttentionReason,
    type AttentionSink,
    type ColorOutput,
    type Role,
} from "./color.ts";
import {
    displayWidth,
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
import {
    compareCoordinates,
    ComposerEditor,
    EMPTY_COMPOSER_HINT,
    formatComposerHint,
    parseCoordinate,
    SingleLineText,
    TailText,
    TranscriptSlot,
    type ComposerHintState,
    type CoordinateTuple,
} from "./term-components.ts";

export {
    attention,
    backgroundScheme,
    bell,
    buildHeader,
    colorEnabled,
    colorFgBgScheme,
    concluded,
    displayWidth,
    editorTheme,
    formatCompactCount,
    formatComposerHint,
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
    TailText,
    windowTitle,
    withColorOutput,
    type AttentionReason,
    type AttentionSink,
    type ColorOutput,
    type ComposerHintState,
    type Role,
};

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
