// OAuth 2.1 credential exchange, PKCE browser sign-in, and grant persistence for @plurnk/plurnk ({§cli-problems-and-notices}).

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { receiveAuthorization } from "./oauth.ts";

export interface StoredGrant {
    readonly issuer: string;
    readonly clientId: string;
    readonly accessToken: string;
    readonly refreshToken?: string;
    readonly expiresAt: number;
    readonly tokenEndpoint?: string;
    readonly revocationEndpoint?: string;
}

export interface CredentialLoginOptions {
    readonly signal: AbortSignal;
    readonly write?: (message: string) => void;
    readonly openBrowser?: (url: string) => Promise<void>;
    readonly redirectUrl?: string;
}

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

const resolveGrantsPath = (env: Record<string, string | undefined>): string => {
    const stateHome = env.XDG_STATE_HOME;
    const base = typeof stateHome === "string" && stateHome.trim().length > 0
        ? stateHome.trim()
        : join(env.HOME ?? homedir(), ".local", "state");
    return join(base, "plurnk", "grants.json");
};

const readGrantsStore = (grantsPath: string): Record<string, StoredGrant> => {
    if (!existsSync(grantsPath)) return {};
    try {
        const parsed: unknown = JSON.parse(readFileSync(grantsPath, "utf8"));
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, StoredGrant>;
        }
    } catch {
        // ignore malformed or unreadable store
    }
    return {};
};

const writeGrantsStore = (grantsPath: string, store: Record<string, StoredGrant>): void => {
    mkdirSync(dirname(grantsPath), { recursive: true, mode: 0o700 });
    writeFileSync(grantsPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    try {
        chmodSync(grantsPath, 0o600);
    } catch {
        // ignore chmod failures on unsupported filesystems
    }
};

const toHttpOrigin = (rawUrl: string): string => {
    const url = new URL(rawUrl);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    return url.origin;
};

interface DiscoveredOAuthEndpoints {
    readonly issuer: string;
    readonly authorizationEndpoint: string;
    readonly tokenEndpoint: string;
    readonly revocationEndpoint: string;
    readonly registrationEndpoint: string;
}

const discoverEndpoints = async (origin: string, signal?: AbortSignal): Promise<DiscoveredOAuthEndpoints> => {
    let authServerOrigin = origin;
    try {
        const resMeta = await fetch(`${origin}/.well-known/oauth-protected-resource`, {
            headers: { accept: "application/json" },
            ...(signal !== undefined ? { signal } : {}),
        });
        if (resMeta.ok) {
            const doc = (await resMeta.json()) as { authorization_servers?: unknown };
            if (Array.isArray(doc.authorization_servers) && typeof doc.authorization_servers[0] === "string") {
                authServerOrigin = toHttpOrigin(doc.authorization_servers[0]);
            }
        }
    } catch {
        // fallback to origin
    }
    try {
        const asMeta = await fetch(`${authServerOrigin}/.well-known/oauth-authorization-server`, {
            headers: { accept: "application/json" },
            ...(signal !== undefined ? { signal } : {}),
        });
        if (asMeta.ok) {
            const doc = (await asMeta.json()) as {
                issuer?: string;
                authorization_endpoint?: string;
                token_endpoint?: string;
                revocation_endpoint?: string;
                registration_endpoint?: string;
            };
            const issuer = typeof doc.issuer === "string" && doc.issuer.length > 0 ? doc.issuer : authServerOrigin;
            return {
                issuer,
                authorizationEndpoint: typeof doc.authorization_endpoint === "string"
                    ? doc.authorization_endpoint
                    : `${issuer}/oauth/authorize`,
                tokenEndpoint: typeof doc.token_endpoint === "string"
                    ? doc.token_endpoint
                    : `${issuer}/oauth/token`,
                revocationEndpoint: typeof doc.revocation_endpoint === "string"
                    ? doc.revocation_endpoint
                    : `${issuer}/oauth/revoke`,
                registrationEndpoint: typeof doc.registration_endpoint === "string"
                    ? doc.registration_endpoint
                    : `${issuer}/oauth/register`,
            };
        }
    } catch {
        // fallback to standard endpoints on authServerOrigin
    }
    return {
        issuer: authServerOrigin,
        authorizationEndpoint: `${authServerOrigin}/oauth/authorize`,
        tokenEndpoint: `${authServerOrigin}/oauth/token`,
        revocationEndpoint: `${authServerOrigin}/oauth/revoke`,
        registrationEndpoint: `${authServerOrigin}/oauth/register`,
    };
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

    grantsPath(): string {
        return resolveGrantsPath(this.#env);
    }

    invalidate(): void {
        this.#cachedToken = null;
        this.#cachedExpiresAt = 0;
    }

    async token(acpUrl: string): Promise<string | null> {
        if (this.#cachedToken !== null && Date.now() < this.#cachedExpiresAt) {
            return this.#cachedToken;
        }
        const origin = toHttpOrigin(acpUrl);

        if (this.#explicitSecret === null) {
            const grantsPath = this.grantsPath();
            const store = readGrantsStore(grantsPath);
            const stored = store[origin];
            if (stored !== undefined) {
                if (typeof stored.accessToken === "string" && stored.accessToken.length > 0 && Date.now() < stored.expiresAt) {
                    this.#cachedToken = stored.accessToken;
                    this.#cachedExpiresAt = stored.expiresAt;
                    return this.#cachedToken;
                }
                if (typeof stored.refreshToken === "string" && stored.refreshToken.length > 0) {
                    const tokenEndpoint = stored.tokenEndpoint ?? `${origin}/oauth/token`;
                    try {
                        const refreshBody = new URLSearchParams({
                            grant_type: "refresh_token",
                            client_id: stored.clientId,
                            refresh_token: stored.refreshToken,
                            scope: "acp",
                        });
                        const res = await fetch(tokenEndpoint, {
                            method: "POST",
                            headers: {
                                "content-type": "application/x-www-form-urlencoded",
                                accept: "application/json",
                            },
                            body: refreshBody.toString(),
                        });
                        if (res.ok) {
                            const json = (await res.json()) as {
                                access_token?: string;
                                refresh_token?: string;
                                expires_in?: number;
                            };
                            if (typeof json.access_token === "string" && json.access_token.length > 0) {
                                const ttlSec = typeof json.expires_in === "number" && json.expires_in > 10 ? json.expires_in - 5 : 60;
                                const expiresAt = Date.now() + ttlSec * 1000;
                                const updated: StoredGrant = {
                                    ...stored,
                                    accessToken: json.access_token,
                                    ...(typeof json.refresh_token === "string" && json.refresh_token.length > 0
                                        ? { refreshToken: json.refresh_token }
                                        : {}),
                                    expiresAt,
                                };
                                store[origin] = updated;
                                writeGrantsStore(grantsPath, store);
                                this.#cachedToken = updated.accessToken;
                                this.#cachedExpiresAt = expiresAt;
                                return this.#cachedToken;
                            }
                        } else if (res.status === 400 || res.status === 401) {
                            delete store[origin];
                            writeGrantsStore(grantsPath, store);
                        }
                    } catch {
                        // network error during refresh; fall through to secret if present
                    }
                }
            }
        }

        const secret = this.#explicitSecret ?? resolveSecretFromEnv(this.#env);
        if (secret === null) return null;

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

    async login(acpUrl: string, options: CredentialLoginOptions): Promise<StoredGrant> {
        const origin = toHttpOrigin(acpUrl);
        const endpoints = await discoverEndpoints(origin, options.signal);
        const codeVerifier = randomBytes(32).toString("base64url");
        const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
        const state = randomBytes(24).toString("base64url");

        let registeredClientId = "";
        let activeRedirectUri = "";
        let grantedStore: StoredGrant | null = null;

        await receiveAuthorization(
            {
                ...(options.redirectUrl !== undefined ? { redirectUrl: options.redirectUrl } : {}),
                begin: async (boundRedirectUrl) => {
                    activeRedirectUri = boundRedirectUrl;
                    const regRes = await fetch(endpoints.registrationEndpoint, {
                        method: "POST",
                        headers: {
                            "content-type": "application/json",
                            accept: "application/json",
                        },
                        body: JSON.stringify({
                            client_name: "@plurnk/plurnk",
                            redirect_uris: [boundRedirectUrl],
                            token_endpoint_auth_method: "none",
                            grant_types: ["authorization_code", "refresh_token"],
                            response_types: ["code"],
                            scope: "acp",
                        }),
                        signal: options.signal,
                    });
                    if (!regRes.ok) {
                        let detail = `OAuth client registration failed (${regRes.status}).`;
                        try {
                            const errJson = (await regRes.json()) as { error_description?: string; error?: string };
                            if (typeof errJson.error_description === "string") detail = errJson.error_description;
                            else if (typeof errJson.error === "string") detail = errJson.error;
                        } catch {
                            // use default detail
                        }
                        throw new Error(detail);
                    }
                    const regJson = (await regRes.json()) as { client_id?: string };
                    if (typeof regJson.client_id !== "string" || regJson.client_id.length === 0) {
                        throw new Error("OAuth registration did not return a client_id.");
                    }
                    registeredClientId = regJson.client_id;

                    const authUrl = new URL(endpoints.authorizationEndpoint);
                    authUrl.searchParams.set("response_type", "code");
                    authUrl.searchParams.set("client_id", registeredClientId);
                    authUrl.searchParams.set("redirect_uri", boundRedirectUrl);
                    authUrl.searchParams.set("scope", "acp");
                    authUrl.searchParams.set("state", state);
                    authUrl.searchParams.set("code_challenge", codeChallenge);
                    authUrl.searchParams.set("code_challenge_method", "S256");
                    return {
                        status: 202,
                        alias: "plurnk",
                        authorization: { url: authUrl.href },
                    };
                },
            },
            async (callbackUrl) => {
                const cb = new URL(callbackUrl);
                if (cb.searchParams.has("error")) {
                    const errDesc = cb.searchParams.get("error_description") ?? cb.searchParams.get("error") ?? "OAuth authorization failed.";
                    throw new Error(errDesc);
                }
                const code = cb.searchParams.get("code");
                if (code === null || code.length === 0) {
                    throw new Error("OAuth callback did not contain an authorization code.");
                }
                const tokenBody = new URLSearchParams({
                    grant_type: "authorization_code",
                    client_id: registeredClientId,
                    code,
                    redirect_uri: activeRedirectUri,
                    code_verifier: codeVerifier,
                });
                const tokenRes = await fetch(endpoints.tokenEndpoint, {
                    method: "POST",
                    headers: {
                        "content-type": "application/x-www-form-urlencoded",
                        accept: "application/json",
                    },
                    body: tokenBody.toString(),
                    signal: options.signal,
                });
                if (!tokenRes.ok) {
                    let detail = `OAuth token exchange failed (${tokenRes.status}).`;
                    try {
                        const errJson = (await tokenRes.json()) as { error_description?: string; error?: string };
                        if (typeof errJson.error_description === "string") detail = errJson.error_description;
                        else if (typeof errJson.error === "string") detail = errJson.error;
                    } catch {
                        // use default detail
                    }
                    throw new Error(detail);
                }
                const tokenJson = (await tokenRes.json()) as {
                    access_token?: string;
                    refresh_token?: string;
                    expires_in?: number;
                };
                if (typeof tokenJson.access_token !== "string" || tokenJson.access_token.length === 0) {
                    throw new Error("OAuth token endpoint did not return an access_token.");
                }
                const ttlSec = typeof tokenJson.expires_in === "number" && tokenJson.expires_in > 10
                    ? tokenJson.expires_in - 5
                    : 60;
                const expiresAt = Date.now() + ttlSec * 1000;
                const grant: StoredGrant = {
                    issuer: endpoints.issuer,
                    clientId: registeredClientId,
                    accessToken: tokenJson.access_token,
                    ...(typeof tokenJson.refresh_token === "string" && tokenJson.refresh_token.length > 0
                        ? { refreshToken: tokenJson.refresh_token }
                        : {}),
                    expiresAt,
                    tokenEndpoint: endpoints.tokenEndpoint,
                    revocationEndpoint: endpoints.revocationEndpoint,
                };
                const grantsPath = this.grantsPath();
                const store = readGrantsStore(grantsPath);
                store[origin] = grant;
                writeGrantsStore(grantsPath, store);
                this.#cachedToken = grant.accessToken;
                this.#cachedExpiresAt = expiresAt;
                grantedStore = grant;
                return { status: 200, alias: "plurnk" };
            },
            {
                signal: options.signal,
                write: options.write ?? ((msg) => process.stderr.write(msg)),
                ...(options.openBrowser !== undefined ? { openBrowser: options.openBrowser } : {}),
            },
        );

        if (grantedStore === null) {
            throw new Error("OAuth login did not complete.");
        }
        return grantedStore;
    }

    async logout(acpUrl: string): Promise<{ readonly revoked: boolean; readonly origin: string }> {
        this.invalidate();
        const origin = toHttpOrigin(acpUrl);
        const grantsPath = this.grantsPath();
        const store = readGrantsStore(grantsPath);
        const stored = store[origin];
        if (stored === undefined) {
            return { revoked: false, origin };
        }
        delete store[origin];
        writeGrantsStore(grantsPath, store);

        const revocationEndpoint = stored.revocationEndpoint ?? `${origin}/oauth/revoke`;
        const tokenToRevoke = stored.refreshToken ?? stored.accessToken;
        try {
            const body = new URLSearchParams({
                client_id: stored.clientId,
                token: tokenToRevoke,
            });
            await fetch(revocationEndpoint, {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                },
                body: body.toString(),
            });
        } catch {
            // best-effort revocation if daemon is unreachable
        }
        return { revoked: true, origin };
    }

    async headers(acpUrl: string): Promise<Record<string, string>> {
        const tok = await this.token(acpUrl);
        return tok !== null ? { authorization: `Bearer ${tok}` } : {};
    }
}
