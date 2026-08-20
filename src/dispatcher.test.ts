// Unit tests for src/dispatcher.ts helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveProjectRoot, resolveLoopFlags, buildConstraints, buildSettings, buildVersionNotice, resolveModelSpec, collectExecsPolicy, collectMcpConfiguration, resolveWorkerId, loadEnvCascade, orderedEnvFiles } from "./dispatcher.ts";

test("[§cli-invocation] env cascade uses XDG user configuration and last repeated flag wins", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-env-cascade-"));
    const first = join(root, "first.env");
    const last = join(root, "last.env");
    const user = join(root, "user.env");
    const key = "PLURNK_TEST_CLIENT_CASCADE_298";
    const original = process.env[key];
    t.after(async () => {
        if (original === undefined) delete process.env[key];
        else process.env[key] = original;
        await rm(root, { recursive: true, force: true });
    });
    await writeFile(first, `${key}=first\n`);
    await writeFile(last, `${key}=last\n`);
    await writeFile(user, `${key}=user\n`);

    delete process.env[key];
    const selected = orderedEnvFiles([
        "--env-file", first,
        `--env-file-if-exists=${last}`,
    ]);
    assert.deepEqual(selected, [
        { path: first, required: true },
        { path: last, required: false },
    ]);
    loadEnvCascade(selected, user);
    assert.equal(process.env[key], "last");

    delete process.env[key];
    loadEnvCascade([], user);
    assert.equal(process.env[key], "user");

    process.env[key] = "shell";
    loadEnvCascade([
        { path: first, required: true },
        { path: last, required: true },
    ], user);
    assert.equal(process.env[key], "shell");
});

// ─── resolveModelSpec (#90 client-side alias resolution) ─────────────

test("[§cli-model-selection] resolveModelSpec: named alias → concrete provider/model from env", () => {
    assert.equal(resolveModelSpec("ccp", { PLURNK_MODEL_ccp: "anthropic/claude-x" }), "anthropic/claude-x");
});

test("resolveModelSpec: alias is case-folded", () => {
    assert.equal(resolveModelSpec("CCP", { PLURNK_MODEL_ccp: "openai/gpt-5" }), "openai/gpt-5");
});

test("resolveModelSpec: model id containing '/' round-trips (first-slash split is lossless)", () => {
    assert.equal(resolveModelSpec("or", { PLURNK_MODEL_or: "openrouter/anthropic/claude-sonnet-latest" }), "openrouter/anthropic/claude-sonnet-latest");
});

test("resolveModelSpec: undefined alias → undefined (no --model / PLURNK_MODEL)", () => {
    assert.equal(resolveModelSpec(undefined, { PLURNK_MODEL_ccp: "anthropic/claude-x" }), undefined);
});

test("resolveModelSpec: alias absent from env → undefined (fall back to bare {alias})", () => {
    assert.equal(resolveModelSpec("nope", { PLURNK_MODEL_ccp: "anthropic/claude-x" }), undefined);
});

// ─── collectExecsPolicy (#132 per-workspace exec-policy layer) ─────────

test("collectExecsPolicy: forwards the enable/disable grammar", () => {
    assert.deepEqual(
        collectExecsPolicy({ PLURNK_EXECS_ONLY: "search", PLURNK_EXECS_NODE: "0", PLURNK_EXECS_MCP: "0" }),
        { PLURNK_EXECS_ONLY: "search", PLURNK_EXECS_NODE: "0", PLURNK_EXECS_MCP: "0" },
    );
});

test("collectExecsPolicy: forwards only the runtime-policy key grammar", () => {
    const out = collectExecsPolicy({
        PLURNK_EXECS_ONLY: "search",
        plurnk_execs_node: "0",
        PLURNK_EXECS_SEARCH_ENGINES: "brave",
        PLURNK_EXECS_ERROR_DETAIL_LIMIT: "1024",
        PLURNK_EXECS_MCP_NOTION: "https://notion.example/mcp",
        PLURNK_EXECS_MCP_NOTION_HEADERS: '{"Authorization":"Bearer sk-secret"}',
        PLURNK_EXECS_MCP_INSTALL: "0",
    });
    assert.deepEqual(out, { PLURNK_EXECS_ONLY: "search", plurnk_execs_node: "0" });
    assert.ok(!JSON.stringify(out).includes("secret"), "no bearer token leaks onto the wire");
});

test("collectExecsPolicy: ignores unrelated env; nothing set → empty map", () => {
    assert.deepEqual(collectExecsPolicy({ PLURNK_WS: "ws://x", PATH: "/usr/bin" }), {});
});

test("collectMcpConfiguration carries raw declarations and excludes service controls", () => {
    assert.deepEqual(collectMcpConfiguration({
        PLURNK_MCP_GITEA: "gitea-mcp",
        PLURNK_MCP_GITEA_ARGS: '["plurnk_pk"]',
        PLURNK_MCP_gitea_tools: '["issue_read"]',
        PLURNK_MCP_ENABLED: '["gitea"]',
        PLURNK_MCP_connect_timeout: "1",
        PLURNK_MCP_REQUEST_TIMEOUT: "2",
        GITEA_TOKEN: "secret",
    }), {
        PLURNK_MCP_GITEA: "gitea-mcp",
        PLURNK_MCP_GITEA_ARGS: '["plurnk_pk"]',
        PLURNK_MCP_gitea_tools: '["issue_read"]',
    });
    assert.deepEqual(collectMcpConfiguration({ PATH: "/usr/bin" }), {});
});

test("buildSettings carries the client executor policy into workspace creation", async () => {
    assert.deepEqual(
        await buildSettings({}, "/", {
            PLURNK_EXECS_ONLY: "atlas",
            PLURNK_EXECS_SH: "0",
            PLURNK_MCP_ATLAS: "node",
        }),
        { execs: { PLURNK_EXECS_ONLY: "atlas", PLURNK_EXECS_SH: "0" } },
    );
});

// ─── resolveLoopFlags ────────────────────────────────────────────────
// Mode is NOT a flag: ask/act ride the prompt prefix (`? `/`: `), the
// habit converged across nvim, TUI, and the one-shot CLI.

test("resolveLoopFlags: undefined → undefined", () => {
    assert.equal(resolveLoopFlags(undefined), undefined);
});

test("[§cli-invocation] resolveLoopFlags: JSON passes through verbatim", () => {
    assert.deepEqual(resolveLoopFlags('{"auto":true,"noWeb":true}'), { auto: true, noWeb: true });
});

test("[§cli-invocation] resolveLoopFlags: --auto is canonical sugar and wins the raw bag", () => {
    assert.deepEqual(resolveLoopFlags(undefined, true), { auto: true });
    assert.deepEqual(resolveLoopFlags('{"auto":false,"noWeb":true}', true), { auto: true, noWeb: true });
});

test("resolveLoopFlags: malformed JSON throws", () => {
    assert.throws(() => resolveLoopFlags("{nope"), /valid JSON/);
});

test("resolveLoopFlags: non-object JSON throws", () => {
    assert.throws(() => resolveLoopFlags('["auto"]'), /JSON object/);
});

// ─── resolveProjectRoot ──────────────────────────────────────────────

test("resolveProjectRoot: undefined → process.cwd()", () => {
    assert.equal(resolveProjectRoot(undefined), process.cwd());
});

test("resolveProjectRoot: empty string → null (explicit headless)", () => {
    assert.equal(resolveProjectRoot(""), null);
});

test("[§cli-project-root] resolveProjectRoot: absolute path → unchanged", () => {
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

test("[§cli-membership-overlay-and-workspace-open-settings] buildConstraints: maps --pick/--hide/--view to service effects in order", () => {
    const c = buildConstraints({ pick: ["docs/**"], hide: ["*.lock"], view: ["vendor/**", "gen/**"] });
    assert.deepEqual(c, [
        { effect: "pick", glob: "docs/**" },
        { effect: "hide", glob: "*.lock" },
        { effect: "view", glob: "vendor/**" },
        { effect: "view", glob: "gen/**" },
    ]);
});

test("buildConstraints: no flags → empty (no constraints param on workspace.create)", () => {
    assert.deepEqual(buildConstraints({}), []);
});

// ─── buildSettings (workspace-open settings, svc#231) ──────────────────

test("buildSettings: files-items -1/0/N parse", async () => {
    assert.deepEqual(await buildSettings({ "files-items": "-1" }, "/"), { filesItems: -1 });
    assert.deepEqual(await buildSettings({ "files-items": "0" }, "/"), { filesItems: 0 });
    assert.deepEqual(await buildSettings({ "files-items": "5" }, "/"), { filesItems: 5 });
});

test("buildSettings: files-items rejects < -1 and non-integer", async () => {
    await assert.rejects(buildSettings({ "files-items": "-2" }, "/"), /-1 \(full\)/);
    await assert.rejects(buildSettings({ "files-items": "x" }, "/"), /must be/);
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

// ─── resolveWorkerId: a run is addressable by NAME within its workspace's world ───
// Plurnk's machine model (service SPEC §machine-processes): a workspace holds many
// workers (conversations over one world); --worker selects one by name. Fail-hard: an
// unknown name is a contract violation, never a fabricated model-run fallback.

test("resolveWorkerId: undefined name → undefined, and NEVER queries workspace.workers (the model-run default)", async () => {
    let called = 0;
    const rpc = { call: async () => { called++; return { workers: [] }; } };
    const id = await resolveWorkerId(rpc, undefined);
    assert.equal(id, undefined);
    assert.equal(called, 0, "no --worker → no workspace.workers round-trip");
});

test("[§cli-workspaces-and-workers] resolveWorkerId: a named run resolves to its id via workspace.workers", async () => {
    const rpc = { call: async (m: string) => { assert.equal(m, "workspace.workers"); return { workers: [{ id: 10, name: "client-1" }, { id: 42, name: "spike" }] }; } };
    assert.equal(await resolveWorkerId(rpc, "spike"), 42);
});

test("[§cli-workspaces-and-workers] resolveWorkerId: an unknown run name THROWS — no silent fallback to the model run", async () => {
    const rpc = { call: async () => ({ workers: [{ id: 10, name: "client-1" }] }) };
    await assert.rejects(
        () => resolveWorkerId(rpc, "ghost"),
        (error: unknown) => error instanceof Error
            && "problem" in error
            && (error as { problem: { type?: unknown } }).problem.type === "https://problems.plurnk.dev/client/worker/not-found",
    );
});
