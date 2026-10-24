// {§cli-sign-in} — the built client against a real daemon that authenticates and whose minted secret
// it cannot read: a headless invocation is refused and told how to sign in, `plurnk login` signs in
// through the controlled browser (which signs in at the daemon's sign-in page as an operator would),
// the kept grant serves later invocations with no browser, and `plurnk logout` forgets it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { bootDaemon, locateDaemon } from "./harness.ts";

const run = promisify(execFile);
const bin = resolve("bin/plurnk.js");

test("[§cli-sign-in] built CLI: refused headless, signed in through the browser, renewed from the kept grant, signed out", { timeout: 60_000 }, async (t) => {
    if (process.platform !== "linux") { t.skip("the controlled browser uses Linux's BROWSER convention"); return; }
    const service = await locateDaemon();
    assert.ok(service, "the service checkout beside this one");
    // {§credential-authority} — the daemon mints its secret beside its database under its own state root,
    // where this client's home cannot see it, so the client holds no secret for it.
    const daemon = await bootDaemon(service, { extraEnv: { PLURNK_AUTH: "1", PLURNK_PASS: "sign-in-witness" } });
    t.after(() => daemon.cleanup());
    const env = {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PLURNK_/u.test(key))),
        HOME: daemon.home,
        XDG_CONFIG_HOME: join(daemon.home, ".config"),
        XDG_DATA_HOME: join(daemon.home, ".local", "share"),
        XDG_STATE_HOME: join(daemon.home, ".local", "state"),
        PLURNK_ACP_URL: daemon.url,
        PLURNK_CLIENT_AUTOSTART: "0",
        PLURNK_CLIENT_OAUTH_TIMEOUT_MS: "20000",
        BROWSER: `${process.execPath} ${resolve("test/fixtures/oauth-browser.mjs")}`,
        OAUTH_BROWSER_PASS: "sign-in-witness",
        NO_COLOR: "1",
    };
    const invoke = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => run(process.execPath, [bin, ...args], { env, timeout: 40_000 })
        .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }))
        .catch((cause: { code?: number; stdout?: string; stderr?: string }) => ({ code: typeof cause.code === "number" ? cause.code : 1, stdout: cause.stdout ?? "", stderr: cause.stderr ?? "" }));

    const headless = await invoke(["workspace", "list", "--json"]);
    assert.notEqual(headless.code, 0, "a headless invocation with no grant does not sign in");
    const problem = JSON.parse(headless.stdout) as { problem: { type: string; recovery?: string } };
    assert.equal(problem.problem.type, "https://problems.plurnk.xyz/client/credential/sign-in-required");
    assert.match(problem.problem.recovery ?? "", /plurnk login/u);

    const login = await invoke(["login"]);
    assert.equal(login.code, 0, `${login.stdout}\n${login.stderr}`);
    assert.match(login.stderr, /authorization required: http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?/u);
    assert.match(login.stderr, /Signed in to http:\/\/127\.0\.0\.1:\d+\./u);
    const grants = JSON.parse(await readFile(join(daemon.home, ".local", "state", "plurnk", "grants.json"), "utf8")) as { daemons: Record<string, { clientId: string; refreshToken: string }> };
    assert.equal(Object.keys(grants.daemons).length, 1, "one grant, for this daemon");
    assert.doesNotMatch(login.stderr, /code=/u, "callback codes are neither printed nor kept");

    const renewed = await invoke(["workspace", "list", "--json"]);
    assert.equal(renewed.code, 0, `${renewed.stdout}\n${renewed.stderr}`);
    assert.deepEqual(JSON.parse(renewed.stdout), [], "the kept grant serves a headless invocation");
    assert.doesNotMatch(renewed.stderr, /authorization required/u, "no browser for a kept grant");

    const logout = await invoke(["logout"]);
    assert.equal(logout.code, 0, logout.stderr);
    assert.match(logout.stderr, /Signed out of http:\/\/127\.0\.0\.1:\d+\./u);
    const after = await invoke(["workspace", "list", "--json"]);
    assert.equal((JSON.parse(after.stdout) as { problem: { type: string } }).problem.type, "https://problems.plurnk.xyz/client/credential/sign-in-required", "a revoked and forgotten grant leaves the client signed out");
    assert.match((await invoke(["logout"])).stderr, /No grant is kept/u);
});
