import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeDefinition, handleMcp } from "./mcp.ts";

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

test("[§cli-workspace-mcp-controls] add composes one exact definition from alias, target, and local options", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-options-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "echo options.json");
    const options = { args: ["--stdio"], tools: ["issue_read"], read: ["issue_read"] };
    await writeFile(file, JSON.stringify(options));
    const h = harness({
        "worker.mcp.add": {
            status: 201,
            alias: "echo",
            definition: { alias: "echo", origin: "worker", state: "active", definition: { name: "echo", transport: "stdio", command: "/opt/MCP Servers/echo", args: ["--stdio"] } },
        },
    });

    await handleMcp(["add", "echo", "/opt/MCP Servers/echo", file], h.rpc, h.write);

    assert.deepEqual(h.calls, [{
        method: "worker.mcp.add",
        params: {
            alias: "echo",
            definition: { name: "echo", transport: "stdio", command: "/opt/MCP Servers/echo", ...options },
        },
    }]);
    assert.match(h.out.join(""), /added: echo \(active\)/);
});

test("[§cli-workspace-mcp-controls] composeDefinition selects Streamable HTTP for absolute URLs and stdio otherwise", () => {
    assert.deepEqual(composeDefinition("brave", "https://example.test/mcp", { tools: ["search"] }), {
        name: "brave", transport: "http", url: "https://example.test/mcp", tools: ["search"],
    });
    assert.deepEqual(composeDefinition("echo", "echo-mcp"), { name: "echo", transport: "stdio", command: "echo-mcp", args: [] });
});

test("[§cli-workspace-mcp-controls] enable, disable, remove, and oauth map exactly to Worker actions", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-enable-options-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "gitea.json");
    const options = { args: ["plurnk_pk"] };
    await writeFile(file, JSON.stringify(options));
    const echo = { name: "echo", transport: "stdio", command: "echo-mcp", args: ["project-default"] };
    const h = harness({
        "worker.mcp.list": { definitions: [{ alias: "echo", origin: "service", state: "disabled", definition: echo }] },
        "worker.mcp.add": { status: 201, alias: "echo", definition: { alias: "echo", state: "active" } },
        "worker.mcp.enable": { status: 200, alias: "echo", definition: { alias: "echo", state: "active" } },
        "worker.mcp.disable": { status: 200, alias: "echo", definition: { alias: "echo", state: "disabled" } },
        "worker.mcp.remove": { status: 200, alias: "echo", removed: true },
        "worker.mcp.oauth.complete": { status: 200, alias: "gitea", definition: { alias: "gitea", state: "active" } },
    });
    await handleMcp("enable echo", h.rpc, h.write);
    await handleMcp(`enable echo "${file}"`, h.rpc, h.write);
    await handleMcp("disable echo", h.rpc, h.write);
    await handleMcp("remove echo", h.rpc, h.write);
    await handleMcp("oauth gitea https://client.example/callback?code=x&state=y", h.rpc, h.write);
    assert.deepEqual(h.calls, [
        { method: "worker.mcp.enable", params: { alias: "echo" } },
        { method: "worker.mcp.list", params: {} },
        { method: "worker.mcp.add", params: { alias: "echo", definition: { ...echo, ...options } } },
        { method: "worker.mcp.disable", params: { alias: "echo" } },
        { method: "worker.mcp.remove", params: { alias: "echo" } },
        {
            method: "worker.mcp.oauth.complete",
            params: { alias: "gitea", callbackUrl: "https://client.example/callback?code=x&state=y" },
        },
    ]);
    assert.match(h.out.join(""), /enabled: echo \(active\)/);
    assert.match(h.out.join(""), /added: echo \(active\)/);
    assert.match(h.out.join(""), /disabled: echo \(disabled\)/);
    assert.match(h.out.join(""), /removed: echo/);
    assert.match(h.out.join(""), /authorized: gitea \(active\)/);
});

test("[§cli-workspace-mcp-controls] enabling a candidate from the client's own configuration adds its discovered definition", async () => {
    const overlay = { PLURNK_MCP_LOCAL: "local-mcp" };
    const local = { name: "local", transport: "stdio", command: "local-mcp", args: [] };
    const h = harness({
        "worker.mcp.discover": { candidates: [{ alias: "local", definition: local, provenance: { kind: "client-configuration" } }] },
        "worker.mcp.add": { status: 201, alias: "local", definition: { alias: "local", state: "active" } },
    });
    await handleMcp("enable local", h.rpc, h.write, { overlay });
    assert.deepEqual(h.calls, [
        { method: "worker.mcp.discover", params: { configuration: overlay } },
        { method: "worker.mcp.add", params: { alias: "local", definition: local } },
    ]);
    assert.match(h.out.join(""), /added: local \(active\)/);
});

test("[§cli-workspace-mcp-controls] authorization-required result prints the URL and exact completion command", async () => {
    const h = harness({
        "worker.mcp.add": {
            status: 202,
            alias: "gitea",
            definition: { alias: "gitea", state: "authorization-required", authorization: { url: "https://gitea.example/authorize?state=abc" } },
        },
    });
    await handleMcp("add gitea gitea-mcp", h.rpc, h.write);
    assert.match(h.out.join(""), /https:\/\/gitea\.example\/authorize\?state=abc/);
    assert.match(h.out.join(""), /\/mcp oauth gitea <callback-url>/);
});

test("[§cli-workspace-mcp-controls] list renders every definition state and the client's undelivered candidates", async () => {
    const overlay = {
        PLURNK_MCP_GITEA_ARGS: '["plurnk_pk"]',
        PLURNK_MCP_LOCAL: "local-mcp",
    };
    const h = harness({
        "worker.mcp.list": {
            definitions: [
                { alias: "brave", origin: "service", state: "disabled", definition: { name: "brave", transport: "http", url: "https://example.test/mcp" } },
                {
                    alias: "gitea",
                    origin: "worker",
                    state: "active",
                    definition: { name: "gitea", transport: "stdio", command: "gitea-mcp", args: [], tools: ["issue_read"] },
                    detail: { tools: ["issue_read", "issue_write"] },
                },
                { alias: "flaky", origin: "worker", state: "unavailable", definition: { name: "flaky", transport: "stdio", command: "flaky-mcp", args: [] }, problem: { detail: "spawn failed" } },
            ],
        },
        "worker.mcp.discover": {
            candidates: [{ alias: "local", definition: { name: "local", transport: "stdio", command: "local-mcp", args: [] }, provenance: { kind: "client-configuration" } }],
        },
    });
    await handleMcp("", h.rpc, h.write, { overlay });
    assert.deepEqual(h.calls, [
        { method: "worker.mcp.list", params: {} },
        { method: "worker.mcp.discover", params: { configuration: overlay } },
    ]);
    const text = h.out.join("");
    assert.match(text, /brave\s+disabled\s+http\s+https:\/\/example\.test\/mcp\s+\(service\)/);
    assert.match(text, /gitea\s+active\s+stdio\s+gitea-mcp\s+1\/2 tools/);
    assert.match(text, /flaky\s+unavailable\s+stdio\s+flaky-mcp\s+— spawn failed/);
    assert.match(text, /from your configuration \(not added\):\n\s+local\s+candidate\s+stdio\s+local-mcp/);
});

test("[§cli-workspace-mcp-controls] discover projects a source into candidates without adding anything", async () => {
    const h = harness({
        "worker.mcp.discover": { candidates: [{ alias: "echo", definition: { name: "echo", transport: "http", url: "https://echo.test/mcp" } }] },
    });
    await handleMcp("discover https://echo.test/mcp", h.rpc, h.write);
    assert.deepEqual(h.calls, [{ method: "worker.mcp.discover", params: { source: "https://echo.test/mcp" } }]);
    assert.match(h.out.join(""), /echo\s+candidate\s+http\s+https:\/\/echo\.test\/mcp/);
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
        "discover",
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
        params: { alias: "echo", definition: { name: "echo", transport: "stdio", command: "echo-mcp", args: [] } },
    }]);
});
