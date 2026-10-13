// {§cli-credential} — the client's credential at the daemon. The operator's secret is a client
// secret, never a bearer: the client discovers the daemon's authorization server from the resource
// it dials (RFC 9728, then RFC 8414) and exchanges the secret for an access token with the
// client_credentials grant, renewing when the token lapses or the daemon answers invalid_token. The
// secret is the shared PLURNK_SECRET when set; otherwise the file a daemon running as the operator
// minted beside its database, read again when the daemon refuses it, since a restarted daemon mints
// anew. With neither, the client signs in through the browser ({§cli-sign-in}) and keeps the grant.
// A daemon that authenticates nothing publishes no resource metadata, and the client then presents
// nothing.
import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { clientProblem, ProblemError } from "./diagnostics.ts";
import { readGrant, writeGrant } from "./grants.ts";
import { receiveAuthorization } from "./oauth.ts";

const OPERATOR = "operator";
const SCOPE = "agui";
const SECRET_FILE = "secret";
const CLIENT_NAME = "plurnk";

/** What a target presents: one request's headers, and a way to forget a token the daemon refused. */
export interface ClientCredential {
    headers(aguiUrl: string, now?: number): Promise<Record<string, string>>;
    invalidate(): void;
}

interface Access {
    readonly token: string;
    readonly expiresAt: number;
}

interface Metadata {
    readonly issuer: string;
    readonly tokenEndpoint: string;
    readonly authorizationEndpoint: string | null;
    readonly registrationEndpoint: string | null;
    readonly revocationEndpoint: string | null;
}

interface TokenResponse {
    readonly accessToken: string;
    readonly expiresIn: number;
    readonly refreshToken: string | null;
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

// RFC 9728: the resource names its authorization servers; RFC 8414: the server names its endpoints.
// Null: the daemon publishes no resource metadata and authenticates nothing.
const discover = async (aguiUrl: string): Promise<Metadata | null> => {
    const resource = await document(`${new URL(aguiUrl).origin}/.well-known/oauth-protected-resource`);
    if (resource === null) return null;
    const servers = resource.authorization_servers;
    const issuer = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0].replace(/\/$/u, "") : null;
    if (issuer === null) throw new ProblemError(clientProblem("credential", "discovery-failed", 502, "The resource metadata names no authorization server.", { url: aguiUrl }));
    const metadata = await document(`${issuer}/.well-known/oauth-authorization-server`);
    const endpoint = (name: string): string | null => typeof metadata?.[name] === "string" ? metadata[name] as string : null;
    const tokenEndpoint = endpoint("token_endpoint");
    if (tokenEndpoint === null) throw new ProblemError(clientProblem("credential", "discovery-failed", 502, `The authorization server ${issuer} names no token endpoint.`, { issuer }));
    return {
        issuer, tokenEndpoint,
        authorizationEndpoint: endpoint("authorization_endpoint"),
        registrationEndpoint: endpoint("registration_endpoint"),
        revocationEndpoint: endpoint("revocation_endpoint"),
    };
};

// One request to the token endpoint; a refusal is the endpoint's own error code and words.
const tokenRequest = async (endpoint: string, fields: Record<string, string>): Promise<{ ok: true; tokens: TokenResponse } | { ok: false; error: string; description: string }> => {
    const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(fields).toString(),
    });
    const body = await response.json().catch(() => null) as { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown; error?: unknown; error_description?: unknown } | null;
    if (!response.ok || body === null || typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
        return {
            ok: false,
            error: typeof body?.error === "string" ? body.error : String(response.status),
            description: typeof body?.error_description === "string" ? body.error_description : "",
        };
    }
    return { ok: true, tokens: { accessToken: body.access_token, expiresIn: body.expires_in, refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null } };
};

const refusedProblem = (what: string, error: string, description: string, recovery: string): ProblemError => new ProblemError(clientProblem("credential", "refused", 401,
    `The daemon refused ${what} (${error}${description.length === 0 ? "" : `: ${description}`}).`, { error, recovery }));

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

export default class Credential implements ClientCredential {
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
        if (this.#tokenEndpoint === undefined) this.#tokenEndpoint = (await discover(aguiUrl))?.tokenEndpoint ?? null;
        if (this.#tokenEndpoint === null) return null;
        const answer = await tokenRequest(this.#tokenEndpoint, { grant_type: "client_credentials", client_id: OPERATOR, client_secret: this.#secret, scope: SCOPE });
        if (!answer.ok) {
            // A daemon restarted since the file was read minted a new secret: read it once more.
            if (answer.error === "invalid_client" && this.#file !== null && !reread) {
                const current = readSecret(this.#file);
                if (current !== null && current !== this.#secret) {
                    this.#secret = current;
                    return this.#acquire(aguiUrl, now, true);
                }
            }
            throw refusedProblem("the operator's secret", answer.error, answer.description, this.#file === null
                ? "Set PLURNK_SECRET to the daemon's operator secret."
                : `Set PLURNK_SECRET to the daemon's operator secret, or let a daemon running as you mint one at ${this.#file}.`);
        }
        this.#access = { token: answer.tokens.accessToken, expiresAt: now + answer.tokens.expiresIn * 1000 };
        return this.#access;
    }
}

export interface SignInOptions {
    readonly env?: NodeJS.ProcessEnv;
    /** Where the authorization URL and the browser's fate are told. */
    readonly write: (text: string) => void;
    /** Whether a browser may be opened; headless invocations use a kept grant or are refused. */
    readonly interactive: boolean;
    /** The callback deadline, PLURNK_CLIENT_OAUTH_TIMEOUT_MS. */
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly openBrowser?: (url: string) => Promise<ChildProcess | void>;
}

// {§cli-sign-in} — the credential of an operator with no secret for the daemon: the grant a browser
// sign-in left, renewed through its refresh token with no discovery, and a new sign-in when none
// stands. Until the daemon challenges it, a client with no grant presents nothing and asks nothing.
export class SignInCredential implements ClientCredential {
    readonly #options: SignInOptions;
    readonly #env: NodeJS.ProcessEnv;
    #access: Access | null = null;
    // The daemon refused a request for want of a credential: the next acquisition signs in.
    #required = false;
    #acquiring: Promise<Access | null> | null = null;

    constructor(options: SignInOptions) {
        this.#options = options;
        this.#env = options.env ?? process.env;
    }

    async headers(aguiUrl: string, now = Date.now()): Promise<Record<string, string>> {
        if (this.#access !== null && this.#access.expiresAt > now) return { authorization: `Bearer ${this.#access.token}` };
        this.#acquiring ??= this.#acquire(aguiUrl, now).finally(() => { this.#acquiring = null; });
        const access = await this.#acquiring;
        return access === null ? {} : { authorization: `Bearer ${access.token}` };
    }

    /** The daemon refused what was presented, or the lack of it: forget the token and sign in on the next request. */
    invalidate(): void {
        this.#access = null;
        this.#required = true;
    }

    /** Signs in through the browser now, whatever grant stands, and keeps the new one. Answers the issuer. */
    async login(aguiUrl: string, now = Date.now()): Promise<string | null> {
        const metadata = await discover(aguiUrl);
        if (metadata === null) return null;
        const origin = new URL(aguiUrl).origin;
        writeGrant(origin, null, this.#env);
        this.#access = await this.#signIn(metadata, origin, now);
        return metadata.issuer;
    }

    /** Revokes the kept grant at the daemon and forgets it. Answers the issuer, or null when no grant stood. */
    async logout(aguiUrl: string): Promise<string | null> {
        const origin = new URL(aguiUrl).origin;
        const grant = readGrant(origin, this.#env);
        if (grant === null) return null;
        if (grant.revocationEndpoint !== null) {
            await fetch(grant.revocationEndpoint, {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ token: grant.refreshToken, token_type_hint: "refresh_token", client_id: grant.clientId }).toString(),
            }).catch(() => undefined);
        }
        writeGrant(origin, null, this.#env);
        this.#access = null;
        return grant.issuer;
    }

    async #acquire(aguiUrl: string, now: number): Promise<Access | null> {
        const origin = new URL(aguiUrl).origin;
        const grant = readGrant(origin, this.#env);
        if (grant !== null) {
            // A kept grant proves the daemon authenticates; it renews with no discovery.
            this.#required = true;
            const renewed = await tokenRequest(grant.tokenEndpoint, { grant_type: "refresh_token", refresh_token: grant.refreshToken, client_id: grant.clientId });
            if (renewed.ok) {
                if (renewed.tokens.refreshToken !== null) writeGrant(origin, { ...grant, refreshToken: renewed.tokens.refreshToken }, this.#env);
                this.#access = { token: renewed.tokens.accessToken, expiresAt: now + renewed.tokens.expiresIn * 1000 };
                return this.#access;
            }
            // A revoked or forgotten grant (a restarted daemon forgets every credential): sign in again.
            if (renewed.error !== "invalid_grant" && renewed.error !== "invalid_client") {
                throw refusedProblem("the kept grant", renewed.error, renewed.description, "Run `plurnk login` to sign in again.");
            }
            writeGrant(origin, null, this.#env);
        }
        if (!this.#required) return null;
        const metadata = await discover(aguiUrl);
        if (metadata === null) return null;
        if (!this.#options.interactive) {
            throw new ProblemError(clientProblem("credential", "sign-in-required", 401,
                `The daemon at ${metadata.issuer} requires a sign-in, and this client holds no grant for it.`,
                { issuer: metadata.issuer, recovery: "Run `plurnk login` on a machine with a browser, or set PLURNK_SECRET to the daemon's operator secret." }));
        }
        this.#access = await this.#signIn(metadata, origin, now);
        return this.#access;
    }

    // RFC 7591 registration, then the authorization code with PKCE (RFC 7636) through the loopback
    // callback (RFC 8252); the client exchanges the code itself and keeps the refresh token.
    async #signIn(metadata: Metadata, origin: string, now: number): Promise<Access> {
        if (metadata.authorizationEndpoint === null || metadata.registrationEndpoint === null) {
            throw new ProblemError(clientProblem("credential", "discovery-failed", 502, `The authorization server ${metadata.issuer} offers no sign-in for a public client.`, { issuer: metadata.issuer }));
        }
        const { registrationEndpoint, authorizationEndpoint, tokenEndpoint, revocationEndpoint, issuer } = metadata;
        const registered = await fetch(registrationEndpoint, {
            method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify({ client_name: CLIENT_NAME, redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }),
        });
        const registration = await registered.json().catch(() => null) as { client_id?: unknown; error?: unknown; error_description?: unknown } | null;
        if (!registered.ok || registration === null || typeof registration.client_id !== "string") {
            throw refusedProblem("this client's registration", typeof registration?.error === "string" ? registration.error : String(registered.status),
                typeof registration?.error_description === "string" ? registration.error_description : "", "Set PLURNK_SECRET to the daemon's operator secret.");
        }
        const clientId = registration.client_id;
        const verifier = randomBytes(32).toString("base64url");
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        const state = randomBytes(16).toString("base64url");
        const deadline = AbortSignal.timeout(this.#options.timeoutMs);
        const tokens = await receiveAuthorization<{ authorization: { url: string } }, TokenResponse>({
            begin: async (redirectUri) => {
                const url = new URL(authorizationEndpoint);
                for (const [key, value] of Object.entries({
                    client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPE,
                    code_challenge: challenge, code_challenge_method: "S256", state, resource: `${issuer}/agui`,
                })) url.searchParams.set(key, value);
                return { authorization: { url: url.href } };
            },
        }, async (callbackUrl) => {
            const callback = new URL(callbackUrl);
            const error = callback.searchParams.get("error");
            if (error !== null) throw refusedProblem("the sign-in", error, callback.searchParams.get("error_description") ?? "", "Run `plurnk login` to try again.");
            const answer = await tokenRequest(tokenEndpoint, {
                grant_type: "authorization_code", client_id: clientId, code: callback.searchParams.get("code") ?? "",
                redirect_uri: `${callback.origin}${callback.pathname}`, code_verifier: verifier,
            });
            if (!answer.ok) throw refusedProblem("the sign-in's code", answer.error, answer.description, "Run `plurnk login` to try again.");
            return answer.tokens;
        }, {
            signal: this.#options.signal === undefined ? deadline : AbortSignal.any([this.#options.signal, deadline]),
            write: this.#options.write,
            ...(this.#options.openBrowser === undefined ? {} : { openBrowser: this.#options.openBrowser }),
            accepted: "Signed in to Plurnk. You may close this window.",
        });
        if (tokens.refreshToken !== null) writeGrant(origin, { issuer, clientId, refreshToken: tokens.refreshToken, tokenEndpoint, revocationEndpoint }, this.#env);
        this.#required = true;
        return { token: tokens.accessToken, expiresAt: now + tokens.expiresIn * 1000 };
    }
}
