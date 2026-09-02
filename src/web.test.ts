import assert from "node:assert/strict";
import { test } from "node:test";
import { ProblemError } from "./diagnostics.ts";
import { launchWeb, type WebSpawner } from "./web.ts";

test("[§cli-web-launcher]: foreground handoff preserves argv, environment, and exit status", () => {
    const env = { PLURNK_AGUI_TOKEN: "private" };
    const calls: Array<{ executable: string; args: readonly string[]; env: NodeJS.ProcessEnv; stdio: string }> = [];
    const spawn: WebSpawner = (executable, args, options) => {
        calls.push({ executable, args, ...options });
        return { status: 7, signal: null };
    };
    assert.equal(launchWeb(["--workspace", "project", "--port", "10661"], { env, spawn }), 7);
    assert.deepEqual(calls, [{
        executable: "plurnk-web",
        args: ["--workspace", "project", "--port", "10661"],
        env,
        stdio: "inherit",
    }]);
});

test("[§cli-web-launcher]: a signal preserves conventional shell status", () => {
    const spawn: WebSpawner = () => ({ status: null, signal: "SIGTERM" });
    assert.equal(launchWeb([], { spawn }), 143);
});

test("[§cli-web-launcher]: an absent optional browser package gives one exact install path", () => {
    const spawn: WebSpawner = () => ({
        status: null,
        signal: null,
        error: Object.assign(new Error("spawn plurnk-web ENOENT"), { code: "ENOENT" }),
    });
    assert.throws(
        () => launchWeb([], { spawn }),
        (cause: unknown) => cause instanceof ProblemError
            && cause.exitCode === 127
            && cause.problem.type === "https://problems.plurnk.xyz/client/web/not-installed"
            && Array.isArray(cause.problem.hints)
            && cause.problem.hints.includes("Install it: npm install -g @plurnk/plurnk-web"),
    );
});
