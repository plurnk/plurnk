import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";

const run = promisify(execFile);

test("[§cli-invocation] host/port selects /agui; an explicit endpoint remains exact", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "plurnk-endpoint-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const requests: Array<{ method: string | undefined; path: string | undefined }> = [];
    const server = createServer(async (request, response) => {
        requests.push({ method: request.method, path: request.url });
        let body = "";
        for await (const chunk of request) body += chunk;
        const input = RunAgentInputSchema.parse(JSON.parse(body));
        const action = input.forwardedProps?.plurnk?.action;
        assert.equal(action?.kind, "workspace.list");
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of [
            { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId },
            { type: "CUSTOM", name: "plurnk.action.result", value: { kind: action.kind, ok: true, result: { workspaces: [] } } },
            { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId, outcome: { type: "success" } },
        ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
    const address = server.address();
    assert.ok(address !== null && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const cases = [["", "/agui"], [`${origin}/custom/agent`, "/custom/agent"], [origin, "/"]] as const;
    for (const [url, path] of cases) {
        requests.length = 0;
        const result: { stdout: string; stderr: string } = await run(process.execPath, [
            resolve(import.meta.dirname, "../../bin/plurnk.js"), "workspace", "list", "--json",
        ], {
            cwd: directory, timeout: 10_000,
            env: {
                ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PLURNK_"))),
                HOME: directory, XDG_CONFIG_HOME: join(directory, ".config"), NO_COLOR: "1",
                PLURNK_HOST: "127.0.0.1", PLURNK_PORT: String(address.port), PLURNK_AGUI_URL: url,
            },
        });
        assert.equal(result.stderr, "");
        assert.deepEqual(JSON.parse(result.stdout), []);
        assert.deepEqual(requests, [{ method: "POST", path }]);
    }
});
