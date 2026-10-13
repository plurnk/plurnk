// {§cli-sign-in} — what a browser sign-in left this client: the refresh token, the public client
// id it was issued to, and the endpoints that renew and revoke it, per daemon address, in a file
// under the XDG state directory that this user alone can read. A grant is the client's standing at
// one daemon; the daemon revokes it, and `logout` forgets it.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export interface Grant {
    readonly issuer: string;
    readonly clientId: string;
    readonly refreshToken: string;
    readonly tokenEndpoint: string;
    readonly revocationEndpoint: string | null;
}

interface GrantFile {
    readonly version: 1;
    readonly daemons: Record<string, Grant>;
}

export const grantsFile = (env: NodeJS.ProcessEnv = process.env): string => {
    const state = env.XDG_STATE_HOME;
    return join(state !== undefined && isAbsolute(state) ? state : join(homedir(), ".local", "state"), "plurnk", "grants.json");
};

const load = (file: string): GrantFile => {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return { version: 1, daemons: {} };
        throw cause;
    }
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || (parsed as { version?: unknown }).version !== 1) return { version: 1, daemons: {} };
    const daemons = (parsed as { daemons?: unknown }).daemons;
    return { version: 1, daemons: daemons !== null && typeof daemons === "object" ? daemons as Record<string, Grant> : {} };
};

const isGrant = (value: unknown): value is Grant => value !== null && typeof value === "object"
    && typeof (value as Grant).issuer === "string" && typeof (value as Grant).clientId === "string"
    && typeof (value as Grant).refreshToken === "string" && typeof (value as Grant).tokenEndpoint === "string"
    && ((value as Grant).revocationEndpoint === null || typeof (value as Grant).revocationEndpoint === "string");

/** The grant kept for the daemon at `origin`, or null. */
export const readGrant = (origin: string, env: NodeJS.ProcessEnv = process.env): Grant | null => {
    const grant = load(grantsFile(env)).daemons[origin];
    return isGrant(grant) ? grant : null;
};

/** Keeps `grant` for the daemon at `origin`, or forgets it when null; the file is complete or absent, 0600. */
export const writeGrant = (origin: string, grant: Grant | null, env: NodeJS.ProcessEnv = process.env): void => {
    const file = grantsFile(env);
    const daemons = { ...load(file).daemons };
    if (grant === null) delete daemons[origin];
    else daemons[origin] = grant;
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const stage = `${file}.${process.pid}`;
    writeFileSync(stage, `${JSON.stringify({ version: 1, daemons } satisfies GrantFile, null, 2)}\n`, { mode: 0o600 });
    try { renameSync(stage, file); } catch (cause) { rmSync(stage, { force: true }); throw cause; }
};
