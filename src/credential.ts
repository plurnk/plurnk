// OIDC / OAuth 2.1 PKCE browser sign-in and grant persistence for @plurnk/plurnk ({§cli-problems-and-notices}).

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

export const toHttpOrigin = (rawUrl: string): string => {
    const url = new URL(rawUrl);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    return url.origin;
};

const normalizeIssuerBase = (rawUrl: string): string => {
    const url = new URL(rawUrl);
    if (url.protocol === "ws:") url.protocol = "http:";
    else if (url.protocol === "wss:") url.protocol = "https:";
    url.search = "";
    url.hash = "";
    const cleanPath = url.pathname.replace(/\/+$/u, "");
    return `${url.origin}${cleanPath}`;
};

const isThreeSegmentJwt = (value: unknown): value is string => {
    if (typeof value !== "string" || value.length === 0) return false;
    const parts = value.split(".");
    return (
        parts.length === 3 &&
        parts.every((part) => part.length > 0 && /^[A-Za-z0-9_-]+$/u.test(part))
    );
};

const selectBearerToken = (json: {
    readonly access_token?: unknown;
    readonly id_token?: unknown;
}): string | null => {
    const accessToken =
        typeof json.access_token === "string" && json.access_token.length > 0
            ? json.access_token
            : null;
    if (accessToken !== null && isThreeSegmentJwt(accessToken)) {
        return accessToken;
    }
    if (isThreeSegmentJwt(json.id_token)) {
        return json.id_token;
    }
    return accessToken;
};

const computeExpiresAt = (expiresIn: unknown, token: string): number => {
    if (typeof expiresIn === "number" && Number.isFinite(expiresIn)) {
        if (expiresIn <= 0) {
            return Date.now();
        }
        const ttlSec = expiresIn > 10 ? expiresIn - 5 : expiresIn;
        return Date.now() + ttlSec * 1000;
    }
    if (isThreeSegmentJwt(token)) {
        try {
            const payloadRaw = Buffer.from(token.split(".")[1]!, "base64url").toString("utf8");
            const payload = JSON.parse(payloadRaw) as { exp?: unknown };
            if (typeof payload.exp === "number" && Number.isFinite(payload.exp)) {
                const candidate = payload.exp * 1000 - 5000;
                if (candidate > Date.now()) {
                    return candidate;
                }
            }
        } catch {
            // fallback to default window
        }
    }
    return Date.now() + 60 * 1000;
};

interface AuthorizationServerMetadata {
    readonly issuer?: unknown;
    readonly authorization_endpoint?: unknown;
    readonly token_endpoint?: unknown;
    readonly revocation_endpoint?: unknown;
    readonly registration_endpoint?: unknown;
}

interface DiscoveredOAuthEndpoints {
    readonly issuer: string;
    readonly authorizationEndpoint: string;
    readonly tokenEndpoint: string;
    readonly revocationEndpoint?: string;
    readonly registrationEndpoint?: string;
    readonly clientId?: string;
    readonly scope: string;
}

const fetchJsonIfOk = async <T>(url: string, signal?: AbortSignal): Promise<T | null> => {
    try {
        const res = await fetch(url, {
            headers: { accept: "application/json" },
            ...(signal !== undefined ? { signal } : {}),
        });
        if (!res.ok) return null;
        const parsed: unknown = await res.json();
        return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as T)
            : null;
    } catch {
        return null;
    }
};

const discoverEndpoints = async (origin: string, signal?: AbortSignal): Promise<DiscoveredOAuthEndpoints> => {
    let authServerBase = origin;
    let configuredClientId: string | undefined;
    let resourceScopes: string | undefined;

    const protectedMeta = await fetchJsonIfOk<{
        authorization_servers?: unknown;
        client_id?: unknown;
        scopes_supported?: unknown;
    }>(`${origin}/.well-known/oauth-protected-resource`, signal);

    if (protectedMeta !== null) {
        if (
            Array.isArray(protectedMeta.authorization_servers) &&
            typeof protectedMeta.authorization_servers[0] === "string" &&
            protectedMeta.authorization_servers[0].trim().length > 0
        ) {
            authServerBase = normalizeIssuerBase(protectedMeta.authorization_servers[0].trim());
        }
        if (typeof protectedMeta.client_id === "string" && protectedMeta.client_id.trim().length > 0) {
            configuredClientId = protectedMeta.client_id.trim();
        }
        if (Array.isArray(protectedMeta.scopes_supported)) {
            const scopes = protectedMeta.scopes_supported
                .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
                .map((s) => s.trim());
            if (scopes.length > 0) {
                resourceScopes = scopes.join(" ");
            }
        }
    }

    let usedOpenIdConfiguration = false;
    let asMeta = await fetchJsonIfOk<AuthorizationServerMetadata>(
        `${authServerBase}/.well-known/openid-configuration`,
        signal,
    );
    if (asMeta !== null) {
        usedOpenIdConfiguration = true;
    } else {
        asMeta = await fetchJsonIfOk<AuthorizationServerMetadata>(
            `${authServerBase}/.well-known/oauth-authorization-server`,
            signal,
        );
        if (asMeta === null) {
            const authServerOrigin = toHttpOrigin(authServerBase);
            if (authServerOrigin !== authServerBase) {
                asMeta = await fetchJsonIfOk<AuthorizationServerMetadata>(
                    `${authServerOrigin}/.well-known/oauth-authorization-server`,
                    signal,
                );
            }
        }
    }

    if (
        asMeta === null ||
        typeof asMeta.authorization_endpoint !== "string" ||
        asMeta.authorization_endpoint.length === 0 ||
        typeof asMeta.token_endpoint !== "string" ||
        asMeta.token_endpoint.length === 0
    ) {
        throw new Error(
            `OAuth discovery for ${origin} did not advertise authorization_endpoint and token_endpoint.`,
        );
    }
    const scope = resourceScopes ?? (usedOpenIdConfiguration ? "openid profile email" : "acp");
    const issuer =
        typeof asMeta.issuer === "string" && asMeta.issuer.length > 0
            ? asMeta.issuer
            : authServerBase;
    const authorizationEndpoint = asMeta.authorization_endpoint;
    const tokenEndpoint = asMeta.token_endpoint;
    const revocationEndpoint =
        typeof asMeta.revocation_endpoint === "string" && asMeta.revocation_endpoint.length > 0
            ? asMeta.revocation_endpoint
            : undefined;
    const registrationEndpoint =
        typeof asMeta.registration_endpoint === "string" && asMeta.registration_endpoint.length > 0
            ? asMeta.registration_endpoint
            : undefined;

    return {
        issuer,
        authorizationEndpoint,
        tokenEndpoint,
        ...(revocationEndpoint !== undefined ? { revocationEndpoint } : {}),
        ...(registrationEndpoint !== undefined ? { registrationEndpoint } : {}),
        ...(configuredClientId !== undefined ? { clientId: configuredClientId } : {}),
        scope,
    };
};

export default class Credential {
    readonly #env: Record<string, string | undefined>;
    readonly #refreshInFlight = new Map<string, Promise<string | null>>();
    #cachedOrigin: string | null = null;
    #cachedToken: string | null = null;
    #cachedExpiresAt = 0;
    #invalidatedToken: string | null = null;

    constructor(env?: Record<string, string | undefined> | null) {
        this.#env = env ?? process.env;
    }

    grantsPath(): string {
        return resolveGrantsPath(this.#env);
    }

    invalidate(): void {
        if (this.#cachedToken !== null) {
            this.#invalidatedToken = this.#cachedToken;
        }
        this.#cachedOrigin = null;
        this.#cachedToken = null;
        this.#cachedExpiresAt = 0;
    }

    async token(acpUrl: string): Promise<string | null> {
        const origin = toHttpOrigin(acpUrl);
        if (this.#cachedOrigin === origin && this.#cachedToken !== null && Date.now() < this.#cachedExpiresAt) {
            return this.#cachedToken;
        }

        const inflight = this.#refreshInFlight.get(origin);
        if (inflight !== undefined) {
            return await inflight;
        }

        const grantsPath = this.grantsPath();
        const store = readGrantsStore(grantsPath);
        const stored = store[origin];
        if (stored === undefined) {
            return null;
        }

        if (
            typeof stored.accessToken === "string" &&
            stored.accessToken.length > 0 &&
            stored.accessToken !== this.#invalidatedToken &&
            Date.now() < stored.expiresAt
        ) {
            this.#cachedOrigin = origin;
            this.#cachedToken = stored.accessToken;
            this.#cachedExpiresAt = stored.expiresAt;
            return this.#cachedToken;
        }

        if (typeof stored.refreshToken === "string" && stored.refreshToken.length > 0) {
            const refreshable = { ...stored, refreshToken: stored.refreshToken };
            const refreshPromise = this.#refreshOrigin(origin, grantsPath, refreshable).finally(() => {
                if (this.#refreshInFlight.get(origin) === refreshPromise) {
                    this.#refreshInFlight.delete(origin);
                }
            });
            this.#refreshInFlight.set(origin, refreshPromise);
            return await refreshPromise;
        }

        return null;
    }

    async #refreshOrigin(
        origin: string,
        grantsPath: string,
        stored: StoredGrant & { readonly refreshToken: string },
    ): Promise<string | null> {
        if (typeof stored.tokenEndpoint !== "string" || stored.tokenEndpoint.length === 0) {
            return null;
        }
        try {
            const refreshBody = new URLSearchParams({
                grant_type: "refresh_token",
                client_id: stored.clientId,
                refresh_token: stored.refreshToken,
            });
            const res = await fetch(stored.tokenEndpoint, {
                method: "POST",
                headers: {
                    "content-type": "application/x-www-form-urlencoded",
                    accept: "application/json",
                },
                body: refreshBody.toString(),
            });
            if (res.ok) {
                const json = (await res.json()) as {
                    access_token?: unknown;
                    id_token?: unknown;
                    refresh_token?: unknown;
                    expires_in?: unknown;
                };
                const bearer = selectBearerToken(json);
                if (bearer !== null) {
                    const expiresAt = computeExpiresAt(json.expires_in, bearer);
                    const updated: StoredGrant = {
                        ...stored,
                        accessToken: bearer,
                        ...(typeof json.refresh_token === "string" && json.refresh_token.length > 0
                            ? { refreshToken: json.refresh_token }
                            : {}),
                        expiresAt,
                    };
                    const latestStore = readGrantsStore(grantsPath);
                    latestStore[origin] = updated;
                    writeGrantsStore(grantsPath, latestStore);
                    this.#invalidatedToken = null;
                    this.#cachedOrigin = origin;
                    this.#cachedToken = updated.accessToken;
                    this.#cachedExpiresAt = expiresAt;
                    return this.#cachedToken;
                }
            } else if (res.status === 400 || res.status === 401) {
                const latestStore = readGrantsStore(grantsPath);
                const diskGrant = latestStore[origin];
                if (
                    diskGrant !== undefined &&
                    diskGrant.refreshToken !== stored.refreshToken &&
                    typeof diskGrant.accessToken === "string" &&
                    diskGrant.accessToken.length > 0 &&
                    Date.now() < diskGrant.expiresAt
                ) {
                    this.#invalidatedToken = null;
                    this.#cachedOrigin = origin;
                    this.#cachedToken = diskGrant.accessToken;
                    this.#cachedExpiresAt = diskGrant.expiresAt;
                    return this.#cachedToken;
                }
                if (diskGrant !== undefined && diskGrant.refreshToken === stored.refreshToken) {
                    delete latestStore[origin];
                    writeGrantsStore(grantsPath, latestStore);
                }
            }
        } catch {
            // network error during refresh
        }
        return null;
    }

    async login(acpUrl: string, options: CredentialLoginOptions): Promise<StoredGrant> {
        const origin = toHttpOrigin(acpUrl);
        const endpoints = await discoverEndpoints(origin, options.signal);
        const codeVerifier = randomBytes(32).toString("base64url");
        const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
        const state = randomBytes(24).toString("base64url");

        let resolvedClientId = "";
        let activeRedirectUri = "";
        let grantedStore: StoredGrant | null = null;

        await receiveAuthorization(
            {
                ...(options.redirectUrl !== undefined ? { redirectUrl: options.redirectUrl } : {}),
                begin: async (boundRedirectUrl) => {
                    activeRedirectUri = boundRedirectUrl;
                    if (endpoints.clientId !== undefined) {
                        resolvedClientId = endpoints.clientId;
                    } else if (endpoints.registrationEndpoint !== undefined) {
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
                                scope: endpoints.scope,
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
                        resolvedClientId = regJson.client_id;
                    } else {
                        throw new Error("OAuth discovery did not advertise a client_id or registration_endpoint.");
                    }

                    const authUrl = new URL(endpoints.authorizationEndpoint);
                    authUrl.searchParams.set("response_type", "code");
                    authUrl.searchParams.set("client_id", resolvedClientId);
                    authUrl.searchParams.set("redirect_uri", boundRedirectUrl);
                    authUrl.searchParams.set("scope", endpoints.scope);
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
                    const errDesc =
                        cb.searchParams.get("error_description") ??
                        cb.searchParams.get("error") ??
                        "OAuth authorization failed.";
                    throw new Error(errDesc);
                }
                const code = cb.searchParams.get("code");
                if (code === null || code.length === 0) {
                    throw new Error("OAuth callback did not contain an authorization code.");
                }
                const tokenBody = new URLSearchParams({
                    grant_type: "authorization_code",
                    client_id: resolvedClientId,
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
                    access_token?: unknown;
                    id_token?: unknown;
                    refresh_token?: unknown;
                    expires_in?: unknown;
                };
                const bearer = selectBearerToken(tokenJson);
                if (bearer === null) {
                    throw new Error("OAuth token endpoint did not return an access_token.");
                }
                const expiresAt = computeExpiresAt(tokenJson.expires_in, bearer);
                const grant: StoredGrant = {
                    issuer: endpoints.issuer,
                    clientId: resolvedClientId,
                    accessToken: bearer,
                    ...(typeof tokenJson.refresh_token === "string" && tokenJson.refresh_token.length > 0
                        ? { refreshToken: tokenJson.refresh_token }
                        : {}),
                    expiresAt,
                    tokenEndpoint: endpoints.tokenEndpoint,
                    ...(endpoints.revocationEndpoint !== undefined
                        ? { revocationEndpoint: endpoints.revocationEndpoint }
                        : {}),
                };
                const grantsPath = this.grantsPath();
                const store = readGrantsStore(grantsPath);
                store[origin] = grant;
                writeGrantsStore(grantsPath, store);
                this.#invalidatedToken = null;
                this.#cachedOrigin = origin;
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

        if (typeof stored.revocationEndpoint === "string" && stored.revocationEndpoint.length > 0) {
            const tokenToRevoke = stored.refreshToken ?? stored.accessToken;
            try {
                const body = new URLSearchParams({
                    client_id: stored.clientId,
                    token: tokenToRevoke,
                });
                await fetch(stored.revocationEndpoint, {
                    method: "POST",
                    headers: {
                        "content-type": "application/x-www-form-urlencoded",
                    },
                    body: body.toString(),
                });
            } catch {
                // best-effort revocation if authorization server is unreachable
            }
        }
        return { revoked: true, origin };
    }

    async headers(acpUrl: string): Promise<Record<string, string>> {
        const tok = await this.token(acpUrl);
        return tok !== null ? { authorization: `Bearer ${tok}` } : {};
    }

    async operatorHeaders(acpUrl: string): Promise<Record<string, string>> {
        return await this.headers(acpUrl);
    }
}
