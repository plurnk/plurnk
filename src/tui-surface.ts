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
import { paint, type Role } from "./color.ts";
import TailText from "./tail-text.ts";
import TurnDisplay from "./turn.ts";
import type { LogEntryWire } from "./render.ts";

const styled = (role: Role) => (text: string): string => paint(text, role);

const editorTheme = {
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
    readonly #terminal = new ProcessTerminal();
    readonly #tui = new TuiMainScreen(this.#terminal, true);
    readonly #transcript = new Container();
    // The reasoning scroll: at most a third of the terminal, newest lines only, never durable.
    readonly #live = new TailText(() => Math.max(3, Math.floor(this.#terminal.rows / 3)));
    readonly #turn = new TurnDisplay();
    // {§cli-workers-topology} — one line below the composer: the place, then the status line. The
    // composer separates content from state, so neither needs a padding line of its own (#100).
    readonly #prompt = new Text("", 0, 0);
    #promptText = "";
    #statusText = "";
    readonly editor = new Editor(this.#tui, editorTheme, { paddingX: 0, autocompleteMaxVisible: 8 });
    #started = false;

    constructor() {
        this.#tui.addChild(this.#transcript);
        this.#tui.addChild(this.#live);
        this.#tui.addChild(this.#turn);
        this.#tui.addChild(this.editor);
        this.#tui.addChild(this.#prompt);
        this.#tui.setFocus(this.editor);
    }

    get columns(): number {
        return this.#terminal.columns;
    }

    get rows(): number {
        return this.#terminal.rows;
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

    setPrompt(text: string): void {
        this.#promptText = text;
        this.#paintPlace();
    }

    setStatus(text: string): void {
        this.#statusText = text;
        this.#paintPlace();
    }

    #paintPlace(): void {
        this.#prompt.setText([this.#promptText, this.#statusText].filter((part) => part.length > 0).join(" "));
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
