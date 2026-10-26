// Terminal substrate on `@earendil-works/pi-tui` ({§cli-tui-mode}, {§cli-tui-flow},
// {§cli-color-scheme}, {§cli-terminal-title}, {§cli-attention}, {§cli-rendering}).

import { AsyncLocalStorage } from "node:async_hooks";
import { stripVTControlCharacters } from "node:util";
import {
    Container,
    Editor,
    Markdown,
    ProcessTerminal,
    Spacer,
    Text,
    TuiMainScreen,
    wrapTextWithAnsi,
    type AutocompleteProvider,
    type Component,
    type MarkdownTheme,
    type RgbColor,
    type Terminal,
    type TerminalColorScheme,
    type TerminalColors,
    type TuiInputListener,
} from "@earendil-works/pi-tui";
import { renderMermaidASCII } from "beautiful-mermaid";
import stringWidth from "string-width";

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

// {§cli-hyperlinks} — OSC 8 hyperlinks when color is enabled.
export const hyperlink = (url: string, label: string): string => {
    if (!colorEnabled()) return label;
    const clean = ModelText.plain(url);
    if (!clean.startsWith("http://") && !clean.startsWith("https://")) return label;
    return `\x1b]8;;${clean}\x1b\\${label}\x1b]8;;\x1b\\`;
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

const markdownTheme: MarkdownTheme = {
    heading: (text) => paint(text, "bold"),
    link: (text) => paint(text, "reference"),
    linkUrl: () => "",
    code: (text) => paint(text, "reference"),
    codeBlock: (text) => text,
    codeBlockBorder: (text) => paint(text, "dim"),
    quote: (text) => paint(text, "dim", "italic"),
    quoteBorder: () => paint("│", "dim"),
    hr: () => paint("─", "dim"),
    listBullet: (text) => paint(text, "dim"),
    bold: (text) => paint(text, "bold"),
    italic: (text) => paint(text, "italic"),
    strikethrough: (text) => paint(text, "strike"),
    underline: (text) => text,
};

// {§cli-markdown-projection} — Mermaid ASCII diagram projection.
export const renderMermaid = (source: string, width: number = 80): string | null => {
    const trimmed = source.trim();
    if (trimmed.length === 0) return null;
    try {
        const rendered = renderMermaidASCII(trimmed, { colorMode: "none" }).trimEnd();
        if (rendered.length === 0) return null;
        const lines = rendered.split("\n");
        if (lines.some((line) => stringWidth(line) + 2 > width)) return null;
        return lines.map((line) => `  ${line}`).join("\n");
    } catch {
        return null;
    }
};

// {§cli-markdown-adapter} — Terminal Markdown projection via pi-tui Markdown + Mermaid.
export const renderMarkdownDocument = (markdown: string, width: number = 80): string => {
    const clean = ModelText.plain(markdown).replace(/\r\n/gu, "\n");
    if (clean.trim().length === 0) return "";
    const withMermaid = clean.replace(
        /^(`{3,}|~{3,})mermaid[ \t]*\n([\s\S]*?)^\1[ \t]*$/gmu,
        (full, _fence: string, body: string) => renderMermaid(body, width) ?? full,
    );
    const md = new Markdown(withMermaid, 0, 0, markdownTheme);
    const lines = md.render(Math.max(20, width));
    return lines.join("\n").replace(/\n+$/u, "");
};

// {§cli-provider-reasoning} — Live 1/3-screen reasoning formatting with 💭 lead and 3-space indent.
export const renderReasoning = (content: string): string => {
    const clean = ModelText.plain(content).replace(/\r\n/gu, "\n").replace(/\n$/u, "");
    if (clean.length === 0) return "";
    return clean
        .split("\n")
        .map((line, i) => paint(`${i === 0 ? "💭 " : "   "}${line}`, "dim"))
        .join("\n");
};

// {§cli-operation-glyphs}, {§cli-response-order}, {§cli-outside-text} — Model response rendering.
export const renderModelReply = (
    text: string,
    columns: number = 80,
    opts?: {
        readonly op?: string | null;
        readonly status?: number | null;
        readonly aside?: string | null;
    },
): string => {
    const op = opts?.op ?? "SEND";
    if (op === "outside-") {
        return renderMarkdownDocument(text, columns);
    }
    const status = opts?.status ?? 200;
    const failed = status >= 400;
    const glyph = op === "WAIT" ? (failed ? "❌" : "⏳") : failed ? "❌" : "🐹";
    const cleanAside = opts?.aside ? ModelText.plain(opts.aside).trim() : "";
    const lead = `${paint(glyph, failed ? "failure" : "dim")}${
        cleanAside.length > 0 ? ` ${paint(cleanAside, "dim", "italic")}` : ""
    }`;
    const body = renderMarkdownDocument(text, columns);
    return body.length > 0 ? `${lead}\n${body}` : lead;
};

// {§cli-note-rendering} — Full dimmed Markdown rendering for NOTE / FACT / IDEA / PLAN.
export const renderNoteBlock = (opts: {
    readonly glyph: string;
    readonly aside?: string | null;
    readonly body: string;
    readonly columns?: number;
}): string => {
    const cleanAside = opts.aside ? ModelText.plain(opts.aside).trim() : "";
    const sep = opts.glyph.endsWith("\uFE0F") ? "  " : " ";
    const lead = `${paint(opts.glyph, "dim")}${
        cleanAside.length > 0 ? `${sep}${paint(cleanAside, "dim", "italic")}` : ""
    }`;
    const rendered = renderMarkdownDocument(opts.body, opts.columns ?? 80);
    if (rendered.trim().length === 0) {
        return lead;
    }
    const dimmedBody = stripVTControlCharacters(rendered)
        .split("\n")
        .map((line) => paint(line, "dim"))
        .join("\n");
    return `${lead}\n${dimmedBody}`;
};

const truncateToColumns = (line: string, maxCols: number): string => {
    if (stringWidth(line) <= maxCols) return line;
    let out = "";
    let width = 0;
    for (const ch of line) {
        const w = stringWidth(ch);
        if (width + w + 1 > maxCols) break;
        out += ch;
        width += w;
    }
    return `${out}…`;
};

// {§cli-log-entry-line-format} — 4-space indented dim preview lines with log:/// coordinate hint.
export const previewLines = (
    content: string,
    limit: number = 5,
    columns: number = 80,
    coordinate?: string | null,
    op?: string | null,
): string[] => {
    const normalized = ModelText.plain(content).replace(/\r\n/gu, "\n").trimEnd();
    if (normalized.length === 0 || limit <= 0) return [];
    const allLines = normalized.split("\n");
    const maxLineCols = Math.max(20, columns - 6);
    const shown = allLines
        .slice(0, limit)
        .map((line) => paint(`    ${truncateToColumns(line.replace(/\t/gu, "    "), maxLineCols)}`, "dim"));
    if (allLines.length > limit) {
        const remaining = allLines.length - limit;
        const cleanCoord = coordinate ? ModelText.plain(coordinate) : "";
        const cleanOp = op ? ModelText.plain(op) : "";
        const addr =
            cleanCoord.length === 0
                ? ""
                : cleanCoord.startsWith("log://")
                  ? ` · ${cleanCoord}`
                  : cleanOp.length > 0
                    ? ` · log:///${cleanCoord}/${cleanOp}`
                    : ` · log:///${cleanCoord}`;
        shown.push(
            paint(
                `    … +${String(remaining)} ${remaining === 1 ? "line" : "lines"}${addr}`,
                "dim",
            ),
        );
    }
    return shown;
};

const CURATION_VERBS = new Set(["KEEP", "DROP", "FOLD", "OPEN", "SHUT", "VIEW", "META"]);

// {§cli-log-entry-line-format}, {§cli-curation-notice} — Operation row + preview block.
export const renderOperationBlock = (opts: {
    readonly glyph: string;
    readonly op?: string | null;
    readonly title?: string | null;
    readonly target?: string | null;
    readonly scope?: string | null;
    readonly destination?: string | null;
    readonly pattern?: string | null;
    readonly count?: number | null;
    readonly aside?: string | null;
    readonly status?: string | null;
    readonly statusCode?: number | null;
    readonly outcome?: string | null;
    readonly contentLines?: readonly string[];
    readonly outputLines?: readonly string[];
    readonly coordinate?: string | null;
    readonly previewLimit?: number;
    readonly columns?: number;
}): string => {
    const op = opts.op ?? "";
    if (CURATION_VERBS.has(op)) {
        const parts = ["🧹", op];
        if (opts.target) parts.push(`(${ModelText.plain(opts.target)})`);
        if (opts.scope) parts.push(ModelText.plain(opts.scope));
        if (opts.aside) parts.push(paint(ModelText.plain(opts.aside), "dim", "italic"));
        return paint(parts.join(" "), "dim");
    }

    const failed =
        opts.status === "failed" || (typeof opts.statusCode === "number" && opts.statusCode >= 400);
    const headParts: string[] = [paint(opts.glyph, "bold", failed ? "failure" : "success")];
    if (opts.target) {
        headParts.push(`(${ModelText.plain(opts.target)})`);
    } else if (!op && opts.title) {
        headParts.push(ModelText.plain(opts.title));
    }
    if (opts.scope) {
        headParts.push(ModelText.plain(opts.scope));
    }
    if (opts.destination) {
        headParts.push(`(${ModelText.plain(opts.destination)})`);
    }
    if (opts.pattern) {
        const cleanPat = ModelText.plain(opts.pattern);
        headParts.push(/^[~/&=!]/u.test(cleanPat) ? cleanPat : `/${cleanPat}/`);
    }
    if (typeof opts.count === "number") {
        headParts.push(`{${String(opts.count)}}`);
    }
    if (opts.aside) {
        headParts.push(paint(ModelText.plain(opts.aside), "dim", "italic"));
    }
    if (opts.outcome) {
        headParts.push(`— ${paint(ModelText.plain(opts.outcome), failed ? "failure" : "dim")}`);
    }

    const cols = opts.columns ?? 80;
    const limit = opts.previewLimit ?? 5;
    const bodyText = (opts.contentLines ?? []).join("\n");
    const bodyPreview = previewLines(
        bodyText,
        op === "NOTE" ? Number.MAX_SAFE_INTEGER : limit,
        cols,
        opts.coordinate,
        op,
    );
    const outText = (opts.outputLines ?? []).join("\n");
    const outPreview = previewLines(outText, limit, cols);
    const headLine =
        headParts.length > 1 && opts.glyph.endsWith("\uFE0F")
            ? `${headParts[0]!}  ${headParts.slice(1).join(" ")}`
            : headParts.join(" ");
    return [headLine, ...bodyPreview, ...outPreview].join("\n");
};

export const formatCompactCount = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
    if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
    return String(n);
};

export const formatDurationSummary = (ms: number): string => {
    if (ms < 1000) return `${String(Math.max(1, Math.round(ms)))}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
    const mins = Math.floor(ms / 60_000);
    const secs = Math.round((ms % 60_000) / 1000);
    return `${String(mins)}m ${String(secs)}s`;
};

// {§cli-summary-line-per-loop} — Loop conclusion summary line.
export const renderLoopSummary = (opts: {
    readonly status: number;
    readonly hitMaxTurns?: boolean;
    readonly turns: number;
    readonly elapsedMs: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly curationWeight: number;
    readonly curationBudget: number;
    readonly contextTokens: number | null;
    readonly contextCapacity: number | null;
    readonly costUsd: string | null;
}): string => {
    const state =
        opts.status === 200 && !opts.hitMaxTurns
            ? "🎯 done"
            : opts.status === 499
              ? "  cancelled (final 499)"
              : opts.hitMaxTurns
                ? "  paused at turn limit"
                : "  failed";
    const turnLabel = `${String(opts.turns)} ${opts.turns === 1 ? "turn" : "turns"}`;
    const parts: string[] = [state, turnLabel, formatDurationSummary(opts.elapsedMs)];
    if (opts.inputTokens > 0 || opts.outputTokens > 0) {
        parts.push(`↓${formatCompactCount(opts.inputTokens)} ↑${formatCompactCount(opts.outputTokens)}`);
    }
    if (opts.curationBudget > 0) {
        const curPct = Math.min(100, Math.round((opts.curationWeight / opts.curationBudget) * 100));
        parts.push(`cur ${String(curPct)}%/${formatCompactCount(opts.curationBudget)}`);
    }
    if (opts.contextTokens !== null && opts.contextCapacity !== null && opts.contextCapacity > 0) {
        const ctxPct = Math.min(100, Math.round((opts.contextTokens / opts.contextCapacity) * 100));
        parts.push(`ctx ${String(ctxPct)}%/${formatCompactCount(opts.contextCapacity)}`);
    }
    if (opts.costUsd !== null && Number(opts.costUsd) > 0) {
        const num = Number(opts.costUsd);
        const formattedUsd = num < 0.01 ? `$${num.toFixed(4)}` : `$${num.toFixed(2)}`;
        parts.push(`loop ${formattedUsd}`);
    }
    return paint(parts.join(" · "), "dim");
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
    readonly #turn = new Container();
    #turnResponses: string[] = [];
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

    // {§cli-response-order} — Turn responses sit below #live reasoning during the turn, then archive to #transcript.
    addResponse(text: string): void {
        const normalized = text.replace(/\n$/u, "");
        if (normalized.length === 0) return;
        this.#turnResponses.push(normalized);
        this.#turn.addChild(new Text(normalized, 0, 0));
        this.#status.invalidate();
        this.#tui.requestRender();
    }

    archiveTurn(): void {
        if (this.#turnResponses.length === 0) return;
        const responses = this.#turnResponses;
        this.#turnResponses = [];
        this.#turn.clear();
        for (const text of responses) {
            this.#transcript.addChild(new Text(text, 0, 0));
            this.#lastWasSpacer = false;
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
