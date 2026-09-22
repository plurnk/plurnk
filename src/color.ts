// The client's one palette (plurnk#97): every colour and emphasis is named here by role, and no
// other module writes an SGR code. The five alert accents are the scheme (plurnk#87); every other
// role borrows from them. NO_COLOR conformance (no-color.org, plurnk#29): ANY non-empty value
// disables colour and emphasis — never just "1"/"true" — and it is read per call.
export const colorEnabled = (): boolean => (process.env.NO_COLOR ?? "") === "";

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
