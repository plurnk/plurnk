import {
    Container,
    Editor,
    ProcessTerminal,
    Spacer,
    Text,
    TuiMainScreen,
    type AutocompleteProvider,
    type Component,
    type Terminal,
    type TuiInputListener,
} from "@earendil-works/pi-tui";
import { paint, type Role } from "./color.ts";
import TailText from "./tail-text.ts";
import TurnDisplay from "./turn.ts";
import type { LogEntryWire } from "./render.ts";

const styled = (role: Role) => (text: string): string => paint(text, role);

export const editorTheme = {
    borderColor: styled("dim"),
    selectList: {
        selectedPrefix: styled("reference"),
        selectedText: styled("bold"),
        description: styled("dim"),
        scrollInfo: styled("dim"),
        noMatch: styled("dim"),
    },
};

/**
 * The terminal substrate. pi-tui owns terminal mechanics; callers own product
 * semantics and project them as transcript, live, status, and editor state.
 */
export default class TuiSurface {
    readonly #terminal: Terminal;
    readonly #tui: TuiMainScreen;
    readonly #transcript = new Container();
    // The reasoning scroll: at most a third of the terminal, newest lines only, never durable.
    readonly #live = new TailText(() => Math.max(3, Math.floor(this.#terminal.rows / 3)));
    readonly #turn = new TurnDisplay();
    // {§cli-status-project-root} {§cli-workers-topology} — the application composes one footer.
    readonly #status = new Text("", 0, 0);
    readonly #input = new Container();
    readonly #pending = new Text("", 0, 0);
    readonly editor: Editor;
    #review: Component | null = null;
    #reviewing = false;
    #started = false;

    constructor(terminal: Terminal = new ProcessTerminal()) {
        this.#terminal = terminal;
        this.#tui = new TuiMainScreen(terminal, true);
        this.editor = this.createEditor();
        this.#input.addChild(this.editor);
        this.#tui.addChild(this.#transcript);
        this.#tui.addChild(this.#live);
        this.#tui.addChild(this.#turn);
        this.#tui.addChild(this.#input);
        this.#tui.addChild(this.#status);
        this.#tui.setFocus(this.editor);
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

    // {§cli-inline-review} — swap components, never reconstruct the composer's editing state.
    setReview(component: Component | null, count: number): void {
        if (component === null) this.#reviewing = false;
        else if (this.#review === null && this.editor.getText().length === 0) this.#reviewing = true;
        this.#review = component;
        this.#pending.setText(paint(`${count} pending review${count === 1 ? "" : "s"} · /review · /cancel`, "dim"));
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
        if (this.#reviewing && this.#review !== null) this.#input.addChild(this.#review);
        else {
            if (this.#review !== null) this.#input.addChild(this.#pending);
            this.#input.addChild(this.editor);
        }
        this.#tui.setFocus(this.#reviewing ? this.#review : this.editor);
        this.#tui.requestRender();
    }

    start(): void {
        if (this.#started) return;
        this.#started = true;
        this.#tui.start();
        this.#tui.setFocus(this.#reviewing ? this.#review : this.editor);
    }

    stop(): void {
        if (!this.#started) return;
        this.#started = false;
        this.#tui.stop();
    }

    append(text: string): void {
        const normalized = text.replace(/\n$/, "");
        if (normalized.length === 0) this.#transcript.addChild(new Spacer(1));
        else this.#transcript.addChild(new Text(normalized, 0, 0));
        this.#tui.requestRender();
    }

    setLive(text: string | null): void {
        this.#live.setText(text ?? "");
        this.#tui.requestRender();
    }

    addResponse(entry: LogEntryWire): void {
        this.#turn.addResponse(entry);
        this.#tui.requestRender();
    }

    archiveResponses(): void {
        const previous = this.#turn.take();
        if (!previous.empty) this.#transcript.addChild(previous);
        this.#tui.requestRender();
    }

    archiveActivity(): void {
        const previous = this.#turn.take();
        if (!previous.empty) this.#transcript.addChild(previous);
        this.#tui.requestRender();
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
        for (const prompt of promptsNewestFirst.toReversed()) this.editor.addToHistory(prompt);
    }

    setAutocompleteProvider(provider: AutocompleteProvider): void {
        this.editor.setAutocompleteProvider(provider);
    }

    addInputListener(listener: TuiInputListener): () => void {
        return this.#tui.addInputListener(listener);
    }

    async handOff<T>(work: () => Promise<T>): Promise<T> {
        const wasStarted = this.#started;
        if (wasStarted) {
            this.#tui.stop();
        }
        try {
            return await work();
        } finally {
            if (wasStarted && this.#started) {
                this.#tui.start();
                this.#tui.setFocus(this.#reviewing ? this.#review : this.editor);
                this.#tui.requestRender(true);
            }
        }
    }
}
