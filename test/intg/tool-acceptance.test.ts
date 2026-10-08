import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { actionViaAgui } from "../../src/agui.ts";
import { objectOf, type LogEntryWire } from "../../src/render.ts";
import { bootDaemon, completionsEndpoint, locateDaemon } from "./harness.ts";

const exec = promisify(execFile);
const bin = resolve(import.meta.dirname, "../../bin/plurnk.js");
const operations = [
    "````fixture (where)\n{}\n````",
    "````fixture (fail)\n{}\n````",
    "````sh\nprintf accepted > accepted.txt\n````",
    "````EDIT (rejected.txt)\nnot authorized\n````",
].join("\n\n");

test("[§cli-tool-acceptance]: built CLI accepts configured tools, rejects unmatched proposals and persists its reasons", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service);
    let calls = 0;
    const endpoint = await completionsEndpoint(() => ++calls % 2 === 1 ? operations : "````KILL\nFinished.\n````");
    t.after(endpoint.close);
    const daemon = await bootDaemon(service, {
        mcp: { fixture: {
            type: "stdio", command: process.execPath,
            args: [resolve(import.meta.dirname, "../../../plurnk-service/plurnk-mcp/src/fixtures/echo-server.mjs")],
            env: { PLURNK_MCP_TEST_WHERE: "1" },
        } },
        extraEnv: {
            PLURNK_MODEL: "approvalfixture", PLURNK_MODEL_approvalfixture: "openai/approval-fixture",
            PLURNK_BASEURL_approvalfixture: endpoint.url, OPENAI_BASE_URL: endpoint.url, OPENAI_API_KEY: "fixture",
            PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768", PLURNK_PROVIDERS_EFFORT: "off", PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
        },
    });
    t.after(daemon.cleanup);
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    const environment = {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PLURNK_") && !key.endsWith("_API_KEY"))),
        HOME: daemon.home, XDG_CONFIG_HOME: join(daemon.home, ".config"), NO_COLOR: "1",
        PLURNK_AGUI_URL: daemon.url, PLURNK_CLIENT_YOLO: "0",
        PLURNK_CLIENT_ACCEPT_fixture: "1", PLURNK_CLIENT_ACCEPT_fixture_TOOLS: '["where"]',
        PLURNK_CLIENT_ACCEPT_sh: "1",
    };
    const run = async (name: string, args: string[], env: NodeJS.ProcessEnv = environment) => {
        const child = exec(process.execPath,
            [bin, "--json", "--workspace", name, "--worker", "main", "--no-git", "--max-turns", "4", ...args],
            { cwd: daemon.workspace, env, timeout: 40_000 },
        );
        child.child.stdin?.end();
        return child;
    };

    const result = await run("acceptance", ["Exercise configured acceptance."]);
    const record = JSON.parse(result.stdout) as { finalStatus: number; workerId: number };
    assert.equal(record.finalStatus, 200, result.stdout);
    assert.equal(calls, 2);
    assert.equal(await readFile(join(daemon.workspace, "accepted.txt"), "utf8"), "accepted");
    await assert.rejects(readFile(join(daemon.workspace, "rejected.txt")), { code: "ENOENT" });
    const { entries } = await actionViaAgui<{ entries: LogEntryWire[] }>({ aguiUrl: daemon.url }, {
        kind: "log.read", workspace: "acceptance", threadId: "main", params: { workerId: record.workerId, limit: 100 },
    });
    const settled = entries.filter((row) => row.origin === "model" && ["fixture", "sh", "EDIT"].includes(row.op))
        .toSorted((left, right) => left.id - right.id);
    assert.deepEqual(settled.map((row) => [row.op, objectOf(row.rx)?.outcome]), [
        ["fixture", "auto: fixture (where)"], ["fixture", "client_no_review_channel"],
        ["sh", "auto: sh"], ["EDIT", "client_no_review_channel"],
    ]);
    assert.deepEqual(settled.filter((row) => objectOf(row.rx)?.outcome === "client_no_review_channel").map((row) => row.status_rx), [400, 400]);

    const reviewed = await run("explicit-review", ["? Do not automatically accept these."], { ...environment, PLURNK_CLIENT_YOLO: "1" });
    const reviewRecord = JSON.parse(reviewed.stdout) as { finalStatus: number; workerId: number };
    assert.equal(reviewRecord.finalStatus, 200, reviewed.stdout);
    const history = await actionViaAgui<{ entries: LogEntryWire[] }>({ aguiUrl: daemon.url }, {
        kind: "log.read", workspace: "explicit-review", threadId: "main", params: { workerId: reviewRecord.workerId, limit: 100 },
    });
    const rejected = history.entries.filter((row) => row.origin === "model" && ["fixture", "sh", "EDIT"].includes(row.op));
    assert.equal(rejected.length, 4);
    assert.ok(rejected.every((row) => row.status_rx === 400 && objectOf(row.rx)?.outcome === "client_no_review_channel"));

    await writeFile(join(daemon.workspace, "allowed.plk"), "````sh\nprintf script > script.txt\n````");
    const scripted = await run("script-acceptance", ["script", join(daemon.workspace, "allowed.plk")]);
    assert.equal(JSON.parse(scripted.stdout).exitCode, 0, scripted.stdout);
    assert.equal(await readFile(join(daemon.workspace, "script.txt"), "utf8"), "script");

    await writeFile(join(daemon.workspace, "denied.plk"), "````sh\nprintf forbidden > forbidden.txt\n````");
    await assert.rejects(run("capability-blocked", ["--capabilities", '{"deny":[{"runtime":"sh"}]}', "script", join(daemon.workspace, "denied.plk")]), (cause: unknown) => {
        assert.ok(cause instanceof Error && "stdout" in cause && typeof cause.stdout === "string");
        const denied = JSON.parse(cause.stdout) as { exitCode: number; results: Array<{ status: number; problem: { type: string } }> };
        assert.equal(denied.exitCode, 4);
        assert.equal(denied.results[0].status, 403);
        assert.match(denied.results[0].problem.type, /capability-denied$/);
        return true;
    });
    await assert.rejects(readFile(join(daemon.workspace, "forbidden.txt")), { code: "ENOENT" });

    const invalid = await run("invalid-acceptance", ["Repairable configuration."], { ...environment, PLURNK_CLIENT_ACCEPT_fixture_TOOLS: "invalid" });
    const invalidRecord = JSON.parse(invalid.stdout) as { finalStatus: number; notices: Array<{ kind: string }> };
    assert.equal(invalidRecord.finalStatus, 200, invalid.stdout);
    assert.ok(invalidRecord.notices.some((notice) => notice.kind === "acceptance-unavailable"));
});
