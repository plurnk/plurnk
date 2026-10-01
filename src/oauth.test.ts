import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { receiveAuthorization } from "./oauth.ts";

const redirectUrl = async (host = "127.0.0.1"): Promise<string> => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, host, resolve); });
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return `http://${host.includes(":") ? `[${host}]` : host}:${port}/callback`;
};

const authorizationUrl = (redirect: string): string => {
    const url = new URL("https://identity.example/authorize");
    url.searchParams.set("redirect_uri", redirect);
    url.searchParams.set("state", "expected-state");
    return url.href;
};

const callbackUrl = (redirect: string): string => {
    const url = new URL(redirect);
    url.searchParams.set("code", "private-code");
    url.searchParams.set("state", "expected-state");
    url.searchParams.set("iss", "https://identity.example");
    return url.href;
};
const noBrowserFailure = (message: string): never => assert.fail(message);

test("[§cli-mcp-oauth-callback] listener precedes browser launch and forwards one complete callback", async () => {
    const redirect = await redirectUrl();
    const received: string[] = [];
    const completed = { status: 200, definition: { state: "active" } };
    let browserResponse: Response | undefined;
    const result = await receiveAuthorization(authorizationUrl(redirect), async (url) => {
        received.push(url);
        return completed;
    }, {
        signal: AbortSignal.timeout(2_000), write: noBrowserFailure,
        openBrowser: async (url) => {
            assert.equal(url, authorizationUrl(redirect));
            browserResponse = await fetch(callbackUrl(redirect));
        },
    });
    assert.deepEqual(result, completed);
    assert.deepEqual(received, [callbackUrl(redirect)]);
    assert.equal(browserResponse?.status, 200);
    assert.doesNotMatch(await browserResponse!.text(), /private-code|expected-state/u);
    await assert.rejects(fetch(redirect), /fetch failed/u, "listener closed");
});

test("[§cli-mcp-oauth-callback] unrelated, forged and ambiguous requests cannot consume the callback", async () => {
    const redirect = await redirectUrl();
    const received: string[] = [];
    await receiveAuthorization(authorizationUrl(redirect), async (url) => { received.push(url); }, {
        signal: AbortSignal.timeout(2_000), write: noBrowserFailure,
        openBrowser: async () => {
            for (const [url, status] of [
                [redirect.replace("/callback", "/favicon.ico"), 404],
                [`${redirect}?state=wrong&code=x`, 400],
                [`${callbackUrl(redirect)}&state=other`, 400],
                [`${callbackUrl(redirect)}&code=other`, 400],
                [`${callbackUrl(redirect)}&iss=other`, 400],
                [`${callbackUrl(redirect)}&error=access_denied`, 400],
            ] as const) {
                assert.equal((await fetch(url)).status, status, url);
            }
            assert.equal((await fetch(callbackUrl(redirect), { method: "POST" })).status, 405);
            const hostStatus = await new Promise<number>((resolve, reject) => {
                const req = request(callbackUrl(redirect), { headers: { Host: "attacker.example" } }, (res) => { res.resume(); resolve(res.statusCode!); });
                req.on("error", reject).end();
            });
            assert.equal(hostStatus, 400);
            for (const path of ["/\\[invalid]/", "/\\attacker.example/callback?state=expected-state&code=x"]) {
                const status = await new Promise<number>((resolve, reject) => {
                    const req = request(redirect, { path }, (res) => { res.resume(); resolve(res.statusCode!); });
                    req.on("error", reject).end();
                });
                assert.equal(status, 400, path);
            }
            assert.equal(received.length, 0);
            assert.equal((await fetch(callbackUrl(redirect))).status, 200);
        },
    });
    assert.deepEqual(received, [callbackUrl(redirect)]);
});

test("[§cli-mcp-oauth-callback] duplicate callbacks never invoke completion twice", async () => {
    const redirect = await redirectUrl();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let calls = 0;
    await receiveAuthorization(authorizationUrl(redirect), async () => {
        calls++;
        started.resolve();
        await finish.promise;
    }, {
        signal: AbortSignal.timeout(2_000), write: noBrowserFailure,
        openBrowser: async () => {
            const first = fetch(callbackUrl(redirect));
            await started.promise;
            assert.equal((await fetch(callbackUrl(redirect))).status, 409);
            finish.resolve();
            assert.equal((await first).status, 200);
        },
    });
    assert.equal(calls, 1);
});

test("[§cli-mcp-oauth-callback] daemon rejection reaches the caller unchanged and never shows success", async () => {
    const redirect = await redirectUrl();
    const problem = new Error("daemon rejected issuer");
    await assert.rejects(receiveAuthorization(authorizationUrl(redirect), async () => { throw problem; }, {
        signal: AbortSignal.timeout(2_000), write: noBrowserFailure,
        openBrowser: async () => {
            const response = await fetch(callbackUrl(redirect));
            assert.equal(response.status, 400);
            assert.doesNotMatch(await response.text(), /authorized|private-code|daemon rejected issuer/u);
        },
    }), (error: unknown) => error === problem);
    await assert.rejects(fetch(redirect), /fetch failed/u);
});

test("[§cli-mcp-oauth-callback] absent browser reports its failure and still permits manual navigation", async () => {
    const redirect = await redirectUrl();
    const notices: string[] = [];
    let navigation: Promise<Response> | undefined;
    await receiveAuthorization(authorizationUrl(redirect), async () => "ok", {
        signal: AbortSignal.timeout(2_000),
        openBrowser: async () => { throw new Error("no desktop session"); },
        write: (message) => {
            notices.push(message);
            if (message.includes("no desktop session")) navigation = fetch(callbackUrl(redirect));
        },
    });
    assert.equal((await navigation)?.status, 200);
    assert.match(notices.join(""), /no desktop session/u);
    assert.doesNotMatch(notices.join(""), /private-code/u);
});

test("[§cli-mcp-oauth-callback] cancellation closes the listener without authorizing", async () => {
    const redirect = await redirectUrl();
    const controller = new AbortController();
    const reason = new Error("cancelled by fixture");
    await assert.rejects(receiveAuthorization(authorizationUrl(redirect), async () => assert.fail("must not complete"), {
        signal: controller.signal, write: () => {},
        openBrowser: async () => { controller.abort(reason); },
    }), (error: unknown) => error === reason);
    await assert.rejects(fetch(redirect), /fetch failed/u);
});

test("[§cli-mcp-oauth-callback] cancellation while binding cannot leave a late listener", async () => {
    const redirect = await redirectUrl();
    const controller = new AbortController();
    const reason = new Error("cancelled while binding");
    const pending = receiveAuthorization(authorizationUrl(redirect), async () => assert.fail("must not complete"), {
        signal: controller.signal, write: noBrowserFailure, openBrowser: async () => assert.fail("must not open"),
    });
    controller.abort(reason);
    await assert.rejects(pending, (error: unknown) => error === reason || (error instanceof Error && error.cause === reason));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(fetch(redirect), /fetch failed/u);
});

test("[§cli-mcp-oauth-callback] IPv6 loopback preserves the registered redirect query", async (t) => {
    let redirect: string;
    try { redirect = `${await redirectUrl("::1")}?tenant=one`; }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EAFNOSUPPORT" && (error as NodeJS.ErrnoException).code !== "EADDRNOTAVAIL") throw error;
        t.skip("IPv6 loopback is unavailable"); return;
    }
    const received: string[] = [];
    await receiveAuthorization(authorizationUrl(redirect), async (url) => { received.push(url); }, {
        signal: AbortSignal.timeout(2_000), write: noBrowserFailure,
        openBrowser: async () => {
            assert.equal((await fetch(callbackUrl(redirect).replace("tenant=one", "tenant=other"))).status, 400);
            assert.equal(received.length, 0);
            assert.equal((await fetch(callbackUrl(redirect))).status, 200);
        },
    });
    assert.deepEqual(received, [callbackUrl(redirect)]);
});

test("[§cli-mcp-oauth-callback] invalid redirect or state never opens the browser", async () => {
    for (const redirect of ["https://client.example/callback", "http://0.0.0.0:9876/callback", "http://localhost:9876/callback", "http://127.0.0.1:0/callback", "http://user@127.0.0.1:9876/callback"]) {
        await assert.rejects(receiveAuthorization(authorizationUrl(redirect), async () => assert.fail(), {
            signal: AbortSignal.timeout(2_000), write: () => {}, openBrowser: async () => assert.fail("must not open"),
        }), /loopback|redirect/u, redirect);
    }
    await assert.rejects(receiveAuthorization("https://identity.example/authorize", async () => assert.fail(), {
        signal: AbortSignal.timeout(2_000), write: () => {}, openBrowser: async () => assert.fail(),
    }), /state|redirect/u);
});

test("[§cli-mcp-oauth-callback] an occupied port fails without opening a browser or closing the other listener", async (t) => {
    const occupied = createServer((_req, res) => res.end("other service"));
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => { occupied.closeAllConnections(); occupied.close(() => resolve()); }));
    const { port } = occupied.address() as AddressInfo;
    const redirect = `http://127.0.0.1:${port}/callback`;
    await assert.rejects(receiveAuthorization(authorizationUrl(redirect), async () => assert.fail(), {
        signal: AbortSignal.timeout(2_000), write: noBrowserFailure, openBrowser: async () => assert.fail("must not open"),
    }), { code: "EADDRINUSE" });
    assert.equal(await (await fetch(redirect)).text(), "other service");
});

test("[§cli-mcp-oauth-callback] a deadline closes reception even if the browser opener never settles", async () => {
    const redirect = await redirectUrl();
    await assert.rejects(receiveAuthorization(authorizationUrl(redirect), async () => assert.fail(), {
        signal: AbortSignal.timeout(30), write: noBrowserFailure,
        openBrowser: () => new Promise(() => {}),
    }), { name: "TimeoutError" });
    await assert.rejects(fetch(redirect), /fetch failed/u);
});

test("[§cli-mcp-oauth-callback] an OAuth error remains a complete callback for daemon issuer validation", async () => {
    const redirect = await redirectUrl();
    const denied = `${redirect}?state=expected-state&error=access_denied&iss=https%3A%2F%2Fidentity.example`;
    let received: string | undefined;
    const problem = new Error("authorization denied");
    await assert.rejects(receiveAuthorization(authorizationUrl(redirect), async (url) => { received = url; throw problem; }, {
        signal: AbortSignal.timeout(2_000), write: noBrowserFailure,
        openBrowser: async () => { assert.equal((await fetch(denied)).status, 400); },
    }), (error: unknown) => error === problem);
    assert.equal(received, denied);
});
