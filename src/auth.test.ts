// Unit tests for the OAuth loopback leg (#116). Pure helpers + a real
// bind→hit→capture round-trip over an actual loopback (no daemon, no browser).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCallback, expectedState, bindLoopback, runOAuth } from "./auth.ts";

// ─── parseCallback ───────────────────────────────────────────────────

test("parseCallback: code + state present → parsed", () => {
    assert.deepEqual(parseCallback("/callback?code=abc123&state=xyz"), { code: "abc123", state: "xyz" });
});

test("parseCallback: missing code or state → null (stray hit)", () => {
    assert.equal(parseCallback("/callback?state=xyz"), null);
    assert.equal(parseCallback("/callback?code=abc"), null);
    assert.equal(parseCallback("/favicon.ico"), null);
});

// ─── expectedState ───────────────────────────────────────────────────

test("expectedState: pulls state from the authorization URL", () => {
    assert.equal(expectedState("https://auth.example/authorize?client_id=x&state=s3cr3t&scope=read"), "s3cr3t");
});

test("expectedState: no state param → null", () => {
    assert.equal(expectedState("https://auth.example/authorize?client_id=x"), null);
});

// ─── loopback capture (real http, no daemon) ─────────────────────────

test("bindLoopback: a redirect hit resolves capture with code+state", async () => {
    const { redirectUri, capture } = await bindLoopback();
    const pending = capture(5_000);
    const res = await fetch(`${redirectUri}?code=THE_CODE&state=THE_STATE`);
    assert.equal(res.status, 200);
    assert.deepEqual(await pending, { code: "THE_CODE", state: "THE_STATE" });
});

test("bindLoopback: no hit within the window → null (listener torn down)", async () => {
    const { capture } = await bindLoopback();
    assert.equal(await capture(50), null);
});

// ─── runOAuth (stub rpc + real loopback + injected open) ─────────────

// Minimal fake Rpc: records calls, returns scripted responses.
const fakeRpc = (authorizationUrl: string) => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const rpc = {
        call: async (method: string, params: unknown) => {
            calls.push({ method, params });
            if (method === "auth.authorize") return { authorizationUrl, pkce: { v: "opaque" } };
            return { ok: true };
        },
    };
    return { rpc, calls };
};

test("runOAuth: happy path authorizes, round-trips pkce, completes", async () => {
    const { rpc, calls } = fakeRpc("https://auth.example/authorize?state=ST8");
    const lines: string[] = [];
    // The injected `open` fires the redirect at our own loopback with the right state.
    const result = await runOAuth(rpc as never, "notion", {
        print: (l) => lines.push(l),
        timeoutMs: 5_000,
        // Simulate the browser: fire the redirect at our loopback with the right state.
        open: () => {
            const redirect = (calls[0].params as { redirectUri: string }).redirectUri;
            void fetch(`${redirect}?code=CODE9&state=ST8`);
        },
    });
    assert.equal(result.ok, true);
    assert.match(result.message, /notion authorized/);
    // authorize then complete, with pkce echoed verbatim + the captured code
    assert.equal(calls[0].method, "auth.authorize");
    assert.equal(calls[1].method, "auth.authorize.complete");
    assert.deepEqual((calls[1].params as { pkce: unknown }).pkce, { v: "opaque" });
    assert.equal((calls[1].params as { code: string }).code, "CODE9");
});

test("runOAuth: state mismatch aborts before completing", async () => {
    const { rpc, calls } = fakeRpc("https://auth.example/authorize?state=EXPECTED");
    const result = await runOAuth(rpc as never, "notion", {
        print: () => {},
        timeoutMs: 5_000,
        open: () => {
            const redirect = (calls[0].params as { redirectUri: string }).redirectUri;
            void fetch(`${redirect}?code=CODE&state=WRONG`);
        },
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /state mismatch/);
    assert.equal(calls.length, 1);   // authorize only — never completed
});
