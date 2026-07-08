// Joint e2e for the OAuth Device Authorization Grant leg (#116 / execs-mcp#2 /
// svc#353): client /auth verb → real daemon auth.* relay → the service's device-
// grant mock OAuth server (single-sourced with THEIR e2e) → print URL + code →
// poll pending→authorized → bearer installed.
//
// Browserless by nature now: the mock's /token returns authorization_pending on
// the first poll and the bearer thereafter, so the client's poll loop drives to
// authorized with no redirect and no local server — exactly the remote/jumpbox
// property this leg was rebuilt for.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { bootDaemon, locateDaemon, type Daemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

let daemon: Daemon | null = null;
let mock: ChildProcess | null = null;

// Boot the service's standalone mock OAuth server; resolve its base URL from the
// first stdout line. Same implementation their e2e proves.
const bootMockOAuth = (serviceBin: string): Promise<{ proc: ChildProcess; base: string }> =>
    new Promise((res, rej) => {
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
    daemon = await bootDaemon(bin, { extraEnv: { PLURNK_EXECS_MCP_TESTAUTH: `${booted.base}/mcp` } });
});

after(async () => {
    await daemon?.cleanup();
    mock?.kill("SIGINT");
});

test("/auth testauth completes the device-grant loop against the real daemon + mock server", async (t) => {
    if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
    const tui = spawnTui(daemon.url, [], { DISPLAY: "", BROWSER: "" });
    try {
        await tui.waitFor(/plurnk.*\/help/);
        tui.write("/auth testauth\r");
        // The client prints the verification URL + user code (no redirect, no
        // loopback — nothing local for a jumpbox user to reach).
        await tui.waitFor(/authorize testauth — visit:/, 15_000);
        await tui.waitFor(/and enter code: \S+/, 15_000);
        // Poll loop drives pending → authorized; the relay installs the bearer.
        await tui.waitFor(/✅ testauth authorized — retry the operation/, 20_000);
        tui.write("/quit\r");
        assert.equal(await tui.exited, 0);
    } finally {
        tui.kill();
    }
});
