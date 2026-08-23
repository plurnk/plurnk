import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeDefinition, handleAgents } from "./agents.ts";

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

test("[§cli-outbound-agents] list renders every definition state from the Worker's agents family", async () => {
    const h = harness({
        "worker.agents.list": {
            definitions: [
                { alias: "researcher", origin: "service", state: "active", definition: { name: "researcher", url: "https://agent.example" }, detail: { name: "Research Assistant", version: "2.1", description: "Finds sources", skills: ["search", "summarize"] } },
                { alias: "scribe", origin: "worker", state: "disabled", definition: { name: "scribe", url: "https://scribe.example" } },
                { alias: "ghost", origin: "service", state: "unavailable", definition: { name: "ghost", url: "http://127.0.0.1:9" }, problem: { detail: "no discoverable standard Agent Card" } },
            ],
        },
    });
    await handleAgents([], h.rpc, h.write);
    assert.deepEqual(h.calls, [{ method: "worker.agents.list", params: {} }]);
    const text = h.out.join("");
    assert.match(text, /researcher\s+active\s+https:\/\/agent\.example\s+Research Assistant v2\.1\s+2 skills\s+\(service\)/);
    assert.match(text, /scribe\s+disabled\s+https:\/\/scribe\.example/);
    assert.match(text, /ghost\s+unavailable\s+http:\/\/127\.0\.0\.1:9\s+\(service\)\s+— no discoverable standard Agent Card/);
    const empty = harness({ "worker.agents.list": { definitions: [] } });
    await handleAgents("", empty.rpc, empty.write);
    assert.match(empty.out.join(""), /A2A agents: none/);
});

test("[§cli-outbound-agents] discover sends one URL and renders inert card-derived candidates", async () => {
    const h = harness({
        "worker.agents.discover": { candidates: [{ alias: "research-assistant", summary: "Finds sources", definition: { name: "research-assistant", url: "https://agent.example" }, provenance: { kind: "agent-card", source: "https://agent.example" } }] },
    });
    await handleAgents("discover https://agent.example", h.rpc, h.write);
    assert.deepEqual(h.calls, [{ method: "worker.agents.discover", params: { source: "https://agent.example" } }]);
    assert.match(h.out.join(""), /research-assistant\s+candidate\s+https:\/\/agent\.example\s+Finds sources/);
});

test("[§cli-outbound-agents] add composes one exact A2aAgentDefinition; enable, disable, and remove map to Worker actions", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "agents-options-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "researcher options.json");
    const options = { cardPath: "/cards/research.json", authorization: { type: "bearer", token: "${RESEARCH_TOKEN}" } };
    await writeFile(file, JSON.stringify(options));
    const h = harness({
        "worker.agents.add": { status: 201, alias: "researcher", definition: { alias: "researcher", state: "active" } },
        "worker.agents.enable": { status: 200, alias: "researcher", definition: { alias: "researcher", state: "active" } },
        "worker.agents.disable": { status: 200, alias: "researcher", definition: { alias: "researcher", state: "disabled" } },
        "worker.agents.remove": { status: 200, alias: "researcher", removed: true },
    });
    await handleAgents(["add", "researcher", "https://agent.example", file], h.rpc, h.write);
    await handleAgents("add scribe https://scribe.example", h.rpc, h.write);
    await handleAgents("enable researcher", h.rpc, h.write);
    await handleAgents("disable researcher", h.rpc, h.write);
    await handleAgents("remove researcher", h.rpc, h.write);
    assert.deepEqual(h.calls, [
        { method: "worker.agents.add", params: { alias: "researcher", definition: { name: "researcher", url: "https://agent.example", ...options } } },
        { method: "worker.agents.add", params: { alias: "scribe", definition: { name: "scribe", url: "https://scribe.example" } } },
        { method: "worker.agents.enable", params: { alias: "researcher" } },
        { method: "worker.agents.disable", params: { alias: "researcher" } },
        { method: "worker.agents.remove", params: { alias: "researcher" } },
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
        await handleAgents(command, h.rpc, h.write);
        assert.equal(h.calls.length, 0, command);
        assert.match(h.out.join(""), /usage:/, command);
    }
    await assert.rejects(handleAgents(`add peer https://peer.example "${malformed}"`, harness().rpc, () => {}), /not valid JSON/);
    await assert.rejects(handleAgents("add peer https://peer.example /no/such/options.json", harness().rpc, () => {}), /not readable/);
});
