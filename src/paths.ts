import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

// XDG is the cross-process user-configuration contract. The client owns no
// daemon data path and never reads the retired mixed application home.
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
