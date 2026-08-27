import {
    Container,
    Editor,
    ProcessTerminal,
    Spacer,
    Text,
    TuiMainScreen,
    type AutocompleteProvider,
    type TuiInputListener,
} from "@earendil-works/pi-tui";

const ansi = (code: number): ((text: string) => string) => (text) =>
    process.env.NO_COLOR !== undefined ? text : `\x1b[${code}m${text}\x1b[0m`;

const editorTheme = {
    borderColor: ansi(2),
    selectList: {
        selectedPrefix: ansi(36),
        selectedText: ansi(1),
        description: ansi(2),
        scrollInfo: ansi(2),
        noMatch: ansi(2),
    },
};

/**
 * The terminal substrate. pi-tui owns terminal mechanics; callers own product
 * semantics and project them as transcript, live, status, and editor state.
 */
export default class TuiSurface {
    readonly #terminal = new ProcessTerminal();
    readonly #tui = new TuiMainScreen(this.#terminal, true);
    readonly #transcript = new Container();
    readonly #live = new Text("", 0, 0);
    readonly #status = new Text("", 0, 0);
    readonly editor = new Editor(this.#tui, editorTheme, { paddingX: 0, autocompleteMaxVisible: 8 });
    #started = false;

    constructor() {
        this.#tui.addChild(this.#transcript);
        this.#tui.addChild(this.#live);
        this.#tui.addChild(this.editor);
        this.#tui.addChild(this.#status);
        this.#tui.setFocus(this.editor);
    }

    get columns(): number {
        return this.#terminal.columns;
    }

    start(): void {
        if (this.#started) return;
        this.#started = true;
        this.#tui.start();
        this.#tui.setFocus(this.editor);
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
            this.#started = false;
            this.#tui.stop();
        }
        try {
            return await work();
        } finally {
            if (wasStarted) {
                this.#started = true;
                this.#tui.start();
                this.#tui.setFocus(this.editor);
                this.#tui.requestRender(true);
            }
        }
    }
}
