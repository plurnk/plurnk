// Terminal substrate on `@earendil-works/pi-tui` ({§cli-tui-mode}, {§cli-tui-flow},
// {§cli-color-scheme}, {§cli-terminal-title}, {§cli-attention}).

import { AsyncLocalStorage } from "node:async_hooks";
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
    type RgbColor,
    type Terminal,
    type TerminalColorScheme,
    type TerminalColors,
    type TuiInputListener,
} from "@earendil-works/pi-tui";

// Model-authored text is data, never terminal control ({§cli-problems-and-notices}).
export class ModelText {
    static readonly #SEQUENCE =
        /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[PX^_][^\x1b]*(?:\x1b\\)?|[ -/]*[0-~])|\x9b[0-?]*[ -/]*[@-~]|\x9d[^\x07\x9c\x1b]*(?:\x07|\x9c)?/gu;
    static readonly #CONTROL = /[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/gu;

    static plain(text: string): string {
        return text.replace(ModelText.#SEQUENCE, "").replace(ModelText.#CONTROL, "");
    }

    static plainFields<T extends object>(value: T): T {
        return Object.fromEntries(
            Object.entries(value).map(([key, field]) => [
                key,
                typeof field === "string" ? ModelText.plain(field) : field,
            ]),
        ) as T;
    }
}

type ColorOutput = { readonly isTTY?: boolean };
const outputContext = new AsyncLocalStorage<ColorOutput>();
export const withColorOutput = <T>(output: ColorOutput, render: () => T): T =>
    outputContext.run(output, render);

export const isColorMode = (value: string): value is "always" | "auto" | "never" =>
    value === "always" || value === "auto" || value === "never";

// {§cli-color-policy} — read at rendering time, against the actual destination.
export const colorEnabled = (
    output: ColorOutput = outputContext.getStore() ?? process.stdout,
    env: NodeJS.ProcessEnv = process.env,
): boolean => {
    const mode = env.PLURNK_CLIENT_COLOR;
    if (mode === "always") return true;
    if (mode === "never") return false;
    if (mode !== undefined && !isColorMode(mode)) return false;
    if (env.NO_COLOR) return false;
    if (env.FORCE_COLOR || env.CLICOLOR_FORCE) return true;
    return env.CLICOLOR !== "0" && env.TERM !== "dumb" && output.isTTY === true;
};

// {§cli-color-scheme} — the TUI's answer from the terminal itself.
let learned: TerminalColorScheme | undefined;
export const learnScheme = (scheme: TerminalColorScheme | undefined): void => {
    learned = scheme;
};

export const colorFgBgScheme = (env: NodeJS.ProcessEnv = process.env): TerminalColorScheme | undefined => {
    const background = env.COLORFGBG?.split(";").at(-1)?.trim() ?? "";
    if (!/^\d{1,2}$/u.test(background) || Number(background) > 15) return undefined;
    return Number(background) <= 6 || Number(background) === 8 ? "dark" : "light";
};

const linear = (channel: number): number => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
};

export const backgroundScheme = ({ r, g, b }: RgbColor): TerminalColorScheme => {
    const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    return 1.05 / (luminance + 0.05) >= (luminance + 0.05) / 0.05 ? "dark" : "light";
};

const DARK = Object.freeze({
    blue: "94",
    green: "32",
    purple: "38;5;141",
    orange: "38;5;172",
    red: "31",
    cyan: "36",
    muted: "38;5;145",
});
const LIGHT = Object.freeze({ ...DARK, purple: "38;5;97", orange: "38;5;130", muted: "38;5;60" });

const byRole = (accent: Readonly<Record<keyof typeof DARK, string>>) =>
    Object.freeze({
        note: accent.blue,
        tip: accent.green,
        important: accent.purple,
        warning: accent.orange,
        caution: accent.red,
        human: accent.blue,
        success: accent.green,
        added: accent.green,
        failure: accent.red,
        removed: accent.red,
        reference: accent.cyan,
        bold: "1",
        dim: accent.muted,
        italic: "3",
        strike: "9",
    });

const SGR = Object.freeze({ dark: byRole(DARK), light: byRole(LIGHT) });

export type Role = keyof typeof SGR.dark;

export const paint = (text: string, ...roles: Role[]): string => {
    if (!colorEnabled() || roles.length === 0) return text;
    const sgr = SGR[learned ?? colorFgBgScheme() ?? "dark"];
    return `\x1b[${roles.map((role) => sgr[role]).join(";")}m${text}\x1b[0m`;
};

const styled = (role: Role) => (text: string): string => paint(text, role);
const muted = (text: Text): Component => ({
    render: (width) => text.render(width).map(styled("dim")),
    invalidate: () => text.invalidate(),
});

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

// {§cli-attention} — signal when the person is needed.
export type AttentionReason = "reply" | "stopped" | "failed" | "review" | "question";
export type AttentionSink = (reason: AttentionReason) => void;

export const concluded = (finalStatus: number, hitMaxTurns: boolean): AttentionReason =>
    finalStatus === 200 && !hitMaxTurns ? "reply" : finalStatus === 499 ? "stopped" : "failed";

export const attention = (sinks: readonly AttentionSink[]): AttentionSink => (reason) => {
    for (const sink of sinks) sink(reason);
};

export const bell = (stream: { readonly isTTY?: boolean; write(chunk: string): unknown }): AttentionSink => () => {
    if (stream.isTTY === true) stream.write("\x07");
};

// {§cli-terminal-title}
export const windowTitle = (workspace: string, session: string | null | undefined): string =>
    session ? `plurnk · ${workspace} · ${session}` : `plurnk · ${workspace}`;

export const buildHeader = (opts: {
    versionNotice?: string;
    workspaceName: string;
    sessionName?: string;
    modelSelector?: string;
    effort?: string | null;
    yolo?: boolean;
}): string => {
    const head = opts.versionNotice ?? "plurnk";
    const session = opts.sessionName !== undefined ? ` · session: ${opts.sessionName}` : "";
    const modelLabel = opts.modelSelector ?? "(daemon default)";
    const effort = opts.effort === undefined || opts.effort === null ? "" : ` · effort: ${opts.effort}`;
    const yolo = opts.yolo === false ? " · yolo: off" : "";
    return `${head} · workspace: ${opts.workspaceName}${session} · model: ${modelLabel}${effort}${yolo} · /help`;
};

export const resumeCommand = (workspace: string, session: string): string => {
    const quote = (value: string): string =>
        /^[A-Za-z0-9_.:/-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
    return `plurnk --workspace ${quote(workspace)} --session ${quote(session)}`;
};

export const renderSubmittedInput = (text: string): string =>
    text
        .split("\n")
        .map((line, i) => paint(`${i === 0 ? "› " : "  "}${ModelText.plain(line)}`, "human", "bold"))
        .join("\n");

// Live reasoning scroll: at most a third of the terminal, newest lines only, never durable ({§cli-provider-reasoning}).
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
    readonly #status = new Text("", 0, 0);
    readonly #input = new Container();
    readonly #pending = new Text("", 0, 0);
    readonly editor: Editor;
    #review: Component | null = null;
    #reviewing = false;
    #dialog: Component | null = null;
    #started = false;
    #titled = false;

    constructor(terminal: Terminal = new ProcessTerminal()) {
        this.#terminal = terminal;
        this.#tui = new TuiMainScreen(terminal, true);
        this.editor = this.createEditor();
        this.#input.addChild(this.editor);
        this.#tui.addChild(this.#transcript);
        this.#tui.addChild(this.#live);
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

    append(text: string): void {
        const normalized = text.replace(/\n$/u, "");
        if (normalized.length === 0) {
            this.#transcript.addChild(new Spacer(1));
        } else {
            this.#transcript.addChild(new Text(normalized, 0, 0));
        }
        this.#status.invalidate();
        this.#tui.requestRender();
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
