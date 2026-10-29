// Cascading environment loader for @plurnk/plurnk ({§cli-invocation}, {§cli-configuration-source}).

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SHARED_DEFAULTS_PATH = resolve(
    dirname(require.resolve("@plurnk/plurnk-contracts/package.json")),
    ".env.defaults",
);

export const CLIENT_DEFAULTS_PATH = resolve(ROOT, ".env.defaults");

export const parseDefaults = (content: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const line of content.split(/\r?\n/u)) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if (
            (val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))
        ) {
            val = val.slice(1, -1);
        }
        out[key] = val;
    }
    return out;
};

export interface CascadeFileSpec {
    readonly path: string;
    readonly required: boolean;
}

export const assembleClientEnv = (
    shellEnv: NodeJS.ProcessEnv = process.env,
    explicitFiles: readonly CascadeFileSpec[] = [],
): Record<string, string> => {
    const sharedFloor = existsSync(SHARED_DEFAULTS_PATH)
        ? parseDefaults(readFileSync(SHARED_DEFAULTS_PATH, "utf8"))
        : {};
    const clientFloor = existsSync(CLIENT_DEFAULTS_PATH)
        ? parseDefaults(readFileSync(CLIENT_DEFAULTS_PATH, "utf8"))
        : {};

    const xdgConfig = shellEnv.XDG_CONFIG_HOME ?? join(shellEnv.HOME ?? homedir(), ".config");
    const operatorEnvPath = join(xdgConfig, "plurnk", ".env");
    const operatorEnv = existsSync(operatorEnvPath)
        ? parseDefaults(readFileSync(operatorEnvPath, "utf8"))
        : {};
    const operatorLocalEnvPath = join(xdgConfig, "plurnk", ".env.local");
    const operatorLocalEnv = existsSync(operatorLocalEnvPath)
        ? parseDefaults(readFileSync(operatorLocalEnvPath, "utf8"))
        : {};

    const fileLayer: Record<string, string> = {};
    for (const spec of explicitFiles) {
        const resolved = resolve(spec.path);
        if (!existsSync(resolved)) {
            if (spec.required) {
                throw new Error(`Environment file not found: ${spec.path}`);
            }
            continue;
        }
        Object.assign(fileLayer, parseDefaults(readFileSync(resolved, "utf8")));
    }

    const shellLayer: Record<string, string> = {};
    for (const [k, v] of Object.entries(shellEnv)) {
        if (typeof v === "string") {
            shellLayer[k] = v;
        }
    }

    return {
        ...sharedFloor,
        ...clientFloor,
        ...operatorEnv,
        ...operatorLocalEnv,
        ...fileLayer,
        ...shellLayer,
    };
};
