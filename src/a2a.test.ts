import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeDefinition, handleA2a } from "./a2a.ts";

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

test("[§cli-outbound-agents] list renders every definition state from the workspace's a2a family", async () => {
    const h = harness({
        "workspace.a2a.list": {
            definitions: [
                { alias: "researcher", origin: "service", state: "active", definition: { name: "researcher", url: "https://agent.example" }, detail: { name: "Research Assistant", version: "2.1", description: "Finds sources", skills: ["search", "summarize"] } },
                { alias: "scribe", origin: "workspace", state: "disabled", definition: { name: "scribe", url: "https://scribe.example" } },
                { alias: "ghost", origin: "service", state: "unavailable", definition: { name: "ghost", url: "http://127.0.0.1:9" }, problem: { detail: "no discoverable standard Agent Card" } },
            ],
        },
    });
    await handleA2a([], h.rpc, h.write);
    assert.deepEqual(h.calls, [{ method: "workspace.a2a.list", params: {} }]);
    const text = h.out.join("");
    assert.match(text, /researcher\s+active\s+https:\/\/agent\.example\s+Research Assistant v2\.1\s+2 skills\s+\(service\)/);
    assert.match(text, /scribe\s+disabled\s+https:\/\/scribe\.example/);
    assert.match(text, /ghost\s+unavailable\s+http:\/\/127\.0\.0\.1:9\s+\(service\)\s+— no discoverable standard Agent Card/);
    const empty = harness({ "workspace.a2a.list": { definitions: [] } });
    await handleA2a("", empty.rpc, empty.write);
    assert.match(empty.out.join(""), /A2A agents: none/);
});

test("[§cli-outbound-agents] discover sends one URL and renders inert card-derived candidates", async () => {
    const h = harness({
        "workspace.a2a.discover": { candidates: [{ alias: "research-assistant", summary: "Finds sources", definition: { name: "research-assistant", url: "https://agent.example" }, provenance: { kind: "agent-card", source: "https://agent.example" } }] },
    });
    await handleA2a("discover https://agent.example", h.rpc, h.write);
    assert.deepEqual(h.calls, [{ method: "workspace.a2a.discover", params: { source: "https://agent.example" } }]);
    assert.match(h.out.join(""), /research-assistant\s+candidate\s+https:\/\/agent\.example\s+Finds sources/);
});

test("[§cli-outbound-agents] add composes one exact A2aAgentDefinition; enable, disable, and remove map to workspace actions", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "agents-options-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "researcher options.json");
    const options = { cardPath: "/cards/research.json", authorization: { type: "bearer", token: "${RESEARCH_TOKEN}" } };
    await writeFile(file, JSON.stringify(options));
    const h = harness({
        "workspace.a2a.add": { status: 201, alias: "researcher", definition: { alias: "researcher", state: "active" } },
        "workspace.a2a.enable": { status: 200, alias: "researcher", definition: { alias: "researcher", state: "active" } },
        "workspace.a2a.disable": { status: 200, alias: "researcher", definition: { alias: "researcher", state: "disabled" } },
        "workspace.a2a.remove": { status: 200, alias: "researcher", removed: true },
    });
    await handleA2a(["add", "researcher", "https://agent.example", file], h.rpc, h.write);
    await handleA2a("add scribe https://scribe.example", h.rpc, h.write);
    await handleA2a("enable researcher", h.rpc, h.write);
    await handleA2a("disable researcher", h.rpc, h.write);
    await handleA2a("remove researcher", h.rpc, h.write);
    assert.deepEqual(h.calls, [
        { method: "workspace.a2a.add", params: { alias: "researcher", definition: { name: "researcher", url: "https://agent.example", ...options } } },
        { method: "workspace.a2a.add", params: { alias: "scribe", definition: { name: "scribe", url: "https://scribe.example" } } },
        { method: "workspace.a2a.enable", params: { alias: "researcher" } },
        { method: "workspace.a2a.disable", params: { alias: "researcher" } },
        { method: "workspace.a2a.remove", params: { alias: "researcher" } },
    ]);
    assert.deepEqual(composeDefinition("peer", "https://peer.example"), { name: "peer", url: "https://peer.example" });
    const text = h.out.join("");
    assert.match(text, /added: researcher \(active\)/);
    assert.match(text, /enabled: researcher \(active\)/);
    assert.match(text, /disabled: researcher \(disabled\)/);
    assert.match(text, /removed: researcher/);
});

test("[§cli-outbound-agents] only tokenization and local JSON syntax are client validation boundaries", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "agents-invalid-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const malformed = join(dir, "bad.json");
    await writeFile(malformed, "{nope");
    for (const command of ["add", "add one", "discover", "discover a b", "enable", "disable a b", "remove", "add echo 'unterminated", "unknown"]) {
        const h = harness();
        await handleA2a(command, h.rpc, h.write);
        assert.equal(h.calls.length, 0, command);
        assert.match(h.out.join(""), /usage:/, command);
    }
    await assert.rejects(handleA2a(`add peer https://peer.example "${malformed}"`, harness().rpc, () => {}), /not valid JSON/);
    await assert.rejects(handleA2a("add peer https://peer.example /no/such/options.json", harness().rpc, () => {}), /not readable/);
});
