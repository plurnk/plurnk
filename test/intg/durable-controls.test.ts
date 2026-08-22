import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { actionViaBridge } from "../../src/agui.ts";
import { BridgeTransport } from "../../src/transport.ts";
import { bootDaemon, locateDaemon } from "./harness.ts";

test("{§cli-agui-conformance}: separate client connections observe every exposed durable control", { timeout: 120_000 }, async (t) => {
    const service = await locateDaemon();
    if (service === null) { t.skip("no plurnk-service binary reachable"); return; }
    const daemon = await bootDaemon(service, {
        readyTimeoutMs: 30_000,
        extraEnv: {
            PLURNK_MODEL_nvimtest: "lmstudio/nvim-family/selected",
            PLURNK_PROVIDERS_CONTEXT_WINDOW_nvimtest: "32768",
            PLURNK_PROVIDERS_REASONING_nvimtest: "off",
            LMSTUDIO_API_KEY: "conformance",
        },
    });
    t.after(daemon.cleanup);

    const original = `terminal-durable-${crypto.randomUUID()}`;
    const created = await actionViaBridge<{ id: number; name: string; workerId: number }>(
        { bridgeUrl: daemon.url },
        { threadId: "terminal-control", kind: "workspace.create", params: { name: original, projectRoot: null } },
    );
    const connectionA = new BridgeTransport(
        { bridgeUrl: daemon.url },
        "terminal-durable-worker",
        { workspace: original },
    );
    const connectionB = new BridgeTransport(
        { bridgeUrl: daemon.url },
        "terminal-durable-worker",
        { workspace: original },
    );
    const from = <T>(connection: "a" | "b", kind: string, params: object = {}): Promise<T> =>
        (connection === "a" ? connectionA : connectionB).rpc<T>(kind, params);

    const listed = await actionViaBridge<{ workspaces: Array<{ id: number; name: string }> }>(
        { bridgeUrl: daemon.url },
        { threadId: "terminal-observer", kind: "workspace.list" },
    );
    assert.ok(listed.workspaces.some(({ id, name }) => id === created.id && name === original));

    await from("a", "workspace.constrain", { effect: "pick", glob: "src/**" });
    assert.deepEqual(
        await from("b", "workspace.constraints"),
        { constraints: [{ effect: "pick", glob: "src/**" }] },
    );
    await from("a", "workspace.unconstrain", { effect: "pick", glob: "src/**" });
    assert.deepEqual(await from("b", "workspace.constraints"), { constraints: [] });

    const child = await from<{ workerId: number }>("a", "run.fork", { name: "durable-child" });
    const workers = await from<{ workers: Array<{ id: number; name: string }> }>(
        "b",
        "workspace.workers",
        { id: created.id },
    );
    assert.ok(workers.workers.some(({ id, name }) => id === child.workerId && name === "durable-child"));

    await from("a", "worker.model.set", { selector: "nvimtest" });
    const model = await from<{ model: { alias: string; provider: string; model: string } }>("b", "worker.model.get");
    assert.deepEqual(model.model, {
        alias: "nvimtest",
        provider: "lmstudio",
        model: "nvim-family/selected",
    });

    await from("a", "worker.child.set", { selector: "nvimtest" });
    const childModel = await from<{ spawnModel: { alias: string } }>("b", "worker.model.get");
    assert.equal(childModel.spawnModel.alias, "nvimtest");

    await from("a", "worker.reasoning.set", { policy: "adaptive" });
    assert.equal((await from<{ policy: string }>("b", "worker.reasoning.get")).policy, "adaptive");
    await from("a", "worker.settings.set", { settings: { requestUserInput: true } });
    assert.deepEqual(await from("b", "worker.settings.get"), { requestUserInput: true });

    const fixture = resolve(import.meta.dirname, "../../../plurnk-service/plurnk-mcp/src/fixtures/echo-server.mjs");
    await from("a", "workspace.mcp.add", {
        alias: "durable",
        target: process.execPath,
        options: { args: [fixture], tools: ["echo"], read: ["echo"] },
    });
    const servers = async (): Promise<Array<{ alias: string; state: string }>> =>
        (await from<{ servers: Array<{ alias: string; state: string }> }>("b", "workspace.mcp.list")).servers;
    assert.equal((await servers()).find(({ alias }) => alias === "durable")?.state, "connected");
    await from("a", "workspace.mcp.disable", { alias: "durable" });
    assert.equal((await servers()).find(({ alias }) => alias === "durable")?.state, "disabled");
    await from("a", "workspace.mcp.enable", { alias: "durable" });
    assert.equal((await servers()).find(({ alias }) => alias === "durable")?.state, "connected");
    await from("a", "workspace.mcp.remove", { alias: "durable" });
    assert.equal((await servers()).some(({ alias }) => alias === "durable"), false);

    const renamed = `${original}-renamed`;
    await from("a", "workspace.rename", { name: renamed });
    const afterRename = await actionViaBridge<{ workspaces: Array<{ id: number; name: string }> }>(
        { bridgeUrl: daemon.url },
        { threadId: "terminal-observer-after-rename", kind: "workspace.list" },
    );
    assert.ok(afterRename.workspaces.some(({ id, name }) => id === created.id && name === renamed));
});
