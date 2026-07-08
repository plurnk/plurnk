// OAuth Device Authorization Grant (RFC 8628) for auth-protected execs
// (client #116 / execs-mcp#2 / plurnk-service#353). The loopback flow it
// replaces assumed browser-and-daemon co-location and was unusable over a
// remote daemon (SSH/jumpbox: the 127.0.0.1 callback lands on the daemon host).
//
// The mechanics (discovery/DCR/device-authorization/token-poll) are execs-mcp's;
// the service relays two stateless methods; the CLIENT owns the interactive half
// — print the verification URL + user code, then DRIVE the poll loop:
//   1. auth.authorize({ target }) → { verificationUri, userCode, device, interval, expiresIn }
//   2. print "visit <uri>, enter <code>" (or verificationUriComplete)
//   3. poll auth.authorize.poll({ target, device }) every `interval`s until the
//      status settles (authorized | denied | expired) or expiresIn elapses
// No redirect, no local server, no token on the client — works identically on a
// laptop or ten jumpboxes deep. `target` is the EXEC tag needing auth (an MCP
// server name, e.g. `notion`).

import process from "node:process";
import type Rpc from "./rpc.ts";

export interface OAuthResult { ok: boolean; message: string }

interface AuthorizeResp {
    verificationUri: string;
    verificationUriComplete?: string;   // embeds the code — one-click / QR
    userCode: string;
    device: unknown;                    // opaque; round-tripped into poll verbatim
    interval: number;                   // seconds between polls (RFC 8628 §3.5)
    expiresIn: number;                  // seconds until the device code dies
}

type PollStatus = "pending" | "slow_down" | "authorized" | "denied" | "expired";

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Drive the full device-grant flow for `target`. `io.print` writes progress above
// the prompt; `io.sleep`/`io.nowMs` are injectable (tests pass a no-op clock so
// the poll loop doesn't wait real seconds).
export const runOAuth = async (
    rpc: Rpc,
    target: string,
    io: { print: (line: string) => void; sleep?: (ms: number) => Promise<void>; nowMs?: () => number },
): Promise<OAuthResult> => {
    const sleep = io.sleep ?? realSleep;
    const now = io.nowMs ?? Date.now;
    const a = await rpc.call("auth.authorize", { target }) as AuthorizeResp;

    io.print(`  🔒 authorize ${target} — visit:`);
    io.print(`     ${process.env.NO_COLOR ? a.verificationUri : `\x1b[1m${a.verificationUri}\x1b[0m`}`);
    io.print(`  🔑 and enter code: ${a.userCode}`);
    if (a.verificationUriComplete !== undefined) io.print(`     (or open directly: ${a.verificationUriComplete})`);

    let intervalMs = Math.max(1, a.interval) * 1000;
    const deadline = now() + Math.max(1, a.expiresIn) * 1000;
    while (now() < deadline) {
        const { status } = await rpc.call("auth.authorize.poll", { target, device: a.device }) as { status: PollStatus };
        if (status === "authorized") return { ok: true, message: `${target} authorized — retry the operation` };
        if (status === "denied") return { ok: false, message: `${target}: authorization denied` };
        if (status === "expired") return { ok: false, message: `${target}: authorization expired — run /auth ${target} again` };
        if (status === "slow_down") intervalMs += 5_000;   // RFC 8628 §3.5 — back off, don't abort
        await sleep(intervalMs);
    }
    return { ok: false, message: `${target}: authorization timed out — run /auth ${target} again` };
};
