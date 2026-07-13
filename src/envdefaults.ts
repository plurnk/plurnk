// The client's self-serve env floor (plurnk#141, ecosystem standard
// §operator-config-env-defaults): the packaged .env.defaults is the documentation
// AND the defaults for the PLURNK_CLIENT_* prefix — one owner per key. The daemon
// assembles its members' files into its own floor; the client is a separate process
// the daemon cannot assemble, so it loads its own file SET-IF-UNSET beneath the
// operator's env (shell > env-files > this floor). A commented knob is docs only.

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
