// {§cli-credential} — the client's credential, driven against a scripted authorization server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Credential, { SignInCredential } from "./credential.ts";
import { ProblemError } from "./diagnostics.ts";

interface Served {
    readonly url: string;
    readonly requests: Array<{ path: string; body: string }>;
    close(): Promise<void>;
}

// A daemon's discovery documents and token endpoint, scripted per test.
const serve = async (script: {
    resource?: (res: ServerResponse, origin: string) => void;
    metadata?: (res: ServerResponse, origin: string) => void;
    token?: (res: ServerResponse, body: URLSearchParams) => void;
}): Promise<Served> => {
    const requests: Array<{ path: string; body: string }> = [];
    let origin = "";
    const json = (res: ServerResponse, status: number, body: unknown): void => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        let body = "";
        req.on("data", (chunk: string) => { body += chunk; });
        req.on("end", () => {
            requests.push({ path: req.url ?? "", body });
            if (req.url === "/.well-known/oauth-protected-resource") {
                (script.resource ?? ((r, o) => json(r, 200, { resource: `${o}/agui`, authorization_servers: [o] })))(res, origin);
            } else if (req.url === "/.well-known/oauth-authorization-server") {
                (script.metadata ?? ((r, o) => json(r, 200, { issuer: o, token_endpoint: `${o}/oauth/token` })))(res, origin);
            } else if (req.url === "/oauth/token") {
                (script.token ?? ((r) => json(r, 200, { access_token: "access-1", token_type: "Bearer", expires_in: 3600, scope: "agui" })))(res, new URLSearchParams(body));
            } else {
                json(res, 404, { type: "https://problems.plurnk.xyz/http/route-not-found", status: 404 });
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return { url: origin, requests, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
};

test("[§cli-credential] the secret is exchanged once through discovery, then the access token is presented until it lapses", async () => {
    let minted = 0;
    const served = await serve({ token: (res, body) => {
        minted += 1;
        assert.equal(body.get("grant_type"), "client_credentials");
        assert.equal(body.get("client_id"), "operator");
        assert.equal(body.get("client_secret"), "s3cret");
        assert.equal(body.get("scope"), "agui");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: `access-${minted}`, token_type: "Bearer", expires_in: 60, scope: "agui" }));
    } });
    try {
        const credential = new Credential("s3cret");
        const agui = `${served.url}/agui`;
        assert.deepEqual(await credential.headers(agui, 1_000), { authorization: "Bearer access-1" });
        assert.deepEqual(served.requests.map(({ path }) => path), ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server", "/oauth/token"]);
        assert.deepEqual(await credential.headers(agui, 2_000), { authorization: "Bearer access-1" }, "a live token is reused without a request");
        assert.equal(minted, 1);
        assert.deepEqual(await credential.headers(agui, 61_000), { authorization: "Bearer access-2" }, "a lapsed token is renewed, with the endpoint already known");
        assert.equal(served.requests.filter(({ path }) => path.startsWith("/.well-known")).length, 2, "discovery happens once");
        credential.invalidate();
        assert.deepEqual(await credential.headers(agui, 61_000), { authorization: "Bearer access-3" }, "invalidation renews at once");
        const [a, b] = await Promise.all([new Credential("s3cret").headers(agui, 0), new Credential("s3cret").headers(agui, 0)]);
        assert.ok(a.authorization !== undefined && b.authorization !== undefined);
    } finally { await served.close(); }
});

test("[§cli-credential] concurrent first requests share one acquisition", async () => {
    let minted = 0;
    const served = await serve({ token: (res) => {
        minted += 1;
        setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ access_token: "shared", token_type: "Bearer", expires_in: 60 })); }, 20);
    } });
    try {
        const credential = new Credential("s3cret");
        const headers = await Promise.all([1, 2, 3].map(() => credential.headers(`${served.url}/agui`, 0)));
        assert.deepEqual(headers, [{ authorization: "Bearer shared" }, { authorization: "Bearer shared" }, { authorization: "Bearer shared" }]);
        assert.equal(minted, 1);
    } finally { await served.close(); }
});

test("[§cli-credential] a daemon that publishes no resource metadata authenticates nothing, and the client presents nothing", async () => {
    const served = await serve({ resource: (res) => { res.writeHead(404, { "content-type": "application/problem+json" }); res.end("{}"); } });
    try {
        const credential = new Credential("s3cret");
        assert.deepEqual(await credential.headers(`${served.url}/agui`), {});
        assert.deepEqual(await credential.headers(`${served.url}/agui`), {});
        assert.equal(served.requests.length, 1, "the answer is remembered");
    } finally { await served.close(); }
});

test("[§cli-credential] a refused secret and unreadable metadata are exact client Problems", async () => {
    const refusing = await serve({ token: (res) => { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "invalid_client", error_description: "The client secret is wrong." })); } });
    try {
        await assert.rejects(new Credential("wrong").headers(`${refusing.url}/agui`), (error: unknown) => error instanceof ProblemError
            && error.problem.type === "https://problems.plurnk.xyz/client/credential/refused"
            && error.problem.status === 401
            && /invalid_client: The client secret is wrong\./u.test(error.problem.detail));
    } finally { await refusing.close(); }
    const broken = await serve({ metadata: (res) => { res.writeHead(500); res.end("boom"); } });
    try {
        await assert.rejects(new Credential("s3cret").headers(`${broken.url}/agui`), (error: unknown) => error instanceof ProblemError
            && error.problem.type === "https://problems.plurnk.xyz/client/credential/discovery-failed");
    } finally { await broken.close(); }
    const nameless = await serve({ resource: (res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ resource: "x" })); } });
    try {
        await assert.rejects(new Credential("s3cret").headers(`${nameless.url}/agui`), (error: unknown) => error instanceof ProblemError
            && error.problem.type === "https://problems.plurnk.xyz/client/credential/discovery-failed");
    } finally { await nameless.close(); }
    const empty = await mkdtemp(join(tmpdir(), "plurnk-no-secret-"));
    try {
        assert.equal(Credential.fromEnvironment({ XDG_DATA_HOME: empty }), undefined);
        assert.equal(Credential.fromEnvironment({ PLURNK_SECRET: "", XDG_DATA_HOME: empty }), undefined);
        assert.ok(Credential.fromEnvironment({ PLURNK_SECRET: "s", XDG_DATA_HOME: empty }) instanceof Credential);
    } finally { await rm(empty, { recursive: true, force: true }); }
    assert.throws(() => new Credential(""), TypeError);
});

test("[§cli-credential] without PLURNK_SECRET the client reads the secret a daemon minted beside its database, and reads it again when the daemon refuses it", async () => {
    const data = await mkdtemp(join(tmpdir(), "plurnk-data-"));
    try {
        const file = join(data, "plurnk", "secret");
        assert.equal(Credential.secretFile({ XDG_DATA_HOME: data }), file, "beside the default database");
        assert.equal(Credential.secretFile({ XDG_DATA_HOME: data, PLURNK_SERVICE_DB_PATH: join(data, "elsewhere", "x.db") }), join(data, "elsewhere", "secret"), "beside the database the environment names");
        assert.equal(Credential.fromEnvironment({ XDG_DATA_HOME: data }), undefined, "no file, no credential");
        await mkdir(join(data, "plurnk"));
        await writeFile(file, "first\n", { mode: 0o600 });
        const presented: string[] = [];
        let restarted = false;
        const served = await serve({ token: (res, body) => {
            const secret = body.get("client_secret") ?? "";
            presented.push(secret);
            if (secret === "second") {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ access_token: "access-2", token_type: "Bearer", expires_in: 60, scope: "agui" }));
                return;
            }
            // The daemon restarted since the file was read, and minted anew.
            if (!restarted) { restarted = true; writeFileSync(file, "second\n"); }
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "invalid_client", error_description: "The client secret is wrong." }));
        } });
        try {
            const credential = Credential.fromEnvironment({ XDG_DATA_HOME: data });
            assert.ok(credential instanceof Credential, "the file's line is the secret");
            assert.deepEqual(await credential.headers(`${served.url}/agui`, 0), { authorization: "Bearer access-2" });
            assert.deepEqual(presented, ["first", "second"], "the file is read again once, after the refusal");
            await writeFile(file, "wrong\n");
            const wrong = Credential.fromEnvironment({ XDG_DATA_HOME: data });
            assert.ok(wrong instanceof Credential);
            await assert.rejects(wrong.headers(`${served.url}/agui`, 0), (error: unknown) => error instanceof ProblemError
                && error.problem.type === "https://problems.plurnk.xyz/client/credential/refused"
                && (error.problem as { recovery?: string }).recovery?.includes(file) === true,
                "a file that still refuses names itself in the recovery");
        } finally { await served.close(); }
    } finally { await rm(data, { recursive: true, force: true }); }
});

// {§cli-sign-in} — a scripted authorization server: registration, an authorize that redirects
// straight back to the loopback callback (the daemon's consent page is answered by a person, or by
// the integration fixture), and the code, refresh and revocation grants.
const authorizationServer = async (): Promise<{
    readonly url: string; readonly requests: string[]; readonly revoked: string[]; refuseRefresh: boolean; close(): Promise<void>;
}> => {
    const requests: string[] = [];
    const revoked: string[] = [];
    const codes = new Map<string, string>();
    let origin = "";
    let serial = 0;
    const state = { refuseRefresh: false };
    const json = (res: ServerResponse, status: number, body: unknown): void => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        let body = "";
        req.on("data", (chunk: string) => { body += chunk; });
        req.on("end", () => {
            const url = new URL(req.url ?? "/", origin);
            requests.push(url.pathname);
            if (url.pathname === "/.well-known/oauth-protected-resource") json(res, 200, { resource: `${origin}/agui`, authorization_servers: [origin] });
            else if (url.pathname === "/.well-known/oauth-authorization-server") {
                json(res, 200, { issuer: origin, token_endpoint: `${origin}/oauth/token`, authorization_endpoint: `${origin}/oauth/authorize`, registration_endpoint: `${origin}/oauth/register`, revocation_endpoint: `${origin}/oauth/revoke` });
            } else if (url.pathname === "/oauth/register") {
                const metadata = JSON.parse(body) as { redirect_uris: string[]; token_endpoint_auth_method: string };
                assert.deepEqual(metadata.redirect_uris, ["http://127.0.0.1/callback"]);
                assert.equal(metadata.token_endpoint_auth_method, "none");
                json(res, 201, { client_id: `client-${serial += 1}` });
            } else if (url.pathname === "/oauth/authorize") {
                const q = url.searchParams;
                assert.equal(q.get("code_challenge_method"), "S256");
                assert.equal(q.get("response_type"), "code");
                assert.equal(q.get("scope"), "agui");
                assert.match(q.get("redirect_uri") ?? "", /^http:\/\/127\.0\.0\.1:\d+\/callback$/u);
                const code = `code-${serial += 1}`;
                codes.set(code, q.get("code_challenge") ?? "");
                const target = new URL(q.get("redirect_uri")!);
                target.searchParams.set("code", code);
                target.searchParams.set("state", q.get("state") ?? "");
                res.writeHead(302, { location: target.href }); res.end();
            } else if (url.pathname === "/oauth/token") {
                const form = new URLSearchParams(body);
                if (form.get("grant_type") === "authorization_code") {
                    const challenge = codes.get(form.get("code") ?? "");
                    const verifier = form.get("code_verifier") ?? "";
                    const matches = challenge !== undefined && createHash("sha256").update(verifier).digest("base64url") === challenge;
                    if (!matches) { json(res, 400, { error: "invalid_grant", error_description: "The code or its verifier is wrong." }); return; }
                    codes.delete(form.get("code")!);
                    json(res, 200, { access_token: `access-${form.get("code")}`, token_type: "Bearer", expires_in: 60, refresh_token: `refresh-${form.get("code")}`, scope: "agui" });
                } else if (form.get("grant_type") === "refresh_token") {
                    if (state.refuseRefresh) { json(res, 400, { error: "invalid_grant", error_description: "The refresh token is unknown." }); return; }
                    assert.ok((form.get("client_id") ?? "").startsWith("client-"), "a public client refreshes by its id");
                    json(res, 200, { access_token: `access-renewed-${form.get("refresh_token")}`, token_type: "Bearer", expires_in: 60, refresh_token: `${form.get("refresh_token")}-rotated`, scope: "agui" });
                } else json(res, 400, { error: "unsupported_grant_type" });
            } else if (url.pathname === "/oauth/revoke") {
                revoked.push(new URLSearchParams(body).get("token") ?? "");
                json(res, 200, {});
            } else json(res, 404, { type: "https://problems.plurnk.xyz/http/route-not-found", status: 404 });
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return {
        url: origin, requests, revoked,
        get refuseRefresh() { return state.refuseRefresh; },
        set refuseRefresh(value: boolean) { state.refuseRefresh = value; },
        close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
    };
};

// A browser that follows the authorization to the client's loopback callback, as a person's would.
const browser = async (url: string): Promise<void> => {
    const authorization = await fetch(url, { redirect: "manual" });
    assert.equal(authorization.status, 302, await authorization.text());
    const callback = await fetch(authorization.headers.get("location")!);
    assert.equal(callback.status, 200);
    assert.match(await callback.text(), /Signed in to Plurnk/u);
};
const noBrowser = async (): Promise<void> => { throw new Error("no browser may open here"); };

test("[§cli-sign-in] with no secret the first interactive use signs in through the browser and keeps the grant; later uses renew it with no browser", async () => {
    const served = await authorizationServer();
    const state = await mkdtemp(join(tmpdir(), "plurnk-state-"));
    const env = { XDG_STATE_HOME: state };
    const quiet = (): void => undefined;
    try {
        const agui = `${served.url}/agui`;
        const first = new SignInCredential({ env, write: quiet, interactive: true, timeoutMs: 5_000, openBrowser: browser });
        assert.deepEqual(await first.headers(agui, 0), {}, "with no grant and no challenge yet, nothing is presented");
        assert.equal(served.requests.length, 0, "and nothing is asked of the daemon");
        first.invalidate();   // the daemon answered bearer-token-required
        assert.deepEqual(await first.headers(agui, 0), { authorization: "Bearer access-code-2" });
        assert.deepEqual(served.requests.filter((path) => path.startsWith("/oauth")), ["/oauth/register", "/oauth/authorize", "/oauth/token"]);
        const file = join(state, "plurnk", "grants.json");
        assert.equal((await stat(file)).mode & 0o777, 0o600);
        assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { version: 1, daemons: { [served.url]: {
            issuer: served.url, clientId: "client-1", refreshToken: "refresh-code-2", tokenEndpoint: `${served.url}/oauth/token`, revocationEndpoint: `${served.url}/oauth/revoke`,
        } } });
        assert.deepEqual(await first.headers(agui, 1_000), { authorization: "Bearer access-code-2" }, "a live token is reused");
        const later = new SignInCredential({ env, write: quiet, interactive: false, timeoutMs: 5_000, openBrowser: noBrowser });
        assert.deepEqual(await later.headers(agui, 0), { authorization: "Bearer access-renewed-refresh-code-2" }, "a kept grant renews headlessly");
        assert.equal(JSON.parse(await readFile(file, "utf8")).daemons[served.url].refreshToken, "refresh-code-2-rotated", "the rotated refresh token is kept");
        assert.equal(served.requests.filter((path) => path.startsWith("/.well-known")).length, 2, "a kept grant renews with no discovery");
        served.refuseRefresh = true;
        const headless = new SignInCredential({ env, write: quiet, interactive: false, timeoutMs: 5_000, openBrowser: noBrowser });
        await assert.rejects(headless.headers(agui, 0), (error: unknown) => error instanceof ProblemError
            && error.problem.type === "https://problems.plurnk.xyz/client/credential/sign-in-required"
            && /plurnk login/u.test((error.problem as { recovery?: string }).recovery ?? ""));
        assert.deepEqual(JSON.parse(await readFile(file, "utf8")).daemons, {}, "a grant the daemon no longer knows is forgotten");
        const again = new SignInCredential({ env, write: quiet, interactive: true, timeoutMs: 5_000, openBrowser: browser });
        again.invalidate();   // the daemon challenged the request that presented nothing
        assert.match((await again.headers(agui, 0)).authorization ?? "", /^Bearer access-code-/u, "an interactive use signs in again");
        served.refuseRefresh = false;
        const signedIn = new SignInCredential({ env, write: quiet, interactive: false, timeoutMs: 5_000, openBrowser: noBrowser });
        const issuer = await signedIn.logout(agui);
        assert.equal(issuer, served.url);
        assert.equal(served.revoked.length, 1);
        assert.deepEqual(JSON.parse(await readFile(file, "utf8")).daemons, {}, "and forgotten");
        assert.equal(await signedIn.logout(agui), null, "nothing to sign out of");
        const forced = new SignInCredential({ env, write: quiet, interactive: false, timeoutMs: 5_000, openBrowser: browser });
        assert.equal(await forced.login(agui), served.url, "login signs in whatever the invocation's interactivity");
        assert.match((await forced.headers(agui, 0)).authorization ?? "", /^Bearer access-code-/u);
    } finally { await served.close(); await rm(state, { recursive: true, force: true }); }
});

test("[§cli-sign-in] a daemon that authenticates nothing needs no sign-in, and a browser is never opened for it", async () => {
    const served = await serve({ resource: (res) => { res.writeHead(404, { "content-type": "application/problem+json" }); res.end("{}"); } });
    const state = await mkdtemp(join(tmpdir(), "plurnk-state-"));
    try {
        const credential = new SignInCredential({ env: { XDG_STATE_HOME: state }, write: () => undefined, interactive: true, timeoutMs: 5_000, openBrowser: noBrowser });
        assert.deepEqual(await credential.headers(`${served.url}/agui`), {});
        assert.equal(await credential.login(`${served.url}/agui`), null);
        assert.equal(await credential.logout(`${served.url}/agui`), null);
    } finally { await served.close(); await rm(state, { recursive: true, force: true }); }
});
