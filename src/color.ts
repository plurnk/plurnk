// Palette, colour policy, light/dark ground detection, window titles, and attention signals
// ({§cli-color-policy}, {§cli-problems-and-notices}).

import { AsyncLocalStorage } from "node:async_hooks";
import type { RgbColor, TerminalColorScheme } from "@earendil-works/pi-tui";

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

export type ColorOutput = { readonly isTTY?: boolean };
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

// {§cli-color-policy} — the TUI's answer from the terminal itself.
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

// {§cli-markdown-projection} — OSC 8 hyperlinks when color is enabled.
export const hyperlink = (url: string, label: string): string => {
    if (!colorEnabled()) return label;
    const clean = ModelText.plain(url);
    if (!clean.startsWith("http://") && !clean.startsWith("https://")) return label;
    return `\x1b]8;;${clean}\x1b\\${label}\x1b]8;;\x1b\\`;
};

export const styled = (role: Role) => (text: string): string => paint(text, role);

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

// {§cli-color-policy} — signal when the person is needed.
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

// {§cli-color-policy}
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
        .map((line, i) => paint(`${i === 0 ? "🎤 " : "   "}${ModelText.plain(line)}`, "human", "bold"))
        .join("\n");
