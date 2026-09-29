// The client's one palette (plurnk#97): every colour and emphasis is named here by role, and no
// other module writes an SGR code. The five alert accents are the scheme (plurnk#87); every other
// role borrows from them.
import { AsyncLocalStorage } from "node:async_hooks";
import type { RgbColor, TerminalColorScheme } from "@earendil-works/pi-tui";

type ColorOutput = { readonly isTTY?: boolean };
const outputContext = new AsyncLocalStorage<ColorOutput>();
export const withColorOutput = <T>(output: ColorOutput, render: () => T): T => outputContext.run(output, render);

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
    // Admission rejects invalid modes; its own diagnostic must still be printable.
    if (mode !== undefined && !isColorMode(mode)) return false;
    if (env.NO_COLOR) return false;
    if (env.FORCE_COLOR || env.CLICOLOR_FORCE) return true;
    return env.CLICOLOR !== "0" && env.TERM !== "dumb" && output.isTTY === true;
};

// {§cli-color-scheme} — the TUI's answer from the terminal itself; the one-shot CLI never has one.
let learned: TerminalColorScheme | undefined;
export const learnScheme = (scheme: TerminalColorScheme | undefined): void => { learned = scheme; };

// `fg;bg` or `fg;xpm;bg`; the background indexes the terminal's own palette, classified as Vim does.
export const colorFgBgScheme = (env: NodeJS.ProcessEnv = process.env): TerminalColorScheme | undefined => {
    const background = env.COLORFGBG?.split(";").at(-1)?.trim() ?? "";
    if (!/^\d{1,2}$/u.test(background) || Number(background) > 15) return undefined;
    return Number(background) <= 6 || Number(background) === 8 ? "dark" : "light";
};

// WCAG 2: a background is dark when white text contrasts with it more than black text does.
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
});
const LIGHT = Object.freeze({ ...DARK, purple: "38;5;97", orange: "38;5;130" });

const byRole = (accent: Readonly<Record<keyof typeof DARK, string>>) => Object.freeze({
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
    dim: "2",
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
