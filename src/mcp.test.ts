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

test("[§cli-workspace-mcp-controls] add forwards alias, exact target, and optional local options", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-options-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "echo options.json");
    const options = { args: ["--stdio"], tools: ["issue_read"], read: ["issue_read"] };
    await writeFile(file, JSON.stringify(options));
    const h = harness({
        "worker.mcp.add": {
            status: 201,
            server: { alias: "echo", state: "connected", transport: "stdio" },
        },
    });

    await handleMcp(["add", "echo", "/opt/MCP Servers/echo", file], h.rpc, h.write);

    assert.deepEqual(h.calls, [{
        method: "worker.mcp.add",
        params: { alias: "echo", target: "/opt/MCP Servers/echo", options },
    }]);
    assert.match(h.out.join(""), /added: echo \(connected\)/);
});

test("[§cli-workspace-mcp-controls] enable, disable, remove, and oauth map exactly to workspace actions", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-enable-options-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "gitea.json");
    const options = { args: ["plurnk_pk"] };
    await writeFile(file, JSON.stringify(options));
    const overlay = { PLURNK_MCP_ECHO_ARGS: '["project-default"]' };
    const h = harness({
        "worker.mcp.enable": { status: 200, server: { alias: "echo", state: "connected" } },
        "worker.mcp.disable": { status: 200, server: { alias: "echo", state: "disabled" } },
        "worker.mcp.remove": { status: 200, alias: "echo", removed: true },
        "worker.mcp.oauth.complete": { status: 200, server: { alias: "gitea", state: "connected" } },
    });
    await handleMcp(`enable echo "${file}"`, h.rpc, h.write, { overlay });
    await handleMcp("disable echo", h.rpc, h.write, { overlay });
    await handleMcp("remove echo", h.rpc, h.write, { overlay });
    await handleMcp("oauth gitea https://client.example/callback?code=x&state=y", h.rpc, h.write, { overlay });
    assert.deepEqual(h.calls, [
        { method: "worker.mcp.enable", params: { alias: "echo", overlay, options } },
        { method: "worker.mcp.disable", params: { alias: "echo" } },
        { method: "worker.mcp.remove", params: { alias: "echo" } },
        {
            method: "worker.mcp.oauth.complete",
            params: { alias: "gitea", callbackUrl: "https://client.example/callback?code=x&state=y" },
        },
    ]);
    assert.match(h.out.join(""), /enabled: echo \(connected\)/);
    assert.match(h.out.join(""), /disabled: echo \(disabled\)/);
    assert.match(h.out.join(""), /removed: echo/);
});

test("[§cli-workspace-mcp-controls] authorization-required result prints the URL and exact completion command", async () => {
    const h = harness({
        "worker.mcp.add": {
            status: 202,
            authorization: { url: "https://gitea.example/authorize?state=abc" },
        },
    });
    await handleMcp("add gitea gitea-mcp", h.rpc, h.write);
    assert.match(h.out.join(""), /https:\/\/gitea\.example\/authorize\?state=abc/);
    assert.match(h.out.join(""), /\/mcp oauth gitea <callback-url>/);
});

test("[§cli-workspace-mcp-controls] list exposes cold-disabled and connected servers", async () => {
    const overlay = {
        PLURNK_MCP_GITEA_ARGS: '["plurnk_pk"]',
        PLURNK_MCP_LOCAL: "local-mcp",
    };
    const h = harness({
        "worker.mcp.list": {
            servers: [
                { alias: "brave", state: "disabled", transport: "http", target: "https://example.test/mcp" },
                {
                    alias: "gitea",
                    state: "connected",
                    transport: "stdio",
                    target: "gitea-mcp",
                    enabledTools: ["issue_read"],
                    tools: ["issue_read", "issue_write"],
                },
            ],
        },
    });
    await handleMcp("", h.rpc, h.write, { overlay });
    assert.deepEqual(h.calls, [{ method: "worker.mcp.list", params: { overlay } }]);
    assert.match(h.out.join(""), /brave\s+disabled\s+http\s+https:\/\/example\.test\/mcp/);
    assert.match(h.out.join(""), /gitea\s+connected\s+stdio\s+gitea-mcp\s+1\/2 tools/);
});

test("[§cli-workspace-mcp-controls] only tokenization and local JSON syntax are client validation boundaries", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-invalid-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const malformed = join(dir, "bad.json");
    const structurallyInvalid = join(dir, "semantic.json");
    await writeFile(malformed, "{nope");
    await writeFile(structurallyInvalid, "{}");

    for (const command of [
        "add",
        "add one",
        "enable",
        "enable one first.json second.json",
        "disable two aliases",
        "remove",
        "oauth gitea",
        "add echo 'unterminated",
        "unknown",
    ]) {
        const h = harness();
        await handleMcp(command, h.rpc, h.write);
        assert.equal(h.calls.length, 0, command);
        assert.match(h.out.join(""), /usage:/, command);
    }

    await assert.rejects(
        handleMcp(`add echo echo-mcp "${malformed}"`, harness().rpc, () => {}),
        /not valid JSON/,
    );
    await assert.rejects(
        handleMcp("add echo echo-mcp /no/such/options.json", harness().rpc, () => {}),
        /not readable/,
    );

    const semantic = harness();
    await handleMcp(`add echo echo-mcp "${structurallyInvalid}"`, semantic.rpc, semantic.write);
    assert.deepEqual(semantic.calls, [{
        method: "worker.mcp.add",
        params: { alias: "echo", target: "echo-mcp", options: {} },
    }]);
});
