import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";

const exec = promisify(execFile);

test("[§cli-family-arguments] built family commands preserve their arguments at the AG-UI boundary", { timeout: 30_000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "plurnk-family-arguments-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const actions: Record<string, unknown>[] = [];
    const server = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += chunk;
        const input = RunAgentInputSchema.parse(JSON.parse(body));
        const action = input.forwardedProps?.plurnk?.action;
        assert.ok(action);
        assert.equal(input.forwardedProps?.plurnk?.workspace, "world");
        assert.equal(input.threadId, "actor");
        actions.push(action);
        response.writeHead(200, { "content-type": "text/event-stream" });
        const frame = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
        frame({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
        frame({ type: "CUSTOM", name: "plurnk.action.result", value: {
            kind: action.kind, ok: true, result: { status: 201, alias: action.alias, definition: { state: "active" } },
        } });
        frame({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId, outcome: { type: "success" } });
        response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const cases: Array<{ args: string[]; action: Record<string, unknown> }> = [
        ...[false, true].map((separator) => {
            const args = ["-y", "@example/server", "--port", "8080", "--json", "--env-file", "missing.env", "--", "two words", "--help", "--model"];
            return {
                args: ["mcp", ...(separator ? ["--"] : []), "add", "echo", "node", ...args],
                action: { kind: "workspace.mcp.add", alias: "echo", definition: { name: "echo", type: "stdio", command: "node", args } },
            };
        }),
        {
            args: ["skills", "add", "changelog", "/my skills", "--ref", "v2"],
            action: { kind: "workspace.skills.add", alias: "changelog", definition: { name: "changelog", source: "/my skills", ref: "v2" } },
        },
        {
            args: ["a2a", "add", "researcher", "https://agent.example"],
            action: { kind: "workspace.a2a.add", alias: "researcher", definition: { name: "researcher", url: "https://agent.example" } },
        },
        {
            args: ["members", "add", "docs", "docs with spaces/**"],
            action: { kind: "workspace.members.add", alias: "docs", definition: { glob: "docs with spaces/**" } },
        },
        {
            args: ["env", "--scope", "workspace", "add", "FLAGS", "--model=mcp  --port=8080"],
            action: { kind: "workspace.env.add", alias: "FLAGS", definition: { value: "--model=mcp  --port=8080" } },
        },
        {
            args: ["schedule", "add", "daily", "actor", "FREQ=DAILY", "Check", "--json"],
            action: { kind: "workspace.schedule.add", alias: "daily", definition: {
                rule: "FREQ=DAILY", target: "worker://actor", prompt: "Check --json",
            } },
        },
    ];
    for (const { args, action } of cases) {
        await t.test(args.join(" "), async () => {
            actions.length = 0;
            const result = await exec(resolve(import.meta.dirname, "../../bin/plurnk.js"), [
                "--workspace", "world", "--worker", "actor", "--json", ...args,
            ], {
                cwd: directory, timeout: 10_000,
                env: {
                    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PLURNK_"))),
                    HOME: directory, XDG_CONFIG_HOME: join(directory, ".config"), NO_COLOR: "1",
                    PLURNK_AGUI_URL: `http://127.0.0.1:${address.port}`,
                },
            });
            assert.equal(result.stderr, "");
            assert.equal(JSON.parse(result.stdout).status, 201);
            assert.deepEqual(actions, [action]);
        });
    }
});
