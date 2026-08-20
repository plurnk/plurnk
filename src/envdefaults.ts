// The client's self-serve env floor ({§cli-env-defaults}): the packaged
// .env.defaults is both the documentation and the defaults for PLURNK_CLIENT_*.
// The client loads its own file SET-IF-UNSET beneath operator configuration
// (shell > env-files > this floor). A commented knob is documentation only.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULTS_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../.env.defaults");

export const parseDefaults = (text: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
        const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        if (m !== null) out[m[1]] = m[2];
    }
    return out;
};

export const applyFloor = (defaults: Record<string, string>, env: Record<string, string | undefined> = process.env): void => {
    for (const [key, value] of Object.entries(defaults)) {
        if (env[key] === undefined) env[key] = value;
    }
};

// Boot-time entry: read the shipped file (fail-hard — a package without its own
// floor file is a broken install) and floor the process env.
export const loadFloor = (): void => {
    applyFloor(parseDefaults(readFileSync(DEFAULTS_PATH, "utf8")));
};
