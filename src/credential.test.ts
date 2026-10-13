// {§cli-credential} — the client's credential, driven against a scripted authorization server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import Credential from "./credential.ts";
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
    assert.equal(Credential.fromEnvironment({}), undefined);
    assert.equal(Credential.fromEnvironment({ PLURNK_AGUI_SECRET: "" }), undefined);
    assert.ok(Credential.fromEnvironment({ PLURNK_AGUI_SECRET: "s" }) instanceof Credential);
    assert.throws(() => new Credential(""), TypeError);
});
