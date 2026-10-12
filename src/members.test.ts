import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMembers } from "./members.ts";

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

test("[§cli-file-members] list renders every definition by its glob with what it resolved to", async () => {
    const h = harness({
        "workspace.members.list": {
            definitions: [
                { alias: "docs/**", origin: "service", state: "active", definition: { glob: "docs/**", provenance: { kind: "service-configuration" } }, provenance: { kind: "environment", source: "PLURNK_MEMBERS_docs" }, detail: { effect: "include", pattern: "docs/**", matched: 12, files: ["docs/a.md"], ignored: 3 } },
                { alias: "!**/tokenizer.json", origin: "workspace", state: "active", definition: { glob: "!**/tokenizer.json" }, detail: { effect: "exclude", pattern: "**/tokenizer.json", matched: 4, files: ["a/tokenizer.json"], ignored: 0 } },
                { alias: "note.md", origin: "workspace", state: "active", definition: { glob: "note.md" }, detail: { effect: "include", pattern: "note.md", matched: 1, files: ["note.md"], ignored: 0 } },
                { alias: "drafts/*.md", origin: "workspace", state: "disabled", definition: { glob: "drafts/*.md" } },
                { alias: "../x/**", origin: "workspace", state: "unavailable", definition: { glob: "../x/**" }, problem: { detail: "outside the project root" } },
            ],
        },
    });
    await handleMembers([], h.rpc, h.write);
    assert.deepEqual(h.calls, [{ method: "workspace.members.list", params: {} }]);
    const text = h.out.join("");
    assert.match(text, /docs\/\*\*\s+service\s+active → 12 files \(3 ignored\)[^\n]*PLURNK_MEMBERS_docs/);
    assert.match(text, /!\*\*\/tokenizer\.json\s+workspace\s+active → 4 members\n/);
    assert.match(text, /note\.md\s+workspace\s+active → 1 file\n/);
    assert.match(text, /drafts\/\*\.md\s+workspace\s+disabled\n/);
    assert.match(text, /\.\.\/x\/\*\*\s+workspace\s+unavailable\s+— outside the project root/);

    const explicit = harness({ "workspace.members.list": { definitions: [] } });
    await handleMembers("", explicit.rpc, explicit.write);
    await handleMembers("", explicit.rpc, explicit.write);
    assert.deepEqual(explicit.calls, [{ method: "workspace.members.list", params: {} }, { method: "workspace.members.list", params: {} }]);
    assert.match(explicit.out.join(""), /file members: none/);
});

test("[§cli-file-members] discover sends the path or glob verbatim and renders the daemon's verdict", async () => {
    const h = harness({
        "workspace.members.discover": {
            candidates: [{ alias: "README.md", definition: { glob: "README.md" }, provenance: { kind: "member", source: "README.md" }, summary: "member — tracked by git" }],
        },
    });
    await handleMembers("discover README.md", h.rpc, h.write);
    await handleMembers("discover docs/**", h.rpc, h.write);
    await handleMembers("discover !**/tokenizer.json", h.rpc, h.write);
    assert.deepEqual(h.calls, [
        { method: "workspace.members.discover", params: { query: "README.md" } },
        { method: "workspace.members.discover", params: { query: "docs/**" } },
        { method: "workspace.members.discover", params: { query: "!**/tokenizer.json" } },
    ]);
    assert.match(h.out.join(""), /README\.md\s+member\s+member — tracked by git/);

    const preview = harness({
        "workspace.members.discover": {
            candidates: [{ alias: "docs/**", definition: { glob: "docs/**" }, provenance: { kind: "preview", source: "docs/**" }, summary: "would include 2 files (1 already members, 0 ignored): docs/a.md, docs/b.md" }],
        },
    });
    await handleMembers("discover docs/**", preview.rpc, preview.write);
    assert.match(preview.out.join(""), /docs\/\*\*\s+preview\s+would include 2 files/);
});

test("[§cli-file-members] add sends every glob as one definition and renders each admitted; enable, disable, and remove name one glob", async () => {
    const h = harness({
        "workspace.members.add": { status: 201, family: "members", definitions: [
            { alias: "docs/**", origin: "workspace", state: "active", definition: { glob: "docs/**" } },
            { alias: "!**/tokenizer.json", origin: "workspace", state: "active", definition: { glob: "!**/tokenizer.json" } },
        ] },
        "workspace.members.enable": { status: 200, alias: "docs/**", definition: { alias: "docs/**", state: "active" } },
        "workspace.members.disable": { status: 200, alias: "docs/**", definition: { alias: "docs/**", state: "disabled" } },
        "workspace.members.remove": { status: 200, alias: "docs/**", removed: true },
    });
    await handleMembers("add docs/** !**/tokenizer.json", h.rpc, h.write);
    await handleMembers(["add", "docs with spaces/**"], h.rpc, h.write);
    await handleMembers("add 'docs with spaces/**'", h.rpc, h.write);
    await handleMembers("enable docs/**", h.rpc, h.write);
    await handleMembers("disable docs/**", h.rpc, h.write);
    await handleMembers("remove docs/**", h.rpc, h.write);
    assert.deepEqual(h.calls, [
        { method: "workspace.members.add", params: { files: ["docs/**", "!**/tokenizer.json"] } },
        { method: "workspace.members.add", params: { files: ["docs with spaces/**"] } },
        { method: "workspace.members.add", params: { files: ["docs with spaces/**"] } },
        { method: "workspace.members.enable", params: { file: "docs/**" } },
        { method: "workspace.members.disable", params: { file: "docs/**" } },
        { method: "workspace.members.remove", params: { file: "docs/**" } },
    ]);
    const text = h.out.join("");
    assert.match(text, /added: docs\/\*\* \(active\)\n\s+added: !\*\*\/tokenizer\.json \(active\)/);
    assert.match(text, /enabled: docs\/\*\* \(active\)/);
    assert.match(text, /disabled: docs\/\*\* \(disabled\)/);
    assert.match(text, /removed: docs\/\*\*/);
});

test("[§cli-file-members] an unavailable outcome renders the daemon's Problem beside the state", async () => {
    const h = harness({
        "workspace.members.add": { status: 201, family: "members", definitions: [{ alias: "docs/**", origin: "workspace", state: "unavailable", definition: { glob: "docs/**" }, problem: { detail: "the workspace has no project root" } }] },
    });
    await handleMembers("add docs/**", h.rpc, h.write);
    assert.match(h.out.join(""), /added: docs\/\*\* \(unavailable\)\s+— the workspace has no project root/);
});

test("[§cli-file-members] malformed client command shapes never dispatch", async () => {
    for (const command of ["add", "add ''", "discover", "enable", "enable a b", "disable a b", "remove", "replace docs/** docs/*", "update", "list extra"]) {
        const h = harness();
        await handleMembers(command, h.rpc, h.write);
        assert.equal(h.calls.length, 0, command);
        assert.match(h.out.join(""), /usage:/, command);
    }
});
