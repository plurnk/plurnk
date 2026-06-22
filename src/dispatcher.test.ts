// Unit tests for src/dispatcher.ts helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveProjectRoot, resolveLoopFlags, buildConstraints, buildSettings, buildVersionNotice } from "./dispatcher.ts";

// ─── resolveLoopFlags ────────────────────────────────────────────────
// Mode is NOT a flag: ask/act ride the prompt prefix (`? `/`: `), the
// habit converged across nvim, TUI, and the one-shot CLI.

test("resolveLoopFlags: undefined → undefined", () => {
    assert.equal(resolveLoopFlags(undefined), undefined);
});

test("resolveLoopFlags: JSON passes through verbatim", () => {
    assert.deepEqual(resolveLoopFlags('{"yolo":true,"noWeb":true}'), { yolo: true, noWeb: true });
});

test("resolveLoopFlags: malformed JSON throws", () => {
    assert.throws(() => resolveLoopFlags("{nope"), /valid JSON/);
});

test("resolveLoopFlags: non-object JSON throws", () => {
    assert.throws(() => resolveLoopFlags('["yolo"]'), /JSON object/);
});

// ─── resolveProjectRoot ──────────────────────────────────────────────

test("resolveProjectRoot: undefined → process.cwd()", () => {
    assert.equal(resolveProjectRoot(undefined), process.cwd());
});

test("resolveProjectRoot: empty string → null (explicit headless)", () => {
    assert.equal(resolveProjectRoot(""), null);
});

test("resolveProjectRoot: absolute path → unchanged", () => {
    assert.equal(resolveProjectRoot("/tmp/work"), "/tmp/work");
});

test("resolveProjectRoot: relative path → throws", () => {
    assert.throws(
        () => resolveProjectRoot("./relative"),
        /must be an absolute path/,
    );
});

test("resolveProjectRoot: bare name → throws", () => {
    assert.throws(
        () => resolveProjectRoot("project"),
        /must be an absolute path/,
    );
});


// ─── buildConstraints (membership overlay, svc#200) ──────────────────

test("buildConstraints: maps --pick/--hide/--view/--repo to service effects in order", () => {
    const c = buildConstraints({ pick: ["docs/**"], hide: ["*.lock"], view: ["vendor/**", "gen/**"], repo: ["packages/api"] });
    assert.deepEqual(c, [
        { effect: "pick", glob: "docs/**" },
        { effect: "hide", glob: "*.lock" },
        { effect: "view", glob: "vendor/**" },
        { effect: "view", glob: "gen/**" },
        { effect: "repo", glob: "packages/api" },
    ]);
});

test("buildConstraints: no flags → empty (no constraints param on session.create)", () => {
    assert.deepEqual(buildConstraints({}), []);
});

// ─── buildSettings (session-open settings, svc#231) ──────────────────

test("buildSettings: manifest-items -1/0/N parse", async () => {
    assert.deepEqual(await buildSettings({ "manifest-items": "-1" }, "/"), { manifestItems: -1 });
    assert.deepEqual(await buildSettings({ "manifest-items": "0" }, "/"), { manifestItems: 0 });
    assert.deepEqual(await buildSettings({ "manifest-items": "5" }, "/"), { manifestItems: 5 });
});

test("buildSettings: manifest-items rejects < -1 and non-integer", async () => {
    await assert.rejects(buildSettings({ "manifest-items": "-2" }, "/"), /-1 \(full\)/);
    await assert.rejects(buildSettings({ "manifest-items": "x" }, "/"), /must be/);
});

test("buildSettings: --md NAME=path reads local file → {alias, content}", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-md-"));
    try {
        await writeFile(join(dir, "policy.md"), "# Policy\nBe terse.", "utf8");
        const s = await buildSettings({ md: [`POLICY=${join(dir, "policy.md")}`] }, "/");
        assert.deepEqual(s.mdDocs, [{ alias: "POLICY", content: "# Policy\nBe terse." }]);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("buildSettings: --md without '=' → throws NAME=path", async () => {
    await assert.rejects(buildSettings({ md: ["nopath"] }, "/"), /NAME=path/);
});

test("buildSettings: --md missing file → throws not readable", async () => {
    await assert.rejects(buildSettings({ md: ["X=/no/such/file.md"] }, "/"), /not readable/);
});

test("buildSettings: --no-agents-md → autoReadAgents false (svc#268 override passthrough)", async () => {
    assert.equal((await buildSettings({ "no-agents-md": true }, "/")).autoReadAgents, false);
});

test("buildSettings: no --no-agents-md → autoReadAgents unset (env default wins)", async () => {
    assert.equal((await buildSettings({}, "/")).autoReadAgents, undefined);
});

test("buildSettings: empty → {}", async () => {
    assert.deepEqual(await buildSettings({}, "/"), {});
});

// ─── buildSettings ceilings (svc#232) ────────────────────────────────

test("buildSettings: --max-commands (positive int) + --no-git → ceilings", async () => {
    assert.deepEqual(await buildSettings({ "max-commands": "10", "no-git": true }, "/"), { maxCommands: 10, git: false });
});

test("buildSettings: --max-commands rejects non-positive / non-integer", async () => {
    await assert.rejects(buildSettings({ "max-commands": "0" }, "/"), /positive integer/);
    await assert.rejects(buildSettings({ "max-commands": "x" }, "/"), /positive integer/);
});

// ─── buildVersionNotice (svc#235) ────────────────────────────────────

test("buildVersionNotice: both versions, client behind → update available", () => {
    const n = buildVersionNotice({ service: { installed: "0.33.0", latest: "0.34.0" }, client: { latest: "0.22.0" } }, "0.21.3");
    assert.match(n!, /plurnk client v0\.21\.3, plurnk-service v0\.33\.0 \(update available\)/);
});

test("buildVersionNotice: up to date → no marker", () => {
    const n = buildVersionNotice({ service: { installed: "0.34.0", latest: "0.34.0" }, client: { latest: "0.22.0" } }, "0.22.0");
    assert.match(n!, /plurnk-service v0\.34\.0$/);
    assert.doesNotMatch(n!, /update available/);
});

test("buildVersionNotice: no versions → undefined", () => {
    assert.equal(buildVersionNotice(undefined, "0.22.0"), undefined);
});

test("buildVersionNotice: service absent → client line only", () => {
    const n = buildVersionNotice({ client: { latest: "0.22.0" } }, "0.21.3");
    assert.match(n!, /^plurnk client v0\.21\.3 \(update available\)$/);
});
