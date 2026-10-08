import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

export const homePath = (path: string, home = homedir()): string => {
    if (path === home) return "~";
    const prefix = home.endsWith(sep) ? home : `${home}${sep}`;
    return path.startsWith(prefix) ? `~${sep}${path.slice(prefix.length)}` : path;
};

// XDG is the cross-process user-configuration contract. The client owns no
// daemon data path.
export const userConfigFile = (
    env: NodeJS.ProcessEnv = process.env,
    home: string = homedir(),
): string => {
    const configured = env.XDG_CONFIG_HOME;
    const configHome = configured !== undefined && configured.length > 0 && isAbsolute(configured)
        ? resolve(configured)
        : resolve(home, ".config");
    return join(configHome, "plurnk", ".env");
};
