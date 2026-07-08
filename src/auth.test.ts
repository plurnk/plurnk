// Unit tests for the OAuth Device Authorization Grant leg (#116 / execs-mcp#2).
// A fake rpc scripts authorize + a poll sequence; an injected no-op clock keeps
// the poll loop instant (no real interval waits).

import { test } from "node:test";
import assert from "node:assert/strict";
import { runOAuth } from "./auth.ts";

// Fake Rpc: records calls, returns a scripted authorize response then walks a
// queue of poll statuses (last one repeats if the client over-polls).
const fakeRpc = (pollStatuses: string[], authorize: Record<string, unknown> = {}) => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const queue = [...pollStatuses];
    const rpc = {
        call: async (method: string, params: unknown) => {
            calls.push({ method, params });
            if (method === "auth.authorize") {
                return { verificationUri: "https://provider/device", userCode: "WDJB-MJHT", device: { d: "opaque" }, interval: 5, expiresIn: 900, ...authorize };
            }
            return { status: queue.length > 1 ? queue.shift() : queue[0] };
        },
    };
    return { rpc, calls };
};

const noClock = { sleep: async () => {}, nowMs: () => 0 };

test("runOAuth: prints the verification URL + user code (no browser, no loopback)", async () => {
    const { rpc } = fakeRpc(["authorized"]);
    const lines: string[] = [];
    await runOAuth(rpc as never, "notion", { print: (l) => lines.push(l), ...noClock });
    const joined = lines.join("\n");
    assert.match(joined, /https:\/\/provider\/device/);
    assert.match(joined, /WDJB-MJHT/);
});

test("runOAuth: polls until authorized, round-tripping the device blob verbatim", async () => {
    const { rpc, calls } = fakeRpc(["pending", "pending", "authorized"]);
    const result = await runOAuth(rpc as never, "notion", { print: () => {}, ...noClock });
    assert.equal(result.ok, true);
    assert.match(result.message, /notion authorized/);
    assert.equal(calls[0].method, "auth.authorize");
    const polls = calls.filter((c) => c.method === "auth.authorize.poll");
    assert.equal(polls.length, 3, "polled through both pendings to authorized");
    assert.deepEqual((polls[0].params as { device: unknown }).device, { d: "opaque" });
    assert.equal((polls[0].params as { target: string }).target, "notion");
});

test("runOAuth: verificationUriComplete is surfaced when present", async () => {
    const { rpc } = fakeRpc(["authorized"], { verificationUriComplete: "https://provider/device?code=WDJB-MJHT" });
    const lines: string[] = [];
    await runOAuth(rpc as never, "notion", { print: (l) => lines.push(l), ...noClock });
    assert.match(lines.join("\n"), /open directly: https:\/\/provider\/device\?code=WDJB-MJHT/);
});

test("runOAuth: denied → fails", async () => {
    const { rpc } = fakeRpc(["pending", "denied"]);
    const result = await runOAuth(rpc as never, "notion", { print: () => {}, ...noClock });
    assert.equal(result.ok, false);
    assert.match(result.message, /denied/);
});

test("runOAuth: expired → fails with a re-run hint", async () => {
    const { rpc } = fakeRpc(["expired"]);
    const result = await runOAuth(rpc as never, "notion", { print: () => {}, ...noClock });
    assert.equal(result.ok, false);
    assert.match(result.message, /expired.*run \/auth notion again/);
});

test("runOAuth: slow_down backs off but keeps polling to authorized (never aborts)", async () => {
    const { rpc, calls } = fakeRpc(["slow_down", "authorized"]);
    let maxSlept = 0;
    const result = await runOAuth(rpc as never, "notion", {
        print: () => {},
        nowMs: () => 0,
        sleep: async (ms) => { maxSlept = Math.max(maxSlept, ms); },
    });
    assert.equal(result.ok, true);
    assert.ok(maxSlept >= 10_000, "interval backed off past the initial 5s after slow_down");
    assert.equal(calls.filter((c) => c.method === "auth.authorize.poll").length, 2);
});

test("runOAuth: expiresIn deadline → times out rather than polling forever", async () => {
    const { rpc } = fakeRpc(["pending"], { expiresIn: 10, interval: 5 });
    let t = 0;
    const result = await runOAuth(rpc as never, "notion", {
        print: () => {},
        nowMs: () => t,
        sleep: async (ms) => { t += ms; },   // advance the clock as we "wait"
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /timed out/);
});
