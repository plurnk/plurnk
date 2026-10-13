// {§cli-credential} — the client's credential at the daemon. The operator's secret is a client
// secret, never a bearer: the client discovers the daemon's authorization server from the resource
// it dials (RFC 9728, then RFC 8414) and exchanges the secret for an access token with the
// client_credentials grant, renewing when the token lapses or the daemon answers invalid_token. A
// daemon that authenticates nothing publishes no resource metadata, and the client then presents
// nothing.
import { clientProblem, ProblemError } from "./diagnostics.ts";

const OPERATOR = "operator";
const SCOPE = "agui";

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

export default class Credential {
    readonly #secret: string;
    #access: Access | null = null;
    // undefined: not yet discovered; null: the daemon authenticates nothing.
    #tokenEndpoint: string | null | undefined = undefined;
    #acquiring: Promise<Access | null> | null = null;

    constructor(secret: string) {
        if (secret.length === 0) throw new TypeError("a credential needs a secret");
        this.#secret = secret;
    }

    /** The operator's secret from the cascade, or nothing when the environment names none. */
    static fromEnvironment(env: NodeJS.ProcessEnv = process.env): Credential | undefined {
        const secret = env.PLURNK_AGUI_SECRET ?? "";
        return secret.length === 0 ? undefined : new Credential(secret);
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

    async #acquire(aguiUrl: string, now: number): Promise<Access | null> {
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
            const description = typeof body?.error_description === "string" ? body.error_description : "";
            throw new ProblemError(clientProblem("credential", "refused", 401,
                `The daemon refused the operator's secret (${error}${description.length === 0 ? "" : `: ${description}`}).`,
                { error, recovery: "Set PLURNK_AGUI_SECRET to the secret in the daemon's operator file." }));
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
