// Unit tests for src/dispatcher.ts helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveProjectRoot, resolveLoopPolicy, buildSettings, buildVersionNotice, collectMcpConfiguration, resolveWorkerId, loadEnvCascade, orderedEnvFiles } from "./dispatcher.ts";

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

test("buildSettings carries the canonical workspace capability policy", async () => {
    assert.deepEqual(
        await buildSettings({}, {
            PLURNK_CLIENT_CAPABILITIES: '{"deny":[{"runtime":"sh"}]}',
        }),
        { capabilities: { deny: [{ runtime: "sh" }] } },
    );
});

test("[§cli-env-defaults] a workspace-open flag is its knob's spelling: the knob states it, and the flag wins", async () => {
    const env = { PLURNK_CLIENT_FILES_ITEMS: "0", PLURNK_CLIENT_MAX_COMMANDS: "5", PLURNK_CLIENT_NO_GIT: "1" };
    assert.deepEqual(await buildSettings({}, env), { filesItems: 0, maxCommands: 5, git: false });
    assert.deepEqual(await buildSettings({ "files-items": "3", "max-commands": "2" }, env), { filesItems: 3, maxCommands: 2, git: false });
    assert.deepEqual(await buildSettings({}, { PLURNK_CLIENT_NO_GIT: "0" }), {}, "an explicit off is off");
    assert.deepEqual(await buildSettings({}, { PLURNK_CLIENT_FILES_ITEMS: "" }), {}, "an empty optional knob means nobody said");
    await assert.rejects(buildSettings({}, { PLURNK_CLIENT_NO_GIT: "maybe" }), (error: unknown) => {
        const problem = (error as { problem: { flag: string; detail: string } }).problem;
        assert.equal(problem.flag, "PLURNK_CLIENT_NO_GIT");
        assert.match(problem.detail, /must be one of 1, true, yes, on, 0, false, no, off/u);
        return true;
    });
});

test("buildSettings carries the selected frontend identity into workspace creation", async () => {
    assert.deepEqual(
        await buildSettings({}, {}, "@plurnk/plurnk-tui/1.2.3"),
        { client: "@plurnk/plurnk-tui/1.2.3" },
    );
});

test("buildSettings does not reinterpret service executor configuration as workspace policy", async () => {
    assert.deepEqual(await buildSettings({}, {
        PLURNK_EXECS_ONLY: "atlas",
        PLURNK_EXECS_SH: "0",
    }), {});
});

test("resolveLoopPolicy: a user with nothing to say states nothing", () => {
    assert.deepEqual(resolveLoopPolicy(undefined), {});
});

// {§loop-attendance} — `--auto` is one statement: nobody is watching. What an unattended loop does
// with a proposal is the daemon's panel's to say, unless the user states that too.
test("[§cli-invocation] resolveLoopPolicy: --auto declares an unattended run and --proposals a disposition", () => {
    assert.deepEqual(resolveLoopPolicy("reject"), { proposals: "reject" });
    assert.deepEqual(resolveLoopPolicy(undefined, true), { attended: false });
    assert.deepEqual(resolveLoopPolicy("reject", true), { proposals: "reject", attended: false });
});

test("resolveLoopPolicy: a disposition outside the vocabulary is a flag Problem naming the flag", () => {
    assert.throws(() => resolveLoopPolicy("sometimes"), (error: unknown) => {
        const problem = (error as { problem: { flag: string; detail: string } }).problem;
        assert.equal(problem.flag, "--proposals");
        assert.match(problem.detail, /proposals must be one of review, accept, reject/);
        return true;
    });
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


// ─── buildSettings (workspace-open settings, svc#231) ──────────────────

test("[§cli-workspace-open-settings] buildSettings: files-items -1/0/N parse", async () => {
    assert.deepEqual(await buildSettings({ "files-items": "-1" }), { filesItems: -1 });
    assert.deepEqual(await buildSettings({ "files-items": "0" }), { filesItems: 0 });
    assert.deepEqual(await buildSettings({ "files-items": "5" }), { filesItems: 5 });
});

test("buildSettings: files-items rejects < -1 and non-integer", async () => {
    await assert.rejects(buildSettings({ "files-items": "-2" }), /-1 \(full\)/);
    await assert.rejects(buildSettings({ "files-items": "x" }), /must be/);
});




test("buildSettings: empty → {}", async () => {
    assert.deepEqual(await buildSettings({}), {});
});

// ─── buildSettings ceilings (svc#232) ────────────────────────────────

test("buildSettings: --max-commands (positive int) + --no-git → ceilings", async () => {
    assert.deepEqual(await buildSettings({ "max-commands": "10", "no-git": true }), { maxCommands: 10, git: false });
});

test("buildSettings: --max-commands rejects non-positive / non-integer", async () => {
    await assert.rejects(buildSettings({ "max-commands": "0" }), /positive integer/);
    await assert.rejects(buildSettings({ "max-commands": "x" }), /positive integer/);
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
            && (error as { problem: { type?: unknown } }).problem.type === "https://problems.plurnk.xyz/client/worker/not-found",
    );
});
