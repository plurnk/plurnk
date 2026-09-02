import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import { ProblemError, clientWebNotInstalled } from "./diagnostics.ts";

interface WebProcessResult {
    status: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
}

export type WebSpawner = (
    executable: string,
    args: readonly string[],
    options: { env: NodeJS.ProcessEnv; stdio: "inherit" },
) => WebProcessResult;

const spawnWeb: WebSpawner = (executable, args, options) =>
    spawnSync(executable, [...args], options) as WebProcessResult;

export const launchWeb = (
    args: readonly string[],
    options: { env?: NodeJS.ProcessEnv; spawn?: WebSpawner } = {},
): number => {
    const result = (options.spawn ?? spawnWeb)("plurnk-web", args, {
        env: options.env ?? process.env,
        stdio: "inherit",
    });
    if (result.error !== undefined) {
        if ((result.error as NodeJS.ErrnoException).code === "ENOENT") {
            throw new ProblemError(clientWebNotInstalled(), 127);
        }
        throw result.error;
    }
    if (result.status !== null) return result.status;
    if (result.signal !== null) return 128 + constants.signals[result.signal];
    throw new Error("plurnk-web exited without a status or signal");
};
