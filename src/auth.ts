// OAuth loopback leg for auth-protected execs (client #116 / plurnk-service#306).
//
// The mechanics (discovery/PKCE/exchange) are execs-mcp's; the service relays
// two stateless methods; the CLIENT owns the interactive half — because it has
// the browser and the UX:
//   1. bind a transient loopback (`http://127.0.0.1:<port>/callback`)
//   2. auth.authorize({ target, redirectUri }) → { authorizationUrl, pkce }
//   3. open + print the URL; the user consents in their browser
//   4. capture the `code`+`state` redirect, tear the loopback down
//   5. auth.authorize.complete({ target, code, pkce, redirectUri })
// No token ever touches the client — only the code round-trips. `target` is the
// EXEC tag needing auth (an MCP server name today, e.g. `notion`).

import http from "node:http";
import { spawn } from "node:child_process";
import process from "node:process";
import type Rpc from "./rpc.ts";

// Parse a loopback callback URL's query → { code, state }, or null when code is
// absent (a stray/favicon hit, not the redirect). `state` is optional on the
// wire — the PKCE flow doesn't require it (execs-mcp builds authorize URLs
// without one; the joint e2e proved this) — so it's null when not sent and the
// guard in runOAuth only enforces it when the authorization URL committed to one.
export const parseCallback = (url: string): { code: string; state: string | null } | null => {
    const q = new URL(url, "http://127.0.0.1").searchParams;
    const code = q.get("code");
    return code !== null ? { code, state: q.get("state") } : null;
};

// The `state` an authorization URL commits to — for the client's defense-in-depth
// guard (execs-mcp owns authoritative validation). null when the URL carries none.
export const expectedState = (authorizationUrl: string): string | null =>
    new URL(authorizationUrl).searchParams.get("state");

// Best-effort browser open — never throws; a failed open degrades to the printed
// URL (headless / SSH / no opener). darwin=open, win32=start, else xdg-open.
const openBrowser = (url: string): void => {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try { spawn(cmd, [url], { stdio: "ignore", detached: true }).unref(); } catch { /* the printed URL is the fallback */ }
};

export interface Loopback {
    redirectUri: string;
    // Resolve on the first callback hit; null on timeout. Tears the listener down either way.
    capture: (timeoutMs: number) => Promise<{ code: string; state: string | null } | null>;
}

// Stand up the transient loopback on an ephemeral port. Exported for direct
// testing of the capture leg (bind → hit → assert) without a daemon or browser.
export const bindLoopback = (): Promise<Loopback> =>
    new Promise((resolve) => {
        let onHit: (v: { code: string; state: string | null } | null) => void = () => {};
        const hit = new Promise<{ code: string; state: string | null } | null>((r) => { onHit = r; });
        const server = http.createServer((req, res) => {
            const parsed = req.url !== undefined ? parseCallback(req.url) : null;
            res.writeHead(200, { "content-type": "text/html" });
            res.end("<!doctype html><meta charset=utf-8><body>plurnk: authorization received — you can close this tab.</body>");
            if (parsed !== null) onHit(parsed);
        });
        server.listen(0, "127.0.0.1", () => {
            const addr = server.address();
            const port = typeof addr === "object" && addr !== null ? addr.port : 0;
            const capture = (timeoutMs: number): Promise<{ code: string; state: string | null } | null> => {
                const timer = setTimeout(() => onHit(null), timeoutMs);
                return hit.finally(() => { clearTimeout(timer); server.close(); });
            };
            resolve({ redirectUri: `http://127.0.0.1:${port}/callback`, capture });
        });
    });

export interface OAuthResult { ok: boolean; message: string }

// Drive the full flow for `target`. `io.print` writes progress above the prompt;
// `io.open` is injectable (tests pass a no-op); `io.timeoutMs` bounds the wait.
export const runOAuth = async (
    rpc: Rpc,
    target: string,
    io: { print: (line: string) => void; open?: (url: string) => void; timeoutMs?: number },
): Promise<OAuthResult> => {
    const open = io.open ?? openBrowser;
    const timeoutMs = io.timeoutMs ?? 300_000;   // 5 min — the client owns the bound (service is stateless)
    const { redirectUri, capture } = await bindLoopback();
    const { authorizationUrl, pkce } = await rpc.call("auth.authorize", { target, redirectUri }) as { authorizationUrl: string; pkce: unknown };
    io.print(`  🔒 authorize ${target} — opening your browser; if it doesn't open, visit:`);
    io.print(`     ${authorizationUrl}`);
    open(authorizationUrl);
    const hit = await capture(timeoutMs);
    if (hit === null) return { ok: false, message: `${target}: authorization timed out after ${Math.round(timeoutMs / 1000)}s` };
    const want = expectedState(authorizationUrl);
    if (want !== null && hit.state !== want) return { ok: false, message: `${target}: state mismatch — aborted (possible CSRF)` };
    await rpc.call("auth.authorize.complete", { target, code: hit.code, pkce, redirectUri });
    return { ok: true, message: `${target} authorized — retry the operation` };
};
