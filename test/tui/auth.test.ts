// Joint e2e for the OAuth loopback leg (#116 / svc#306): client /auth verb →
// real daemon auth.* relay → the service's mock OAuth server (svc 03cea6c,
// single-sourced with THEIR e2e) → code captured on OUR loopback → complete.
//
// Browserless by design: the mock's /authorize 302s straight back to the
// redirect_uri with a code + echoed state, so fetching the printed URL stands
// in for the user's browser — exercising the loopback capture AND state-guard.
// DISPLAY/BROWSER are blanked so a desktop box never actually opens a browser.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { bootDaemon, locateDaemon, type Daemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

let daemon: Daemon | null = null;
let mock: ChildProcess | null = null;

// Boot the service's standalone mock OAuth server; resolve its base URL from
// the first stdout line. Same implementation their e2e proves — if our run and
// theirs disagree, the server isn't the variable.
const bootMockOAuth = (serviceBin: string): Promise<{ proc: ChildProcess; base: string }> =>
    new Promise((res, rej) => {
        // locateDaemon returns src/service.ts | dist/service.js | bin/… — all one
        // level under the service repo root, so the mock is ../bin from any of them.
        const mockPath = resolve(dirname(serviceBin), "../bin/mock-oauth.ts");
        const proc = spawn("node", [mockPath], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "", err = "";
        const timer = setTimeout(() => rej(new Error(`mock-oauth boot timeout; stdout: ${out} stderr: ${err}`)), 10_000);
        proc.stderr!.on("data", (c: Buffer) => { err += c.toString("utf8"); });
        proc.stdout!.on("data", (c: Buffer) => {
            out += c.toString("utf8");
            const line = out.split("\n")[0];
            if (line.startsWith("http")) { clearTimeout(timer); res({ proc, base: line.trim() }); }
        });
        proc.once("error", (e) => { clearTimeout(timer); rej(e); });
        proc.once("exit", (c) => { clearTimeout(timer); rej(new Error(`mock-oauth exited ${c} before serving; stderr: ${err}`)); });
    });

before(async () => {
    const bin = await locateDaemon();
    if (bin === null) return;   // no service checkout → suite skips per-test
    const booted = await bootMockOAuth(bin);
    mock = booted.proc;
    daemon = await bootDaemon(bin, { extraEnv: { PLURNK_MCP_TESTAUTH: `${booted.base}/mcp` } });
});

after(async () => {
    await daemon?.cleanup();
    mock?.kill("SIGINT");
});

test("/auth testauth completes the full OAuth loop against the real daemon + mock server", async (t) => {
    if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
    const tui = spawnTui(daemon.url, [], { DISPLAY: "", BROWSER: "" });
    try {
        await tui.waitFor(/plurnk.*\/help/);
        tui.write("/auth testauth\r");
        // The client prints the authorization URL (the headless fallback path).
        const buf = await tui.waitFor(/http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+/, 15_000);
        const url = buf.match(/http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+/)![0];
        // Stand in for the browser: the mock 302s back to OUR loopback with
        // code + echoed state; default fetch follows the redirect → capture fires.
        const res = await fetch(url);
        assert.equal(res.status, 200, "loopback answered the redirect");
        // Capture → state-guard → auth.authorize.complete → token installed.
        await tui.waitFor(/✅ testauth authorized — retry the operation/, 15_000);
        tui.write("/quit\r");
        assert.equal(await tui.exited, 0);
    } finally {
        tui.kill();
    }
});
