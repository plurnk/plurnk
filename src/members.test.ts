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

test("[§cli-file-members] list renders every definition with what its glob resolved to", async () => {
    const h = harness({
        "worker.members.list": {
            definitions: [
                { alias: "docs", origin: "service", state: "active", definition: { glob: "docs/**", provenance: { kind: "service-configuration", source: "PLURNK_MEMBERS_DOCS" } }, detail: { effect: "include", pattern: "docs/**", matched: 12, files: ["docs/a.md"], ignored: 3 } },
                { alias: "no-tokenizer", origin: "worker", state: "active", definition: { glob: "!**/tokenizer.json" }, detail: { effect: "exclude", pattern: "**/tokenizer.json", matched: 4, files: ["a/tokenizer.json"], ignored: 0 } },
                { alias: "note", origin: "worker", state: "active", definition: { glob: "note.md" }, detail: { effect: "include", pattern: "note.md", matched: 1, files: ["note.md"], ignored: 0 } },
                { alias: "drafts", origin: "worker", state: "disabled", definition: { glob: "drafts/*.md" } },
                { alias: "bad", origin: "worker", state: "unavailable", definition: { glob: "../x/**" }, problem: { detail: "outside the project root" } },
            ],
        },
    });
    await handleMembers([], h.rpc, h.write);
    assert.deepEqual(h.calls, [{ method: "worker.members.list", params: {} }]);
    const text = h.out.join("");
    assert.match(text, /docs\s+service\s+active\s+include docs\/\*\* → 12 files \(3 ignored\)\n/);
    assert.match(text, /no-tokenizer\s+worker\s+active\s+exclude \*\*\/tokenizer\.json → 4 members\n/);
    assert.match(text, /note\s+worker\s+active\s+include note\.md → 1 file\n/);
    assert.match(text, /drafts\s+worker\s+disabled\s+include drafts\/\*\.md\n/);
    assert.match(text, /bad\s+worker\s+unavailable\s+include \.\.\/x\/\*\*\s+— outside the project root/);

    const explicit = harness({ "worker.members.list": { definitions: [] } });
    await handleMembers("", explicit.rpc, explicit.write);
    await handleMembers("", explicit.rpc, explicit.write);
    assert.deepEqual(explicit.calls, [{ method: "worker.members.list", params: {} }, { method: "worker.members.list", params: {} }]);
    assert.match(explicit.out.join(""), /file members: none/);
});

test("[§cli-file-members] discover sends the path or glob verbatim and renders the daemon's verdict", async () => {
    const h = harness({
        "worker.members.discover": {
            candidates: [{ alias: "readme-md", definition: { glob: "README.md" }, provenance: { kind: "member", source: "README.md" }, summary: "member — tracked by git" }],
        },
    });
    await handleMembers("discover README.md", h.rpc, h.write);
    await handleMembers("discover docs/**", h.rpc, h.write);
    await handleMembers("discover !**/tokenizer.json", h.rpc, h.write);
    assert.deepEqual(h.calls, [
        { method: "worker.members.discover", params: { query: "README.md" } },
        { method: "worker.members.discover", params: { query: "docs/**" } },
        { method: "worker.members.discover", params: { query: "!**/tokenizer.json" } },
    ]);
    assert.match(h.out.join(""), /readme-md\s+member\s+README\.md\s+member — tracked by git/);

    const preview = harness({
        "worker.members.discover": {
            candidates: [{ alias: "docs", definition: { glob: "docs/**" }, provenance: { kind: "preview", source: "docs/**" }, summary: "would include 2 files (1 already members, 0 ignored): docs/a.md, docs/b.md" }],
        },
    });
    await handleMembers("discover docs/**", preview.rpc, preview.write);
    assert.match(preview.out.join(""), /docs\s+preview\s+docs\/\*\*\s+would include 2 files/);
});

test("[§cli-file-members] add composes one exact { glob } definition; enable, disable, and remove map to Worker actions", async () => {
    const h = harness({
        "worker.members.add": { status: 201, alias: "docs", definition: { alias: "docs", state: "active" } },
        "worker.members.enable": { status: 200, alias: "docs", definition: { alias: "docs", state: "active" } },
        "worker.members.disable": { status: 200, alias: "docs", definition: { alias: "docs", state: "disabled" } },
        "worker.members.remove": { status: 200, alias: "docs", removed: true },
    });
    await handleMembers("add docs docs/**", h.rpc, h.write);
    await handleMembers("add no-tokenizer !**/tokenizer.json", h.rpc, h.write);
    await handleMembers("enable docs", h.rpc, h.write);
    await handleMembers("disable docs", h.rpc, h.write);
    await handleMembers("remove docs", h.rpc, h.write);
    assert.deepEqual(h.calls, [
        { method: "worker.members.add", params: { alias: "docs", definition: { glob: "docs/**" } } },
        { method: "worker.members.add", params: { alias: "no-tokenizer", definition: { glob: "!**/tokenizer.json" } } },
        { method: "worker.members.enable", params: { alias: "docs" } },
        { method: "worker.members.disable", params: { alias: "docs" } },
        { method: "worker.members.remove", params: { alias: "docs" } },
    ]);
    const text = h.out.join("");
    assert.match(text, /added: docs \(active\)/);
    assert.match(text, /enabled: docs \(active\)/);
    assert.match(text, /disabled: docs \(disabled\)/);
    assert.match(text, /removed: docs/);
});

test("[§cli-file-members] an unavailable outcome renders the daemon's Problem beside the state", async () => {
    const h = harness({
        "worker.members.add": { status: 201, alias: "ghost", definition: { alias: "ghost", state: "unavailable", problem: { detail: "the workspace has no project root" } } },
    });
    await handleMembers("add ghost docs/**", h.rpc, h.write);
    assert.match(h.out.join(""), /added: ghost \(unavailable\)\s+— the workspace has no project root/);
});

test("[§cli-file-members] malformed client command shapes never dispatch", async () => {
    for (const command of ["add", "add one", "discover", "enable", "disable a b", "remove", "update", "list extra"]) {
        const h = harness();
        await handleMembers(command, h.rpc, h.write);
        assert.equal(h.calls.length, 0, command);
        assert.match(h.out.join(""), /usage:/, command);
    }
});
