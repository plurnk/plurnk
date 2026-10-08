import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { actionViaAgui } from "../../src/agui.ts";
import { AguiTransport } from "../../src/transport.ts";
import { bootDaemon, locateDaemon } from "./harness.ts";
import { startDemoAgent } from "../../../plurnk-service/plurnk-a2a/test/fixtures/DemoAgent.ts";

test("{§cli-agui-conformance}: separate client connections observe every exposed durable control", { timeout: 120_000 }, async (t) => {
    const service = await locateDaemon();
    if (service === null) { t.skip("no plurnk-service binary reachable"); return; }
    const agent = await startDemoAgent();
    t.after(() => agent.close());
    const fixture = resolve(import.meta.dirname, "../../../plurnk-service/plurnk-mcp/src/fixtures/echo-server.mjs");
    const daemon = await bootDaemon(service, {
        readyTimeoutMs: 30_000,
        mcp: { durable: { type: "stdio", command: "node", args: [fixture] } },
        extraEnv: {
            PLURNK_A2A_durable: JSON.stringify({ name: "durable", url: agent.baseUrl }),
            PLURNK_A2A_ENABLED: "1",
            PLURNK_MODEL_controlfixture: "lmstudio/control-family/selected",
            PLURNK_PROVIDERS_CONTEXT_WINDOW_controlfixture: "32768",
            PLURNK_PROVIDERS_EFFORT_controlfixture: "off",
            PLURNK_PROVIDERS_REASONING_OFF_BODY_controlfixture: '{"reasoning_effort":"none"}',
            LMSTUDIO_API_KEY: "conformance",
        },
    });
    t.after(daemon.cleanup);
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    // A standard global Agent Skill present before the Worker's first Functionality demand.
    await mkdir(join(daemon.home, ".agents", "skills", "durable-skill"), { recursive: true });
    await writeFile(join(daemon.home, ".agents", "skills", "durable-skill", "SKILL.md"), "---\nname: durable-skill\ndescription: Durable skill\n---\nUse it.\n");

    const original = `terminal-durable-${crypto.randomUUID()}`;
    const created = await actionViaAgui<{ id: number; name: string; workerId: number }>(
        { aguiUrl: daemon.url },
        { threadId: "terminal-control", kind: "workspace.create", params: { name: original, projectRoot: null } },
    );
    const connectionA = new AguiTransport(
        { aguiUrl: daemon.url },
        "terminal-durable-worker",
        { workspace: original },
    );
    const connectionB = new AguiTransport(
        { aguiUrl: daemon.url },
        "terminal-durable-worker",
        { workspace: original },
    );
    const from = <T>(connection: "a" | "b", kind: string, params: object = {}): Promise<T> =>
        (connection === "a" ? connectionA : connectionB).rpc<T>(kind, params);

    const listed = await actionViaAgui<{ workspaces: Array<{ id: number; name: string }> }>(
        { aguiUrl: daemon.url },
        { threadId: "terminal-observer", kind: "workspace.list" },
    );
    assert.ok(listed.workspaces.some(({ id, name }) => id === created.id && name === original));

    const child = await from<{ workerId: number }>("a", "run.fork", { name: "durable-child" });
    const workers = await from<{ workers: Array<{ id: number; name: string }> }>(
        "b",
        "workspace.workers",
        { id: created.id },
    );
    assert.ok(workers.workers.some(({ id, name }) => id === child.workerId && name === "durable-child"));

    await from("a", "worker.model.set", { selector: "controlfixture" });
    const model = await from<{ model: { alias: string; provider: string; model: string; effort?: string; effortSource?: string } }>("b", "worker.model.get");
    // The route carries the worker's durable effort with the identity (plurnk#41).
    assert.deepEqual(model.model, {
        alias: "controlfixture",
        provider: "lmstudio",
        model: "control-family/selected",
        effort: "off",
        // {§cli-identity-effort} — the daemon states the provenance beside the policy.
        effortSource: "default",
    });

    await from("a", "worker.child.set", { selector: "controlfixture" });
    const childModel = await from<{ spawnModel: { alias: string } }>("b", "worker.model.get");
    assert.equal(childModel.spawnModel.alias, "controlfixture");

    await from("a", "worker.effort.set", { effort: "adaptive" });
    assert.equal((await from<{ effort: string }>("b", "worker.effort.get")).effort, "adaptive");
    await from("a", "workspace.capabilities.set", {
        policy: { deny: [{ runtime: "sh" }] },
    });
    const capabilities = await from<{ workspace: object; effective: object }>("b", "workspace.capabilities.get");
    assert.deepEqual(capabilities.workspace, { deny: [{ runtime: "sh" }] });
    assert.deepEqual(capabilities.effective, { deny: [{ runtime: "sh" }] });

    // Configured servers and workspace additions share the durable lifecycle.
    type Server = { alias: string; origin: string; state: string; definition: object };
    const server = async (name: string): Promise<Server | undefined> =>
        (await from<{ definitions: Server[] }>("b", "workspace.mcp.list")).definitions.find(({ alias }) => alias === name);
    const configured = await server("durable");
    assert.deepEqual(configured?.definition, { name: "durable", type: "stdio", command: "node", args: [fixture] });
    assert.equal(configured?.origin, "service");
    assert.notEqual(configured?.state, "disabled", "declared servers default enabled");
    await from("a", "workspace.mcp.disable", { alias: "durable" });
    assert.equal((await server("durable"))?.state, "disabled");
    await from("a", "workspace.mcp.enable", { alias: "durable" });
    assert.equal((await server("durable"))?.state, "active");
    await from("a", "workspace.mcp.add", {
        alias: "added",
        definition: { name: "added", type: "stdio", command: "node", args: [fixture] },
    });
    const added = await server("added");
    assert.equal(added?.origin, "workspace");
    assert.equal(added?.state, "active");
    await from("a", "workspace.mcp.remove", { alias: "added" });
    assert.equal(await server("added"), undefined);

    const skills = async (): Promise<Array<{ alias: string; state: string }>> =>
        (await from<{ definitions: Array<{ alias: string; state: string }> }>("b", "workspace.skills.list")).definitions;
    assert.equal((await skills()).find(({ alias }) => alias === "durable-skill")?.state, "active");

    const agents = async (): Promise<Array<{ alias: string; state: string }>> =>
        (await from<{ definitions: Array<{ alias: string; state: string }> }>("b", "workspace.a2a.list")).definitions;
    assert.equal((await agents()).find(({ alias }) => alias === "durable")?.state, "active");
    await from("a", "workspace.a2a.disable", { alias: "durable" });
    assert.equal((await agents()).find(({ alias }) => alias === "durable")?.state, "disabled");
    await from("a", "workspace.a2a.enable", { alias: "durable" });
    assert.equal((await agents()).find(({ alias }) => alias === "durable")?.state, "active");
    await from("a", "workspace.skills.disable", { alias: "durable-skill" });
    assert.equal((await skills()).find(({ alias }) => alias === "durable-skill")?.state, "disabled");
    await from("a", "workspace.skills.enable", { alias: "durable-skill" });
    assert.equal((await skills()).find(({ alias }) => alias === "durable-skill")?.state, "active");

    const renamed = `${original}-renamed`;
    await from("a", "workspace.rename", { name: renamed });
    const afterRename = await actionViaAgui<{ workspaces: Array<{ id: number; name: string }> }>(
        { aguiUrl: daemon.url },
        { threadId: "terminal-observer-after-rename", kind: "workspace.list" },
    );
    assert.ok(afterRename.workspaces.some(({ id, name }) => id === created.id && name === renamed));
});

test("[§cli-file-members] separate client connections observe the durable file members family", { timeout: 60_000 }, async (t) => {
    const service = await locateDaemon();
    if (service === null) { t.skip("no plurnk-service binary reachable"); return; }
    const daemon = await bootDaemon(service, {
        readyTimeoutMs: 30_000,
        extraEnv: { PLURNK_MEMBERS_docs: "docs/**", PLURNK_MEMBERS_ENABLED: "1" },
    });
    t.after(daemon.cleanup);
    const target = { aguiUrl: daemon.url };
    const discovery = await actionViaAgui<{ actions: Record<string, unknown> }>(target, { threadId: "terminal-members-discovery", kind: "discover" });
    if (!("workspace.members.list" in discovery.actions)) { t.skip("the daemon does not serve the members family"); return; }

    const project = await mkdtemp(join(tmpdir(), "plurnk-members-durable-"));
    t.after(() => rm(project, { recursive: true, force: true }));
    await mkdir(join(project, "docs"));
    await writeFile(join(project, "docs", "guide.md"), "# guide\n");
    await writeFile(join(project, "note.md"), "# note\n");
    const name = `terminal-members-${crypto.randomUUID()}`;
    await actionViaAgui(target, { threadId: "terminal-members-control", kind: "workspace.create", params: { name, projectRoot: project } });
    const connectionA = new AguiTransport(target, "terminal-members-worker", { workspace: name });
    const connectionB = new AguiTransport(target, "terminal-members-worker", { workspace: name });
    type Definition = { alias: string; origin: string; state: string; detail?: { effect: string; pattern: string; matched: number; files: string[]; ignored: number } };
    const members = async (): Promise<Definition[]> =>
        (await connectionB.rpc<{ definitions: Definition[] }>("workspace.members.list", {})).definitions;

    const docs = (await members()).find(({ alias }) => alias === "docs");
    assert.equal(docs?.origin, "service");
    assert.equal(docs?.state, "dormant", "inspection does not activate a cold workspace");
    assert.equal(docs?.detail, undefined, "unprepared definitions do not claim a runtime outcome");

    await connectionA.rpc("workspace.members.add", { alias: "note", definition: { glob: "note.md" } });
    const prepared = (await members()).find(({ alias }) => alias === "docs");
    assert.equal(prepared?.state, "active");
    assert.deepEqual(prepared?.detail, { effect: "include", pattern: "docs/**", matched: 1, files: ["docs/guide.md"], ignored: 0 });
    assert.equal((await members()).find(({ alias }) => alias === "note")?.state, "active");
    await connectionA.rpc("workspace.members.disable", { alias: "note" });
    assert.equal((await members()).find(({ alias }) => alias === "note")?.state, "disabled");
    await connectionA.rpc("workspace.members.enable", { alias: "note" });
    assert.equal((await members()).find(({ alias }) => alias === "note")?.state, "active");
    await connectionA.rpc("workspace.members.remove", { alias: "note" });
    assert.equal((await members()).some(({ alias }) => alias === "note"), false);
});
