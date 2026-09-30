// Built-client dogfood for workspace MCP management. A current SDK server the
// workspace adds and a pre-server/discover standard peer an installed Agent
// Plugin declares prove the host's negotiate-and-degrade admission contract
// through the public client, beside MCP Registry discovery and the positional form.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { actionViaBridge } from "../../src/agui.ts";
import { bootDaemon, locateDaemon, type Daemon } from "../intg/harness.ts";
import { BIN, spawnTui } from "./harness.ts";

const exec = promisify(execFile);

let daemon: Daemon | null = null;
let registry: Server | null = null;
let scratch = "";
let currentFixture = "";
let currentCall = "";

// One MCP Registry (API v0.1) server: an npm package the daemon runs as the registry's examples do.
const REGISTRY_SERVER = {
    name: "io.example/echo",
    version: "1.0.0",
    description: "Echo.",
    packages: [{
        registryType: "npm",
        identifier: "@example/echo",
        version: "1.0.0",
        transport: { type: "stdio" },
        environmentVariables: [{ name: "ECHO_KEY", isRequired: true, isSecret: true }],
    }],
};

before(async () => {
    const bin = await locateDaemon();
    if (bin === null) return;
    const serviceRoot = resolve(process.cwd(), "../plurnk-service");
    currentFixture = join(serviceRoot, "plurnk-mcp/src/fixtures/echo-server.mjs");
    const legacyFixture = join(serviceRoot, "plurnk-mcp/src/fixtures/legacy-server.mjs");
    try {
        await Promise.all([
            access(currentFixture),
            access(legacyFixture),
        ]);
    } catch {
        return;
    }
    scratch = await mkdtemp(join(tmpdir(), "plurnk-mcp-client-"));
    currentCall = join(scratch, "call-current.plk");
    await writeFile(currentCall, [
        "````current (echo)",
        '{"message":"installed daemon current peer"}',
        "````",
    ].join("\n"));
    const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", "http://registry.test");
        if (url.pathname !== "/v0.1/servers") { response.writeHead(404).end(); return; }
        const matched = REGISTRY_SERVER.name.includes(url.searchParams.get("search") ?? "");
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ servers: matched ? [{ server: REGISTRY_SERVER }] : [] }));
    });
    registry = server;
    const port = await new Promise<number>((resolvePort) => {
        server.listen(0, "127.0.0.1", () => resolvePort((server.address() as { port: number }).port));
    });
    daemon = await bootDaemon(bin, {
        plugins: { peers: { legacy: { type: "stdio", command: "node", args: [legacyFixture] } } },
        extraEnv: { PLURNK_MCP_REGISTRY_URL: `http://127.0.0.1:${port}` },
    });
});

after(async () => {
    await daemon?.cleanup();
    await new Promise<void>((resolveClose) => { if (registry === null) resolveClose(); else registry.close(() => resolveClose()); });
    if (scratch.length > 0) await rm(scratch, { recursive: true, force: true });
});

describe("TUI workspace MCP dogfood", () => {
    test("[§cli-workspace-mcp-controls] an added current peer and an installed standard peer share the client lifecycle", { timeout: 90_000 }, async (t) => {
        if (daemon === null) { t.skip("service checkout with MCP fixtures is not reachable"); return; }
        const project = await mkdtemp(join(scratch, "project-"));
        // This drives a model that EXECUTES; the subject is the lifecycle grammar, not consent.
        // Pin consent independently of the operator's environment.
        const tui = spawnTui(daemon.url, [], { PLURNK_CLIENT_YOLO: "1" }, project);
        try {
            await tui.waitFor(/plurnk.*\/help/);

            // Installing the plugin enabled its server; inspecting a cold workspace connects nothing.
            let since = tui.output().length;
            tui.write("/mcp\r");
            await tui.waitFor(/legacy\s+dormant\s+stdio\s+node\s+plugin peers/, 20_000, since);

            // Discovery searches the registry and adds nothing.
            since = tui.output().length;
            tui.write("/mcp discover echo\r");
            await tui.waitFor(/echo\s+candidate\s+stdio\s+npx\s+Echo\.\s+—\s+npx\s+-y\s+@example\/echo@1\.0\.0\s+—\s+Needs\s+ECHO_KEY\./, 20_000, since);

            // An added server is a one-server plugin at the default project scope, active at once.
            tui.write(`/mcp add current node "${currentFixture}"\r`);
            await tui.waitFor(/added: current \(active\)/, 20_000);
            const plugin = join(project, ".agents", "plugins", "current");
            await access(join(plugin, "mcp.json"));

            tui.write(`/script ${currentCall}\r`);
            const used = await tui.waitFor(/script: 1 op ok/, 20_000);
            assert.match(used, /echo/);  // the execution row keeps its target; routine codes left the waterfall (plurnk#21)

            since = tui.output().length;
            tui.write("/mcp\r");
            await tui.waitFor(/current\s+active\s+stdio\s+node\s+2 tools\s+\(workspace\)/, 20_000, since);
            await tui.waitFor(/legacy\s+active\s+stdio\s+node\s+1 tools\s+plugin peers/, 20_000, since);

            tui.write("/mcp disable current\r");
            await tui.waitFor(/disabled: current \(disabled\)/, 20_000);

            since = tui.output().length;
            tui.write("/mcp enable cur\t");
            await new Promise((resolve) => setTimeout(resolve, 100));
            tui.write("\t\r");
            await tui.waitFor(/enabled: current \(active\)/, 20_000, since);

            // A plugin's server is disable-only: the daemon's Problem crosses unrewritten.
            since = tui.output().length;
            tui.write("/mcp remove legacy\r");
            const refused = await tui.waitFor(/'legacy' is provided to this workspace, not added by it/, 20_000, since);
            assert.doesNotMatch(refused.slice(since), /removed: legacy/);

            since = tui.output().length;
            tui.write("/mcp remove current\r");
            await tui.waitFor(/removed: current/, 20_000, since);
            await assert.rejects(access(plugin), "remove uninstalls the plugin add wrote");
            since = tui.output().length;
            tui.write("/mcp\r");
            await tui.waitFor(/legacy\s+active\s+stdio\s+node/, 20_000, since);
            tui.write("/quit\r");
            assert.equal(await tui.exited, 0);
            assert.doesNotMatch(tui.output().slice(since), /current\s+(?:active|disabled|dormant)/, "the removed server is gone");
        } finally {
            tui.kill();
        }
    });

    test("[§cli-workspace-mcp-controls] the positional form takes add's scope flag and server arguments after --", { timeout: 60_000 }, async (t) => {
        if (daemon === null) { t.skip("service checkout with MCP fixtures is not reachable"); return; }
        const workspace = "mcp-positional";
        await actionViaBridge({ bridgeUrl: daemon.url }, { threadId: workspace, kind: "workspace.create", params: { name: workspace, projectRoot: null } });
        const home = await mkdtemp(join(scratch, "home-"));
        const env = {
            ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PLURNK_"))),
            HOME: home,
            XDG_CONFIG_HOME: join(home, ".config"),
            PLURNK_AGUI_URL: daemon.url,
            NO_COLOR: "1",
        };
        const plurnk = async <T>(...args: string[]): Promise<T> =>
            JSON.parse((await exec(process.execPath, [BIN, "--workspace", workspace, "--json", "mcp", ...args], { cwd: scratch, env, timeout: 30_000 })).stdout) as T;

        type Added = { status: number; definition: { origin: string; state: string; definition: object } };
        const added = await plurnk<Added>("--", "add", "--plurnk", "flagged", "node", currentFixture, "--global");
        assert.equal(added.status, 201);
        assert.equal(added.definition.origin, "workspace");
        assert.equal(added.definition.state, "active");
        assert.deepEqual(added.definition.definition, {
            name: "flagged", scope: "plurnk", type: "stdio", command: "node", args: [currentFixture, "--global"],
        }, "the flag after the target is the server's argument");
        assert.equal((await plurnk<{ removed?: boolean }>("remove", "flagged")).removed, true);
    });
});
