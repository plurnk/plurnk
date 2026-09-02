import assert from "node:assert/strict";
import { test } from "node:test";
import { ProblemError } from "./diagnostics.ts";
import { launchWeb, type WebModuleLoader, type WebPortalLaunch } from "./web.ts";

const launch: WebPortalLaunch = {
    host: "127.0.0.1",
    port: "10661",
    upstream: new URL("http://127.0.0.1:3044"),
    token: "private",
    constraints: { workspace: "project", threadId: "conversation" },
    workspaceProperties: {
        projectRoot: "/workspace",
        settings: { filesItems: 16 },
    },
    runProperties: {
        projectRoot: "/workspace",
        settings: { filesItems: 16 },
        policy: { capabilities: {}, proposals: "review" },
        maxTurns: 9,
    },
    prepareSession: async () => undefined,
    projectPrompt: (prompt) => ({ prompt, runProperties: { openPaths: [] } }),
    timeoutSec: 60,
    mcpConfiguration: { PLURNK_MCP_GITEA: "gitea-mcp" },
    autoAcceptProposals: true,
};

test("[§cli-web-launcher]: the optional module receives the resolved navigation and Run projection", async () => {
    const calls: WebPortalLaunch[] = [];
    let closed = false;
    const load: WebModuleLoader = async () => ({
        startClientPortal: async (options) => {
            calls.push(options);
            return { origin: "http://127.0.0.1:10661", close: async () => { closed = true; } };
        },
    });
    let announced = "";
    assert.equal(await launchWeb(launch, {
        load,
        wait: async () => undefined,
        announce: (origin) => { announced = origin; },
    }), 0);
    assert.deepEqual(calls, [launch]);
    assert.equal(announced, "http://127.0.0.1:10661");
    assert.equal(closed, true);
});

test("[§cli-web-launcher]: the portal closes when its foreground wait fails", async () => {
    let closed = false;
    const load: WebModuleLoader = async () => ({
        startClientPortal: async () => ({
            origin: "http://127.0.0.1:10661",
            close: async () => { closed = true; },
        }),
    });
    await assert.rejects(
        launchWeb(launch, { load, wait: async () => { throw new Error("stop failed"); } }),
        /stop failed/,
    );
    assert.equal(closed, true);
});

test("[§cli-web-launcher]: an absent optional browser package gives one exact install path", async () => {
    const load: WebModuleLoader = async () => {
        throw Object.assign(
            new Error("Cannot find package '@plurnk/plurnk-web' imported from client"),
            { code: "ERR_MODULE_NOT_FOUND" },
        );
    };
    await assert.rejects(
        launchWeb(launch, { load }),
        (cause: unknown) => cause instanceof ProblemError
            && cause.exitCode === 127
            && cause.problem.type === "https://problems.plurnk.xyz/client/web/not-installed"
            && Array.isArray(cause.problem.hints)
            && cause.problem.hints.includes("Install it: npm install -g @plurnk/plurnk-web"),
    );
});

test("[§cli-web-launcher]: a broken dependency inside the installed package is not misreported as an absent package", async () => {
    const nested = Object.assign(
        new Error("Cannot find package 'react' imported from /node_modules/@plurnk/plurnk-web/dist/server/index.js"),
        { code: "ERR_MODULE_NOT_FOUND" },
    );
    await assert.rejects(
        launchWeb(launch, { load: async () => { throw nested; } }),
        (cause: unknown) => cause === nested,
    );
});
