import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { actionViaAcp, RunAgentInputSchema, type RunAgentInput } from "../../src/acp.ts";
import { CLIENT_ID_CLI } from "../../src/dispatcher.ts";
import { bootDaemon, locateDaemon } from "./harness.ts";

const exec = promisify(execFile);
const bin = resolve(import.meta.dirname, "../../bin/plurnk.js");
const script = "````EDIT (witness.txt)\nscript witness\n````";
const run = async (url: string, directory: string, args: string[]) => {
    const home = join(directory, "fixture-home");
    await mkdir(home, { recursive: true });
    return exec(process.execPath, [
        bin, "--json", "--yolo", ...args, "script", join(directory, "input.plk"),
    ], {
        cwd: directory,
        timeout: 30_000,
        env: {
            ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PLURNK_"))),
            HOME: home,
            XDG_CONFIG_HOME: join(home, ".config"),
            PLURNK_ACP_URL: url,
            NO_COLOR: "1",
        },
    });
};

test("[§cli-script-binding] built scripts bind their workspace, worker, and settings", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "plurnk-script-wire-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(join(directory, "input.plk"), script);
    const requests: RunAgentInput[] = [];
    let created = 0;
    const server = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        const input = RunAgentInputSchema.parse(JSON.parse(body));
        requests.push(input);
        const props = input.forwardedProps?.plurnk;
        response.writeHead(200, { "content-type": "text/event-stream" });
        const frame = (value: unknown) => response.write("data: " + JSON.stringify(value) + "\n\n");
        frame({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
        const result = props?.action?.kind === "workspace.list"
            ? { kind: "workspace.list", ok: true, result: { workspaces: [] } }
            : props?.action?.kind === "workspace.create"
                ? { kind: "workspace.create", ok: true, result: { id: ++created, name: "generated-" + created } }
                : { kind: "op.parse", ok: true, result: { results: [{ status: 201 }] } };
        frame({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId, outcome: { type: "success" }, result });
        response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => error === undefined ? resolve() : reject(error));
    }));
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const url = "http://127.0.0.1:" + address.port;
    const settings = { filesItems: 0, maxCommands: 12, git: false, capabilities: { deny: [{ runtime: "sh" }] }, client: CLIENT_ID_CLI };
    const flags = ["--files-items", "0", "--max-commands", "12", "--no-git", "--capabilities", JSON.stringify(settings.capabilities)];

    for (const root of [directory, ""]) {
        await t.test(root === "" ? "explicit headless workspace" : "explicit project workspace", async () => {
            requests.length = 0;
            const result = await run(url, directory, ["--workspace", "workspace", "--worker", "actor", "--project-root", root, ...flags]);
            assert.equal(result.stderr, "");
            assert.equal(JSON.parse(result.stdout).exitCode, 0);
            assert.equal(requests.length, 4);
            const [lookup, create, stored, bound] = requests;
            assert.deepEqual(lookup.forwardedProps?.plurnk?.action, { kind: "workspace.list" });
            assert.equal(lookup.forwardedProps?.plurnk?.projectRoot, undefined, "root discovery imposes no creation default");
            assert.deepEqual(create.forwardedProps?.plurnk?.action, { kind: "workspace.create", name: "workspace", projectRoot: root === "" ? null : root, settings });
            assert.equal(stored.forwardedProps?.plurnk?.action?.kind, "workspace.list");
            assert.equal(bound.threadId, `${created}#actor`);
            assert.equal(bound.forwardedProps?.plurnk?.workspace, undefined);
            assert.equal(bound.forwardedProps?.plurnk?.projectRoot, undefined);
            assert.equal(bound.forwardedProps?.plurnk?.settings, undefined);
            assert.deepEqual(bound.forwardedProps?.plurnk?.action, { kind: "op.parse", text: script });
        });
    }
    // {§workspace-name} — the daemon names an unnamed workspace after the folder the launch designates.
    await t.test("an unnamed invocation designates its directory and binds the workspace the daemon names", async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            requests.length = 0;
            const result = await run(url, directory, [...flags]);
            assert.equal(JSON.parse(result.stdout).exitCode, 0, result.stderr);
            assert.equal(requests.length, 3);
            const [create, lookup, ...bound] = requests;
            assert.deepEqual(create.forwardedProps?.plurnk?.action, { kind: "workspace.create", projectRoot: directory, settings });
            assert.equal(lookup.forwardedProps?.plurnk?.action?.kind, "workspace.list", "the bound workspace's stored root is read back by name");
            for (const input of bound) {
                assert.equal(input.threadId, `${created}#user`);
                assert.equal(input.forwardedProps?.plurnk?.workspace, undefined);
            }
            assert.equal(bound[0].forwardedProps?.plurnk?.projectRoot, undefined);
            assert.equal(bound[0].forwardedProps?.plurnk?.settings, undefined);
            assert.ok(requests.every((input) => input.forwardedProps?.plurnk?.workspace !== directory), "the client derives no name of its own");
        }
    });

    await t.test("a headless root without a name is refused before any request", async () => {
        requests.length = 0;
        await assert.rejects(run(url, directory, ["--project-root=", ...flags]), (error: unknown) => {
            const { code, stdout } = error as { code: number; stdout: string };
            const { problem } = JSON.parse(stdout) as { problem: { type: string; flag: string } };
            return code === 64 && problem.type === "https://problems.plurnk.xyz/client/flag/missing-dependency" && problem.flag === "--project-root=";
        });
        assert.equal(requests.length, 0, "refused before the daemon is asked anything");
    });
});

test("[§cli-script-binding] the built client mutates only its selected real workspace", { timeout: 60_000 }, async (t) => {
    const service = await locateDaemon();
    if (service === null) { t.skip("no plurnk-service binary reachable"); return; }
    const daemon = await bootDaemon(service);
    t.after(daemon.cleanup);
    await writeFile(join(daemon.workspace, "input.plk"), script);
    const result = await run(daemon.url, daemon.workspace, [
        "--workspace", "script-workspace", "--worker", "script-actor", "--no-git",
        "--capabilities", '{"deny":[{"runtime":"sh"}]}',
    ]);
    assert.equal(JSON.parse(result.stdout).exitCode, 0, result.stderr);
    assert.equal(await readFile(join(daemon.workspace, "witness.txt"), "utf8"), "script witness");
    const target = { acpUrl: daemon.url };
    const { workspaces } = await actionViaAcp<{ workspaces: Array<{ name: string; project_root: string }> }>(
        target, { threadId: "inspect", kind: "workspace.list" },
    );
    assert.deepEqual(workspaces.map(({ name, project_root }) => ({ name, project_root })), [
        { name: "script-workspace", project_root: daemon.workspace },
    ], "the worker name never becomes a second workspace");
    const policy = await actionViaAcp<{ workspace: unknown }>(target, {
        threadId: "script-actor", workspace: "script-workspace", kind: "workspace.capabilities.get",
    });
    assert.deepEqual(policy.workspace, { deny: [{ runtime: "sh" }] }, "creation policy is durable");
});
