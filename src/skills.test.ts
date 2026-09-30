import { test } from "node:test";
import assert from "node:assert/strict";
import { handleSkills } from "./skills.ts";

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
                { alias: "grep", origin: "service", state: "active", definition: { name: "grep", source: "/srv/grep" }, detail: { description: "Find text" } },
                { alias: "review", origin: "workspace", state: "disabled", definition: { name: "review", source: "https://git.example/acme/kit.git", ref: "v2", commit: "0123456789abcdef0123456789abcdef01234567" } },
                { alias: "bad", origin: "service", state: "unavailable", definition: { name: "bad", source: "/srv/bad" }, problem: { detail: "requires YAML frontmatter" } },
                { alias: "plurnk", origin: "service", state: "active", definition: { name: "plurnk" }, detail: { description: "Plurnk reference" } },
            ],
        },
    });
    await handleSkills([], h.rpc, h.write);
    assert.deepEqual(h.calls, [{ method: "workspace.skills.list", params: {} }]);
    const text = h.out.join("");
    assert.match(text, /grep\s+active\s+\/srv\/grep\s+Find text/);
    assert.match(text, /review\s+disabled\s+https:\/\/git\.example\/acme\/kit\.git#v2 @0123456789ab\s+\(workspace\)/);
    assert.match(text, /bad\s+unavailable\s+\/srv\/bad\s+— requires YAML frontmatter/);
    assert.match(text, /plurnk\s+active\s+Plurnk reference/);
    assert.doesNotMatch(text, /unknown|global|project/u, "there is no invented installation scope column");
    const empty = harness({ "workspace.skills.list": { definitions: [] } });
    await handleSkills("", empty.rpc, empty.write);
    assert.match(empty.out.join(""), /Agent Skills: none/);
});

test("[§cli-universal-agent-skills] discover sends exactly one source and renders inert candidates", async () => {
    const source = "https://git.example/acme/kit.git";
    const h = harness({
        "workspace.skills.discover": {
            candidates: [{ alias: "changelog", summary: "Write a changelog", definition: { name: "changelog", source }, provenance: { kind: "source", source } }],
        },
    });
    await handleSkills(`discover ${source}`, h.rpc, h.write);
    await handleSkills("discover ./vendor/skills", h.rpc, h.write);
    await handleSkills("discover '~/my skills/kit.zip'", h.rpc, h.write);
    assert.deepEqual(h.calls, [
        { method: "workspace.skills.discover", params: { source } },
        { method: "workspace.skills.discover", params: { source: "./vendor/skills" } },
        { method: "workspace.skills.discover", params: { source: "~/my skills/kit.zip" } },
    ]);
    assert.match(h.out.join(""), /changelog\s+candidate\s+https:\/\/git\.example\/acme\/kit\.git\s+Write a changelog\n/);
});

test("[§cli-universal-agent-skills] add composes one exact SkillDefinition; enable, disable, and remove map to workspace actions", async () => {
    const h = harness({
        "workspace.skills.add": { status: 201, alias: "changelog", definition: { alias: "changelog", state: "active" } },
        "workspace.skills.enable": { status: 200, alias: "changelog", definition: { alias: "changelog", state: "active" } },
        "workspace.skills.disable": { status: 200, alias: "changelog", definition: { alias: "changelog", state: "disabled" } },
        "workspace.skills.remove": { status: 200, alias: "changelog", removed: true },
    });
    await handleSkills("add changelog ./vendor/kit", h.rpc, h.write);
    await handleSkills("add changelog https://git.example/acme/kit.git --ref v2", h.rpc, h.write);
    await handleSkills("add 分析 ./vendor/分析", h.rpc, h.write);
    await handleSkills("add 3d-tools ./vendor/3d-tools", h.rpc, h.write);
    await handleSkills("enable changelog", h.rpc, h.write);
    await handleSkills("disable changelog", h.rpc, h.write);
    await handleSkills("remove changelog", h.rpc, h.write);
    assert.deepEqual(h.calls, [
        { method: "workspace.skills.add", params: { alias: "changelog", definition: { name: "changelog", source: "./vendor/kit" } } },
        { method: "workspace.skills.add", params: { alias: "changelog", definition: { name: "changelog", source: "https://git.example/acme/kit.git", ref: "v2" } } },
        { method: "workspace.skills.add", params: { alias: "分析", definition: { name: "分析", source: "./vendor/分析" } } },
        { method: "workspace.skills.add", params: { alias: "3d-tools", definition: { name: "3d-tools", source: "./vendor/3d-tools" } } },
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
    await handleSkills("add ghost ./vendor/kit", h.rpc, h.write);
    assert.match(h.out.join(""), /added: ghost \(unavailable\)\s+— could not be installed/);
});

test("[§cli-universal-agent-skills] malformed client command shapes never dispatch", async () => {
    for (const command of ["add", "add one", "add one two three", "add one two --global", "add one two --plurnk", "add one two --global --plurnk", "add one two --ref", "add one two --ref a --ref b", "discover", "discover react changelog", "enable", "disable a b", "remove", "add echo 'unterminated", "update", "list --global"]) {
        const h = harness();
        await handleSkills(command, h.rpc, h.write);
        assert.equal(h.calls.length, 0, command);
        assert.match(h.out.join(""), /usage:/, command);
    }
});
