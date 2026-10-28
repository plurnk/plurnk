// OAuth 2.1 credential exchange for @plurnk/plurnk ({§cli-problems-and-notices}, {§cli-problems-and-notices}).

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const resolveSecretFromEnv = (env: Record<string, string | undefined>): string | null => {
    const configured = env.PLURNK_SECRET;
    if (typeof configured === "string" && configured.trim().length > 0) {
        return configured.trim();
    }
    const dbPath = env.PLURNK_SERVICE_DB_PATH;
    const secretFile = typeof dbPath === "string" && dbPath.trim().length > 0
        ? join(dirname(dbPath.trim()), "secret")
        : join(env.XDG_DATA_HOME ?? join(env.HOME ?? homedir(), ".local", "share"), "plurnk", "secret");
    if (existsSync(secretFile)) {
        try {
            const minted = readFileSync(secretFile, "utf8").trim();
            if (minted.length > 0) return minted;
        } catch {
            // unreadable secret file
        }
    }
    return null;
};

const toHttpOrigin = (rawUrl: string): string => {
    const url = new URL(rawUrl);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    return url.origin;
};

export default class Credential {
    readonly #explicitSecret: string | null;
    readonly #env: Record<string, string | undefined>;
    #cachedToken: string | null = null;
    #cachedExpiresAt = 0;

    constructor(secretOrEnv?: string | Record<string, string | undefined> | null) {
        if (typeof secretOrEnv === "string") {
            this.#explicitSecret = secretOrEnv.trim().length > 0 ? secretOrEnv.trim() : null;
            this.#env = process.env;
        } else if (secretOrEnv !== undefined && secretOrEnv !== null) {
            this.#explicitSecret = null;
            this.#env = secretOrEnv;
        } else {
            this.#explicitSecret = null;
            this.#env = process.env;
        }
    }

    invalidate(): void {
        this.#cachedToken = null;
        this.#cachedExpiresAt = 0;
    }

    async token(acpUrl: string): Promise<string | null> {
        if (this.#cachedToken !== null && Date.now() < this.#cachedExpiresAt) {
            return this.#cachedToken;
        }
        const secret = this.#explicitSecret ?? resolveSecretFromEnv(this.#env);
        if (secret === null) return null;

        const origin = toHttpOrigin(acpUrl);
        const body = new URLSearchParams({
            grant_type: "client_credentials",
            client_id: "operator",
            client_secret: secret,
            scope: "acp",
        });

        try {
            const res = await fetch(`${origin}/oauth/token`, {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    accept: "application/json",
                },
                body: body.toString(),
            });
            if (res.status === 404) {
                return null;
            }
            if (!res.ok) {
                return null;
            }
            const json = (await res.json()) as {
                access_token?: string;
                expires_in?: number;
            };
            if (typeof json.access_token === "string" && json.access_token.length > 0) {
                this.#cachedToken = json.access_token;
                const ttlSec = typeof json.expires_in === "number" && json.expires_in > 10 ? json.expires_in - 5 : 60;
                this.#cachedExpiresAt = Date.now() + ttlSec * 1000;
                return this.#cachedToken;
            }
        } catch {
            // network or non-oauth mock server
        }
        return null;
    }

    async headers(acpUrl: string): Promise<Record<string, string>> {
        const tok = await this.token(acpUrl);
        return tok !== null ? { authorization: `Bearer ${tok}` } : {};
    }
}
