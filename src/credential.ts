// {§cli-credential} — the client's credential at the daemon. The operator's secret is a client
// secret, never a bearer: the client discovers the daemon's authorization server from the resource
// it dials (RFC 9728, then RFC 8414) and exchanges the secret for an access token with the
// client_credentials grant, renewing when the token lapses or the daemon answers invalid_token. The
// secret is the shared PLURNK_SECRET when set; otherwise the file a daemon running as the operator
// minted beside its database, read again when the daemon refuses it, since a restarted daemon mints
// anew. A daemon that authenticates nothing publishes no resource metadata, and the client then
// presents nothing.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { clientProblem, ProblemError } from "./diagnostics.ts";

const OPERATOR = "operator";
const SCOPE = "agui";
const SECRET_FILE = "secret";

interface Access {
    readonly token: string;
    readonly expiresAt: number;
}

const document = async (url: string): Promise<Record<string, unknown> | null> => {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (response.status === 404) return null;
    if (!response.ok) {
        throw new ProblemError(clientProblem("credential", "discovery-failed", 502,
            `The daemon's authorization metadata at ${url} answered ${response.status}.`, { url, status: response.status }));
    }
    const body: unknown = await response.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
        throw new ProblemError(clientProblem("credential", "discovery-failed", 502, `The document at ${url} is not a JSON object.`, { url }));
    }
    return body as Record<string, unknown>;
};

// The file's one line, or null when there is no file: a daemon that is off or authenticates nothing left none.
const readSecret = (file: string): string | null => {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return null;
        throw cause;
    }
    const secret = text.trim();
    return secret.length === 0 ? null : secret;
};

export default class Credential {
    #secret: string;
    readonly #file: string | null;
    #access: Access | null = null;
    // undefined: not yet discovered; null: the daemon authenticates nothing.
    #tokenEndpoint: string | null | undefined = undefined;
    #acquiring: Promise<Access | null> | null = null;

    constructor(secret: string, file: string | null = null) {
        if (secret.length === 0) throw new TypeError("a credential needs a secret");
        this.#secret = secret;
        this.#file = file;
    }

    /** The operator's secret: `PLURNK_SECRET` from the cascade, else the daemon's minted file, else nothing. */
    static fromEnvironment(env: NodeJS.ProcessEnv = process.env): Credential | undefined {
        const configured = env.PLURNK_SECRET;
        if (configured !== undefined && configured.length > 0) return new Credential(configured);
        const file = Credential.secretFile(env);
        const minted = readSecret(file);
        return minted === null ? undefined : new Credential(minted, file);
    }

    /**
     * Where a daemon running as the operator writes the secret it minted: beside the database the
     * environment names, else beside the default database under the XDG data home.
     */
    static secretFile(env: NodeJS.ProcessEnv = process.env): string {
        const db = env.PLURNK_SERVICE_DB_PATH;
        if (db !== undefined && db.length > 0) return join(dirname(resolve(db.startsWith("~/") ? join(homedir(), db.slice(2)) : db)), SECRET_FILE);
        const data = env.XDG_DATA_HOME;
        return join(data !== undefined && isAbsolute(data) ? data : join(homedir(), ".local", "share"), "plurnk", SECRET_FILE);
    }

    /** The headers one request to `aguiUrl` presents, acquiring an access token on first use. */
    async headers(aguiUrl: string, now = Date.now()): Promise<Record<string, string>> {
        if (this.#access !== null && this.#access.expiresAt > now) return { authorization: `Bearer ${this.#access.token}` };
        this.#acquiring ??= this.#acquire(aguiUrl, now).finally(() => { this.#acquiring = null; });
        const access = await this.#acquiring;
        return access === null ? {} : { authorization: `Bearer ${access.token}` };
    }

    /** Forget the current access token: the next request acquires anew. */
    invalidate(): void {
        this.#access = null;
    }

    async #acquire(aguiUrl: string, now: number, reread = false): Promise<Access | null> {
        if (this.#tokenEndpoint === undefined) this.#tokenEndpoint = await this.#discover(aguiUrl);
        if (this.#tokenEndpoint === null) return null;
        const response = await fetch(this.#tokenEndpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: new URLSearchParams({ grant_type: "client_credentials", client_id: OPERATOR, client_secret: this.#secret, scope: SCOPE }).toString(),
        });
        const body = await response.json().catch(() => null) as { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown } | null;
        if (!response.ok || body === null || typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
            const error = typeof body?.error === "string" ? body.error : String(response.status);
            // A daemon restarted since the file was read minted a new secret: read it once more.
            if (error === "invalid_client" && this.#file !== null && !reread) {
                const current = readSecret(this.#file);
                if (current !== null && current !== this.#secret) {
                    this.#secret = current;
                    return this.#acquire(aguiUrl, now, true);
                }
            }
            const description = typeof body?.error_description === "string" ? body.error_description : "";
            throw new ProblemError(clientProblem("credential", "refused", 401,
                `The daemon refused the operator's secret (${error}${description.length === 0 ? "" : `: ${description}`}).`,
                { error, recovery: this.#file === null
                    ? "Set PLURNK_SECRET to the daemon's operator secret."
                    : `Set PLURNK_SECRET to the daemon's operator secret, or let a daemon running as you mint one at ${this.#file}.` }));
        }
        this.#access = { token: body.access_token, expiresAt: now + body.expires_in * 1000 };
        return this.#access;
    }

    // RFC 9728: the resource names its authorization servers; RFC 8414: the server names its endpoints.
    async #discover(aguiUrl: string): Promise<string | null> {
        const resource = await document(`${new URL(aguiUrl).origin}/.well-known/oauth-protected-resource`);
        if (resource === null) return null;
        const servers = resource.authorization_servers;
        const issuer = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] : null;
        if (issuer === null) throw new ProblemError(clientProblem("credential", "discovery-failed", 502, "The resource metadata names no authorization server.", { url: aguiUrl }));
        const metadata = await document(`${issuer.replace(/\/$/u, "")}/.well-known/oauth-authorization-server`);
        const endpoint = metadata?.token_endpoint;
        if (typeof endpoint !== "string") throw new ProblemError(clientProblem("credential", "discovery-failed", 502, `The authorization server ${issuer} names no token endpoint.`, { issuer }));
        return endpoint;
    }
}
