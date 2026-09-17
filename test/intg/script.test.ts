import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { RunAgentInputSchema, type RunAgentInput } from "@ag-ui/core";
import { actionViaBridge } from "../../src/agui.ts";
import { CLIENT_ID_CLI } from "../../src/dispatcher.ts";
import { bootDaemon, locateDaemon } from "./harness.ts";

const exec = promisify(execFile);
const bin = resolve(import.meta.dirname, "../../bin/plurnk.js");
const script = "````EDIT (witness.txt)\nscript witness\n````";
const run = (url: string, directory: string, args: string[]) => exec(process.execPath, [
    bin, "--json", "--yolo", ...args, "script", join(directory, "input.plk"),
], {
    cwd: directory,
    timeout: 30_000,
    env: {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PLURNK_"))),
        HOME: directory,
        XDG_CONFIG_HOME: join(directory, ".config"),
        PLURNK_AGUI_URL: url,
        NO_COLOR: "1",
    },
});

test("[§cli-script-binding] built scripts retain workspace, worker, and settings across proposal resumes", async (t) => {
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
        if (props?.action?.kind === "workspace.create") {
            frame({ type: "CUSTOM", name: "plurnk.action.result", value: {
                kind: "workspace.create", ok: true, result: { id: ++created, name: "generated-" + created },
            } });
        } else if (input.resume === undefined) {
            frame({ type: "TOOL_CALL_START", toolCallId: "prop:9", toolCallName: "request_approval" });
            frame({ type: "TOOL_CALL_ARGS", toolCallId: "prop:9", delta: JSON.stringify({
                logEntryId: 9, loopId: 1, turnId: 1, op: "EDIT",
                target: { scheme: "file", pathname: "/witness.txt" }, body: "script witness", attrs: {},
                policy: { proposals: "review" },
            }) });
            frame({ type: "TOOL_CALL_END", toolCallId: "prop:9" });
            frame({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId, outcome: {
                type: "interrupt", interrupts: [{ id: "prop:9", reason: "tool_call", toolCallId: "prop:9" }],
            } });
            response.end();
            return;
        } else {
            frame({ type: "CUSTOM", name: "plurnk.action.result", value: {
                kind: "op.parse", ok: true, result: { results: [{ status: 201 }] },
            } });
        }
        frame({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId, outcome: { type: "success" } });
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
            const result = await run(url, directory, ["--workspace", "world", "--worker", "actor", "--project-root", root, ...flags]);
            assert.equal(result.stderr, "");
            assert.equal(JSON.parse(result.stdout).exitCode, 0);
            assert.equal(requests.length, 2);
            for (const input of requests) {
                assert.equal(input.threadId, "actor");
                assert.equal(input.forwardedProps?.plurnk?.workspace, "world");
            }
            assert.equal(requests[0].forwardedProps?.plurnk?.projectRoot, root === "" ? null : root);
            assert.deepEqual(requests[0].forwardedProps?.plurnk?.settings, settings);
            assert.deepEqual(requests[0].forwardedProps?.plurnk?.action, { kind: "op.parse", text: script });
            assert.deepEqual(requests[1].resume, [{ interruptId: "prop:9", status: "resolved", payload: { decision: "accept" } }]);
            assert.equal(requests[1].forwardedProps?.plurnk?.action, undefined, "resume does not resubmit the program");
        });
    }
    await t.test("unnamed invocations acquire distinct daemon-owned workspaces", async () => {
        const identities: string[] = [];
        for (let attempt = 0; attempt < 2; attempt += 1) {
            requests.length = 0;
            await run(url, directory, ["--project-root=", ...flags]);
            assert.equal(requests.length, 3);
            const create = requests[0].forwardedProps?.plurnk?.action;
            assert.equal(create?.kind, "workspace.create");
            assert.equal(create?.name, undefined);
            assert.equal(create?.projectRoot, null);
            assert.deepEqual(create?.settings, settings);
            const expected = "generated-" + created;
            for (const input of requests.slice(1)) {
                assert.equal(input.threadId, expected);
                assert.equal(input.forwardedProps?.plurnk?.workspace, expected);
            }
            identities.push(expected);
        }
        assert.equal(new Set(identities).size, 2);
    });
});

test("[§cli-script-binding] the built client mutates only its selected real workspace", { timeout: 60_000 }, async (t) => {
    const service = await locateDaemon();
    if (service === null) { t.skip("no plurnk-service binary reachable"); return; }
    const daemon = await bootDaemon(service);
    t.after(daemon.cleanup);
    await writeFile(join(daemon.workspace, "input.plk"), script);
    const result = await run(daemon.url, daemon.workspace, [
        "--workspace", "script-world", "--worker", "script-actor", "--no-git",
        "--capabilities", '{"deny":[{"runtime":"sh"}]}',
    ]);
    assert.equal(JSON.parse(result.stdout).exitCode, 0, result.stderr);
    assert.equal(await readFile(join(daemon.workspace, "witness.txt"), "utf8"), "script witness");
    const target = { bridgeUrl: daemon.url };
    const { workspaces } = await actionViaBridge<{ workspaces: Array<{ name: string; project_root: string }> }>(
        target, { threadId: "inspect", kind: "workspace.list" },
    );
    assert.deepEqual(workspaces.map(({ name, project_root }) => ({ name, project_root })), [
        { name: "script-world", project_root: daemon.workspace },
    ], "the worker name never becomes a second workspace");
    const policy = await actionViaBridge<{ workspace: unknown }>(target, {
        threadId: "script-actor", workspace: "script-world", kind: "workspace.capabilities.get",
    });
    assert.deepEqual(policy.workspace, { deny: [{ runtime: "sh" }] }, "creation policy is durable");
});
