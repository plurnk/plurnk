// Terminal substrate on `@earendil-works/pi-tui` ({§cli-repl-mode},
// {§cli-color-policy}, {§cli-rendering}, {§cli-markdown-projection}).

import { stripVTControlCharacters } from "node:util";
import {
    Container,
    Editor,
    ProcessTerminal,
    Spacer,
    Text,
    TuiMainScreen,
    wrapTextWithAnsi,
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

const muted = (text: Text): Component => ({
    render: (width) => text.render(width).map(styled("dim")),
    invalidate: () => text.invalidate(),
});

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

// Live reasoning scroll: at most a third of the terminal, newest lines only, never durable ({§cli-markdown-projection}).
export class TailText implements Component {
    #text = "";
    readonly #maxLines: () => number;

    constructor(maxLines: () => number) {
        this.#maxLines = maxLines;
    }

    get hasText(): boolean {
        return this.#text.length > 0;
    }

    setText(text: string): void {
        this.#text = text;
    }

    invalidate(): void {}

    render(width: number): string[] {
        if (this.#text.length === 0) return [];
        const lines = this.#text
            .replace(/\t/gu, "   ")
            .split("\n")
            .flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
        const max = Math.max(1, this.#maxLines());
        return lines.length <= max ? lines : lines.slice(lines.length - max);
    }
}

export default class TuiSurface {
    readonly #terminal: Terminal;
    readonly #tui: TuiMainScreen;
    readonly #transcript = new Container();
    readonly #live = new TailText(() => Math.max(3, Math.floor(this.#terminal.rows / 3)));
    readonly #turn = new Container();
    #turnResponses: Array<{ text: string; coordinate: CoordinateTuple | null }> = [];
    #slotEpoch = 0;
    readonly #toolCallSlots = new Map<string, TranscriptSlot>();
    #lastLoopHamster: TranscriptSlot | null = null;
    readonly #status = new Text("", 0, 0);
    readonly #input = new Container();
    readonly #pending = new Text("", 0, 0);
    readonly editor: Editor;
    #review: Component | null = null;
    #reviewing = false;
    #dialog: Component | null = null;
    #started = false;
    #titled = false;
    #lastWasSpacer = false;

    constructor(terminal: Terminal = new ProcessTerminal()) {
        this.#terminal = terminal;
        this.#tui = new TuiMainScreen(terminal, true);
        this.editor = this.createEditor();
        this.#input.addChild(this.editor);
        this.#tui.addChild(this.#transcript);
        this.#tui.addChild(this.#live);
        this.#tui.addChild(this.#turn);
        this.#tui.addChild(this.#input);
        this.#tui.addChild(muted(this.#status));
        this.#tui.setFocus(this.editor);
        this.#tui.onTerminalColorSchemeChange((scheme) => this.#askScheme(scheme));
    }

    get columns(): number {
        return this.#terminal.columns;
    }

    get rows(): number {
        return this.#terminal.rows;
    }

    createEditor(): Editor {
        return new Editor(this.#tui, editorTheme, { paddingX: 0, autocompleteMaxVisible: 8 });
    }

    get reviewing(): boolean {
        return this.#reviewing;
    }

    get dialogOpen(): boolean {
        return this.#dialog !== null;
    }

    requestRender(): void {
        this.#tui.requestRender();
    }

    renderNow(): void {
        if (this.#started) {
            this.#tui.renderNow();
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
                this.#input.addChild(muted(this.#pending));
            }
            this.#input.addChild(this.editor);
        }
        this.#tui.setFocus(this.#focus);
        this.#tui.requestRender();
    }

    start(): void {
        if (this.#started) return;
        this.#started = true;
        this.#tui.start();
        this.#tui.setFocus(this.#focus);
        if (colorEnabled()) {
            this.#tui.setTerminalColorSchemeNotifications(true);
            const apply = ({ background }: TerminalColors): void => {
                if (background !== undefined) {
                    learnScheme(backgroundScheme(background));
                    this.#tui.invalidate();
                    this.#tui.requestRender();
                }
            };
            void this.#tui.queryTerminalColors({ timeoutMs: 100, onLateReply: apply }).then(apply);
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
            this.#tui.invalidate();
            this.#tui.requestRender();
        };
        void this.#tui.queryTerminalColors({ timeoutMs: 100, onLateReply: apply }).then(apply);
    }

    stop(): void {
        if (!this.#started) return;
        this.#started = false;
        try {
            this.#tui.renderNow();
        } finally {
            this.#tui.stop();
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
            if (
                slot.coordinate === null ||
                firstResponseCoord === null ||
                compareCoordinates(slot.coordinate, firstResponseCoord) >= 0
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
            this.#tui.requestRender();
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
        this.#tui.requestRender();
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
        this.#tui.requestRender();
    }

    // {§cli-markdown-projection} — Turn responses sit below #live reasoning during the turn, then archive to #transcript.
    addResponse(text: string, coordinate?: string | null): void {
        const normalized = text.replace(/\n$/u, "");
        if (normalized.length === 0) return;
        this.#turnResponses.push({
            text: normalized,
            coordinate: parseCoordinate(coordinate),
        });
        this.#turn.addChild(new Text(normalized, 0, 0));
        this.#status.invalidate();
        this.#tui.requestRender();
    }

    static #decorateHamsterHeader(raw: string, summaryAside: string): string | null {
        const nl = raw.indexOf("\n");
        const firstLine = nl >= 0 ? raw.slice(0, nl) : raw;
        if (stripVTControlCharacters(firstLine).trim() !== "🐹") {
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
                    const decorated = TuiSurface.#decorateHamsterHeader(target.rawText, summaryAside);
                    if (decorated !== null) {
                        target.setText(decorated, target.trailingBlankLine);
                        this.#status.invalidate();
                        this.#tui.requestRender();
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
            const decorated = TuiSurface.#decorateHamsterHeader(last.text, summaryAside);
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
            if (stripVTControlCharacters(firstLine).trim() === "🐹") {
                this.#lastLoopHamster = slot;
            }
        }
        if (isLoopConclusion) {
            this.#lastLoopHamster = null;
        }
        this.#status.invalidate();
        this.#tui.requestRender();
        return attachedSummary;
    }

    setLive(text: string | null): void {
        if (text === null && this.#live.hasText && this.#started) {
            try {
                this.#tui.renderNow();
            } catch {
                // ignore intermediate flush errors
            }
        }
        this.#live.setText(text ?? "");
        if (text !== null && this.#started) {
            try {
                this.#tui.renderNow();
            } catch {
                this.#tui.requestRender();
            }
        } else {
            this.#tui.requestRender();
        }
    }

    setStatus(text: string): void {
        this.#status.setText(text);
        this.#tui.requestRender();
    }

    setInput(text: string): void {
        this.editor.setText(text);
        this.#tui.requestRender();
    }

    insertInput(text: string): void {
        this.editor.insertTextAtCursor(text);
        this.#tui.requestRender();
    }

    addHistory(promptsNewestFirst: readonly string[]): void {
        for (const prompt of promptsNewestFirst.toReversed()) {
            this.editor.addToHistory(prompt);
        }
    }

    setAutocompleteProvider(provider: AutocompleteProvider): void {
        this.editor.setAutocompleteProvider(provider);
    }

    addInputListener(listener: TuiInputListener): () => void {
        return this.#tui.addInputListener(listener);
    }

    async handOff<T>(work: () => Promise<T> | T): Promise<T> {
        const wasStarted = this.#started;
        if (wasStarted) {
            this.#tui.stop();
        }
        try {
            return await work();
        } finally {
            if (wasStarted && this.#started) {
                this.#tui.start();
                this.#tui.setFocus(this.#focus);
                this.#tui.requestRender();
            }
        }
    }
}
