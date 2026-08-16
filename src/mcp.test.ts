import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMcp } from "./mcp.ts";

const harness = (results: Record<string, unknown> = {}) => {
    const calls: Array<{ method: string; params?: object }> = [];
    const out: string[] = [];
    const rpc = {
        call: async (method: string, params?: object) => {
            calls.push({ method, params });
            return results[method] ?? {};
        },
    };
    return { rpc, write: (text: string) => out.push(text), calls, out };
};

test("[§cli-workspace-mcp-controls] attach and replace decode one local definition and forward it unchanged", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-definition-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "echo server.json");
    const definition = { name: "echo", transport: "stdio", command: "/opt/echo", args: ["--stdio"] };
    await writeFile(file, JSON.stringify(definition));
    const h = harness({
        "workspace.mcp.attach": { status: 201, server: { name: "echo", state: "connected", transport: "stdio" } },
        "workspace.mcp.replace": { status: 200, server: { name: "echo", state: "connected", transport: "stdio" } },
    });

    await handleMcp(file, h.rpc, h.write);
    await handleMcp(`replace ${file}`, h.rpc, h.write);

    assert.deepEqual(h.calls, [
        { method: "workspace.mcp.attach", params: { server: definition } },
        { method: "workspace.mcp.replace", params: { server: definition } },
    ]);
    assert.match(h.out.join(""), /attached: echo \(connected\)/);
    assert.match(h.out.join(""), /replaced: echo \(connected\)/);
});

test("[§cli-workspace-mcp-controls] detach, reconnect, and oauth map exactly to workspace actions", async () => {
    const h = harness({
        "workspace.mcp.detach": { status: 200, name: "echo", detached: true },
        "workspace.mcp.reconnect": { status: 200, server: { name: "echo", state: "connected", transport: "stdio" } },
        "workspace.mcp.oauth.complete": { status: 200, server: { name: "gitea", state: "connected", transport: "http" } },
    });
    await handleMcp("detach echo", h.rpc, h.write);
    await handleMcp("reconnect echo", h.rpc, h.write);
    await handleMcp("oauth gitea https://client.example/callback?code=x&state=y", h.rpc, h.write);
    assert.deepEqual(h.calls, [
        { method: "workspace.mcp.detach", params: { name: "echo" } },
        { method: "workspace.mcp.reconnect", params: { name: "echo" } },
        {
            method: "workspace.mcp.oauth.complete",
            params: { name: "gitea", callbackUrl: "https://client.example/callback?code=x&state=y" },
        },
    ]);
});

test("[§cli-workspace-mcp-controls] authorization-required result prints the URL and exact completion command", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-oauth-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "gitea.json");
    await writeFile(file, JSON.stringify({ name: "gitea", transport: "http", url: "https://gitea.example/mcp" }));
    const h = harness({
        "workspace.mcp.attach": { status: 202, authorization: { url: "https://gitea.example/authorize?state=abc" } },
    });
    await handleMcp(file, h.rpc, h.write);
    assert.match(h.out.join(""), /https:\/\/gitea\.example\/authorize\?state=abc/);
    assert.match(h.out.join(""), /\/mcp oauth gitea <callback-url>/);
});

test("[§cli-workspace-mcp-controls] only local JSON syntax is a client validation boundary", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-invalid-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const malformed = join(dir, "bad.json");
    const structurallyInvalid = join(dir, "semantic.json");
    await writeFile(malformed, "{nope");
    await writeFile(structurallyInvalid, "{}");

    for (const command of [
        "replace",
        "detach",
        "detach two names",
        "reconnect",
        "oauth gitea",
    ]) {
        const h = harness();
        await handleMcp(command, h.rpc, h.write);
        assert.equal(h.calls.length, 0, command);
        assert.match(h.out.join(""), /usage:/, command);
    }

    await assert.rejects(handleMcp(malformed, harness().rpc, () => {}), /not valid JSON/);
    await assert.rejects(handleMcp("/no/such/definition.json", harness().rpc, () => {}), /not readable/);

    const semantic = harness();
    await handleMcp(structurallyInvalid, semantic.rpc, semantic.write);
    assert.deepEqual(semantic.calls, [{ method: "workspace.mcp.attach", params: { server: {} } }]);
});
