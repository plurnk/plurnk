// The client's one palette (plurnk#97): every colour and emphasis is named here by role, and no
// other module writes an SGR code. The five alert accents are the scheme (plurnk#87); every other
// role borrows from them.
import { AsyncLocalStorage } from "node:async_hooks";

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

const ACCENT = Object.freeze({
    blue: "94",
    green: "32",
    purple: "38;5;141",
    orange: "38;5;172",
    red: "31",
    cyan: "36",
});

const SGR = Object.freeze({
    note: ACCENT.blue,
    tip: ACCENT.green,
    important: ACCENT.purple,
    warning: ACCENT.orange,
    caution: ACCENT.red,
    human: ACCENT.blue,
    success: ACCENT.green,
    added: ACCENT.green,
    failure: ACCENT.red,
    removed: ACCENT.red,
    reference: ACCENT.cyan,
    bold: "1",
    dim: "2",
    italic: "3",
    strike: "9",
});

export type Role = keyof typeof SGR;

export const paint = (text: string, ...roles: Role[]): string =>
    colorEnabled() && roles.length > 0 ? `\x1b[${roles.map((role) => SGR[role]).join(";")}m${text}\x1b[0m` : text;
