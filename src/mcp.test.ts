import { test } from "node:test";
import assert from "node:assert/strict";
import { ProblemError } from "./diagnostics.ts";
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

test("[§cli-workspace-mcp-controls] list renders each server's state, type, target, catalog, workspace origin, and Problem", async () => {
    const h = harness({
        "workspace.mcp.list": {
            family: "mcp",
            definitions: [
                { alias: "brave", origin: "service", state: "disabled", definition: { name: "brave", type: "streamable-http", url: "https://example.test/mcp" } },
                { alias: "echo", origin: "workspace", state: "dormant", definition: { name: "echo", type: "stdio", command: "echo-mcp" } },
                {
                    alias: "gitea",
                    origin: "service",
                    state: "active",
                    definition: { name: "gitea", type: "stdio", command: "gitea-mcp", args: ["--stdio"] },
                    detail: { tools: ["issue_read", "issue_write"] },
                },
                { alias: "flaky", origin: "service", state: "unavailable", definition: { name: "flaky", type: "stdio", command: "./bin/flaky" }, problem: { detail: "spawn failed" } },
            ],
        },
    });
    await handleMcp("", h.rpc, h.write);
    assert.deepEqual(h.calls, [{ method: "workspace.mcp.list", params: {} }], "listing is one inspection");
    const text = h.out.join("");
    assert.match(text, /^  brave  disabled  streamable-http  https:\/\/example\.test\/mcp$/mu);
    assert.match(text, /^  echo  dormant  stdio  echo-mcp  \(workspace\)$/mu, "a server the workspace added is the one remove applies to");
    assert.match(text, /^  gitea  active  stdio  gitea-mcp  2 tools$/mu);
    assert.match(text, /^  flaky  unavailable  stdio  \.\/bin\/flaky  — spawn failed$/mu);

    const empty = harness({ "workspace.mcp.list": { family: "mcp", definitions: [] } });
    await handleMcp([], empty.rpc, empty.write);
    assert.equal(empty.out.join(""), "  MCP servers: none\n");
});

test("[§cli-workspace-mcp-controls] discover searches the MCP Registry by query and renders each candidate on one line", async () => {
    const provenance = { kind: "registry", source: "https://registry.modelcontextprotocol.io", reference: "io.example/server@1.2.3" };
    const h = harness({
        "workspace.mcp.discover": {
            family: "mcp",
            candidates: [
                {
                    alias: "server",
                    summary: "Search the example index. — npx -y @example/server@1.2.3 — Needs EXAMPLE_API_KEY.",
                    definition: { name: "server", type: "stdio", command: "npx", args: ["-y", "@example/server@1.2.3"] },
                    provenance,
                },
                {
                    alias: "server",
                    summary: "Search the example index. — https://example.test/mcp",
                    definition: { name: "server", type: "streamable-http", url: "https://example.test/mcp" },
                    provenance,
                },
            ],
        },
    });
    await handleMcp("discover example search", h.rpc, h.write);
    assert.deepEqual(h.calls, [{ method: "workspace.mcp.discover", params: { query: "example search" } }], "discovery adds nothing");
    assert.equal(h.out.join(""), [
        "  server  candidate  stdio  npx  Search the example index. — npx -y @example/server@1.2.3 — Needs EXAMPLE_API_KEY.\n",
        "  server  candidate  streamable-http  https://example.test/mcp  Search the example index. — https://example.test/mcp\n",
    ].join(""));

    const none = harness({ "workspace.mcp.discover": { family: "mcp", candidates: [] } });
    await handleMcp(["discover", "nothing"], none.rpc, none.write);
    assert.equal(none.out.join(""), "  candidates: none\n");
});

test("[§cli-workspace-mcp-controls] add composes one exact definition from its alias and target, and verbatim arguments", async () => {
    const h = harness({
        "workspace.mcp.add": { status: 201, family: "mcp", alias: "echo", definition: { alias: "echo", origin: "workspace", state: "active" } },
    });
    await handleMcp("add echo npx -y @example/echo", h.rpc, h.write);
    await handleMcp(["add", "echo", "node", "/srv/echo.js", "--global"], h.rpc, h.write);
    await handleMcp(`add docs node "/srv/mcp servers/docs.js" --plurnk`, h.rpc, h.write);
    await handleMcp("add brave https://example.test/mcp", h.rpc, h.write);
    await handleMcp("add echo ./bin/echo", h.rpc, h.write);
    assert.deepEqual(h.calls.map(({ params }) => params), [
        { alias: "echo", definition: { name: "echo", type: "stdio", command: "npx", args: ["-y", "@example/echo"] } },
        { alias: "echo", definition: { name: "echo", type: "stdio", command: "node", args: ["/srv/echo.js", "--global"] } },
        { alias: "docs", definition: { name: "docs", type: "stdio", command: "node", args: ["/srv/mcp servers/docs.js", "--plurnk"] } },
        { alias: "brave", definition: { name: "brave", type: "streamable-http", url: "https://example.test/mcp" } },
        // Relative commands resolve against the daemon-owned working directory.
        { alias: "echo", definition: { name: "echo", type: "stdio", command: "./bin/echo" } },
    ]);
    assert.ok(h.calls.every(({ method }) => method === "workspace.mcp.add"));
    assert.match(h.out.join(""), /^  added: echo \(active\)$/mu);
});

test("[§cli-workspace-mcp-controls] composeDefinition selects Streamable HTTP for absolute URLs and stdio otherwise", () => {
    assert.deepEqual(composeDefinition("brave", "https://example.test/mcp"), {
        name: "brave", type: "streamable-http", url: "https://example.test/mcp",
    });
    assert.deepEqual(composeDefinition("echo", "echo-mcp"), { name: "echo", type: "stdio", command: "echo-mcp" }, "no arguments, no args member");
    assert.deepEqual(composeDefinition("echo", "echo-mcp", ["--stdio"]), {
        name: "echo", type: "stdio", command: "echo-mcp", args: ["--stdio"],
    });
});

test("[§cli-workspace-mcp-controls] enable, disable, remove, and oauth map exactly to workspace actions", async () => {
    const h = harness({
        "workspace.mcp.enable": { status: 200, alias: "echo", definition: { alias: "echo", state: "active" } },
        "workspace.mcp.disable": { status: 200, alias: "echo", definition: { alias: "echo", state: "disabled" } },
        "workspace.mcp.remove": { status: 200, family: "mcp", alias: "echo", removed: true },
        "workspace.mcp.oauth.complete": { status: 200, alias: "gitea", definition: { alias: "gitea", state: "active" } },
    });
    await handleMcp("enable echo", h.rpc, h.write);
    await handleMcp(["disable", "echo"], h.rpc, h.write);
    await handleMcp("remove echo", h.rpc, h.write);
    await handleMcp("oauth gitea https://client.example/callback?code=x&state=y", h.rpc, h.write);
    assert.deepEqual(h.calls, [
        { method: "workspace.mcp.enable", params: { alias: "echo" } },
        { method: "workspace.mcp.disable", params: { alias: "echo" } },
        { method: "workspace.mcp.remove", params: { alias: "echo" } },
        {
            method: "workspace.mcp.oauth.complete",
            params: { alias: "gitea", callbackUrl: "https://client.example/callback?code=x&state=y" },
        },
    ]);
    assert.equal(h.out.join(""), [
        "  enabled: echo (active)\n",
        "  disabled: echo (disabled)\n",
        "  removed: echo\n",
        "  authorized: gitea (active)\n",
    ].join(""));
});

test("[§cli-workspace-mcp-controls] an add or enable requiring authorization prints the URL and exact completion command", async () => {
    const required = (alias: string) => ({
        status: 202,
        alias,
        definition: { alias, state: "authorization-required", authorization: { url: `https://gitea.example/authorize?state=${alias}` } },
    });
    const h = harness({ "workspace.mcp.add": required("gitea"), "workspace.mcp.enable": required("forge") });
    await handleMcp("add gitea https://gitea.example/mcp", h.rpc, h.write);
    await handleMcp("enable forge", h.rpc, h.write);
    assert.equal(h.out.join(""), [
        "  authorization required: https://gitea.example/authorize?state=gitea\n",
        "  authorize: /mcp oauth gitea [callback-url]\n",
        "  authorization required: https://gitea.example/authorize?state=forge\n",
        "  authorize: /mcp oauth forge [callback-url]\n",
    ].join(""));
});

test("[§cli-workspace-mcp-controls] a URL-only authentication challenge names the client handoff without requiring a URL", async () => {
    const h = harness({ "workspace.mcp.add": {
        status: 202, family: "mcp", alias: "remote",
        definition: { alias: "remote", state: "authorization-required", authorization: {} },
    } });
    await handleMcp("add remote https://example.test/mcp", h.rpc, h.write);
    assert.match(h.out.join(""), /authorization required: remote/u);
    assert.match(h.out.join(""), /\/mcp oauth remote/u);
    assert.equal(h.calls.length, 1, "adding a server does not begin browser authorization");
});

test("[§cli-mcp-oauth-callback] an already authorized server needs no browser or callback submission", async () => {
    const result = { status: 200, alias: "ready", definition: { alias: "ready", state: "active" } };
    const h = harness({ "workspace.mcp.list": { family: "mcp", definitions: [result.definition] } });
    assert.deepEqual(await handleMcp("oauth ready", h.rpc, h.write), result);
    assert.deepEqual(h.calls, [{ method: "workspace.mcp.list", params: {} }]);
    assert.equal(h.out.join(""), "  authorized: ready (active)\n");
});

test("[§cli-mcp-oauth-callback] an invalid reception deadline fails before mutating the server", async (t) => {
    const key = "PLURNK_CLIENT_OAUTH_TIMEOUT_MS";
    const previous = process.env[key];
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    for (const value of ["0", "-1", "not-a-number"]) {
        process.env[key] = value;
        const h = harness();
        await assert.rejects(handleMcp("oauth server", h.rpc, h.write), { name: "TypeError", knob: key });
        assert.deepEqual(h.calls, []);
    }
});

test("[§cli-workspace-mcp-controls] daemon Problems cross unchanged and nothing renders as success", async () => {
    const refused = new ProblemError({
        type: "https://problems.plurnk.xyz/functionality/alias-service-owned",
        title: "Alias service owned",
        status: 409,
        detail: "'legacy' is provided to this workspace, not added by it, so it cannot be removed here.",
    });
    for (const input of ["discover echo", "add echo echo-mcp", "enable legacy", "disable legacy", "remove legacy"]) {
        const out: string[] = [];
        const rpc = { call: async (): Promise<unknown> => { throw refused; } };
        await assert.rejects(handleMcp(input, rpc, (text) => out.push(text)), (error: unknown) => error === refused, input);
        assert.deepEqual(out, [], input);
    }
});

test("[§cli-workspace-mcp-controls] only tokenization and arity are client validation boundaries", async () => {
    for (const command of [
        "discover",
        "add",
        "add one",
        "add --plurnk one",
        "add --global",
        "add web https://example.test/mcp extra",
        "enable",
        "enable one two",
        "disable two aliases",
        "remove",
        "remove one two",
        "oauth",
        "oauth gitea callback extra",
        "add echo 'unterminated",
        "unknown",
    ]) {
        const h = harness();
        assert.equal(await handleMcp(command, h.rpc, h.write), null, command);
        assert.equal(h.calls.length, 0, command);
        assert.match(h.out.join(""), /usage:/, command);
    }
});
