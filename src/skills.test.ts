import { test } from "node:test";
import assert from "node:assert/strict";
import { handleSkills, isSource } from "./skills.ts";

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

test("[§cli-universal-agent-skills] list renders every definition state from the workspace's skills family", async () => {
    const h = harness({
        "workspace.skills.list": {
            definitions: [
                { alias: "grep", origin: "service", state: "active", definition: { name: "grep", scope: "project" }, detail: { scope: "project", description: "Find text" } },
                { alias: "review", origin: "workspace", state: "disabled", definition: { name: "review", scope: "global", source: "acme/kit" } },
                { alias: "bad", origin: "service", state: "unavailable", definition: { name: "bad", scope: "global" }, problem: { detail: "requires YAML frontmatter" } },
            ],
        },
    });
    await handleSkills([], h.rpc, h.write);
    assert.deepEqual(h.calls, [{ method: "workspace.skills.list", params: {} }]);
    const text = h.out.join("");
    assert.match(text, /grep\s+active\s+project\s+Find text/);
    assert.match(text, /review\s+disabled\s+global\s+acme\/kit\s+\(workspace\)/);
    assert.match(text, /bad\s+unavailable\s+global\s+— requires YAML frontmatter/);
    const empty = harness({ "workspace.skills.list": { definitions: [] } });
    await handleSkills("", empty.rpc, empty.write);
    assert.match(empty.out.join(""), /Agent Skills: none/);
});

test("[§cli-universal-agent-skills] discover sends a registry query or an explicit source and renders inert candidates", async () => {
    const h = harness({
        "workspace.skills.discover": {
            candidates: [{ alias: "changelog", summary: "1200 installs", definition: { name: "changelog", scope: "project", source: "acme/kit" }, provenance: { kind: "registry", source: "acme/kit", reference: "https://skills.sh/acme/kit/changelog" } }],
        },
    });
    await handleSkills("discover react changelog", h.rpc, h.write);
    await handleSkills("discover acme/kit", h.rpc, h.write);
    await handleSkills("discover ./vendor/skills", h.rpc, h.write);
    await handleSkills("discover https://github.com/acme/kit", h.rpc, h.write);
    assert.deepEqual(h.calls, [
        { method: "workspace.skills.discover", params: { query: "react changelog" } },
        { method: "workspace.skills.discover", params: { source: "acme/kit" } },
        { method: "workspace.skills.discover", params: { source: "./vendor/skills" } },
        { method: "workspace.skills.discover", params: { source: "https://github.com/acme/kit" } },
    ]);
    assert.match(h.out.join(""), /changelog\s+candidate\s+acme\/kit\s+1200 installs\s+https:\/\/skills\.sh\/acme\/kit\/changelog/);
    assert.equal(isSource("react"), false);
    assert.equal(isSource("~/skills"), true);
});

test("[§cli-universal-agent-skills] add composes one exact SkillDefinition; enable, disable, and remove map to workspace actions", async () => {
    const h = harness({
        "workspace.skills.add": { status: 201, alias: "changelog", definition: { alias: "changelog", state: "active" } },
        "workspace.skills.enable": { status: 200, alias: "changelog", definition: { alias: "changelog", state: "active" } },
        "workspace.skills.disable": { status: 200, alias: "changelog", definition: { alias: "changelog", state: "disabled" } },
        "workspace.skills.remove": { status: 200, alias: "changelog", removed: true },
    });
    await handleSkills("add changelog acme/kit", h.rpc, h.write);
    await handleSkills("add changelog acme/kit --global", h.rpc, h.write);
    await handleSkills("enable changelog", h.rpc, h.write);
    await handleSkills("disable changelog", h.rpc, h.write);
    await handleSkills("remove changelog", h.rpc, h.write);
    assert.deepEqual(h.calls, [
        { method: "workspace.skills.add", params: { alias: "changelog", definition: { name: "changelog", scope: "project", source: "acme/kit" } } },
        { method: "workspace.skills.add", params: { alias: "changelog", definition: { name: "changelog", scope: "global", source: "acme/kit" } } },
        { method: "workspace.skills.enable", params: { alias: "changelog" } },
        { method: "workspace.skills.disable", params: { alias: "changelog" } },
        { method: "workspace.skills.remove", params: { alias: "changelog" } },
    ]);
    const text = h.out.join("");
    assert.match(text, /added: changelog \(active\)/);
    assert.match(text, /enabled: changelog \(active\)/);
    assert.match(text, /disabled: changelog \(disabled\)/);
    assert.match(text, /removed: changelog/);
});

test("[§cli-universal-agent-skills] an unavailable outcome renders the daemon's Problem beside the state", async () => {
    const h = harness({
        "workspace.skills.add": { status: 201, alias: "ghost", definition: { alias: "ghost", state: "unavailable", problem: { detail: "could not be installed" } } },
    });
    await handleSkills("add ghost acme/kit", h.rpc, h.write);
    assert.match(h.out.join(""), /added: ghost \(unavailable\)\s+— could not be installed/);
});

test("[§cli-universal-agent-skills] malformed client command shapes never dispatch", async () => {
    for (const command of ["add", "add one", "add one two three", "discover", "enable", "disable a b", "remove", "add echo 'unterminated", "update", "list --global"]) {
        const h = harness();
        await handleSkills(command, h.rpc, h.write);
        assert.equal(h.calls.length, 0, command);
        assert.match(h.out.join(""), /usage:/, command);
    }
});
