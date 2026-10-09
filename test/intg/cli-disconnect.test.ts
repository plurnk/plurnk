import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import type { LoopUsage } from "../../src/render.ts";

const usage: LoopUsage = {
    accounting: {
        requests: [{ provider: "fixture", model: "fixture", outcome: "response", usage: { inputTokens: 10, outputTokens: 5 },
            cost: { kind: "estimated", amount: { amount: "0.01", currency: "USD" }, source: "fixture" } }],
        usage: { inputTokens: 10, outputTokens: 5 }, knownUsage: { inputTokens: 10, outputTokens: 5 },
        costUsd: "0.01", knownCostUsd: "0.01",
    },
    curationWeight: 20, curationBudget: 1000, contextTokens: 10, contextCapacity: 2000, meta: {},
};
const reportedProblem = { type: "https://problems.example.test/denied", title: "Denied", status: 403, detail: "Fixture operation denied." };

for (const resumed of [false, true]) {
for (const failure of ["socket", "eof", "invalid-frame", "reported-problem", "terminal"] as const) {
    test(`[§cli-partial-record] built CLI retains observed evidence when its ${resumed ? "resumed" : "initial"} connection breaks (${failure})`, { timeout: 15_000 }, async (t) => {
        const directory = await mkdtemp(join(tmpdir(), "plurnk-disconnect-"));
        t.after(() => rm(directory, { recursive: true, force: true }));
        let runs = 0;
        let active: ServerResponse | undefined;
        const server = createServer(async (request, response) => {
            let raw = "";
            for await (const chunk of request) raw += chunk;
            const input = RunAgentInputSchema.parse(JSON.parse(raw));
            response.writeHead(200, { "content-type": "text/event-stream" });
            const frame = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
            const finish = () => {
                frame({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId });
                response.end();
            };
            frame({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
            const action = input.forwardedProps?.plurnk?.action;
            if (action !== undefined) {
                assert.ok(["workspace.list", "worker.model.get"].includes(action.kind), "no cancellation, replay or reconnect is needed to retain received evidence");
                frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: action.kind, ok: true, result:
                    action.kind === "workspace.list" ? { workspaces: [{ name: "world", project_root: directory }] } : { model: null },
                } });
                finish();
                return;
            }
            runs += 1;
            frame({ type: "CUSTOM", name: "plurnk.row", value: {
                id: runs, worker_id: 11, loop_seq: 1, turn_seq: runs, sequence: 1,
                op: "SEND", origin: "model", signal: null, scheme: null, hostname: null,
                pathname: null, fragment: null, lineMarker: null, status_rx: 200, tags: [],
                tx: { body: { raw: `observed segment ${runs}` } }, rx: { answers: ["agui://anonymous/threads/" + encodeURIComponent(input.threadId) + "/messages/m1"] },
            } });
            if (resumed && runs === 1) {
                frame({ type: "TOOL_CALL_START", toolCallId: "prop:9", toolCallName: "request_approval" });
                frame({ type: "TOOL_CALL_ARGS", toolCallId: "prop:9", delta: JSON.stringify({ logEntryId: 9, op: "EDIT", target: {}, body: "diff", attrs: {} }) });
                frame({ type: "TOOL_CALL_END", toolCallId: "prop:9" });
                frame({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId, outcome: {
                    type: "interrupt", interrupts: [{ id: "prop:9", reason: "tool_call", toolCallId: "prop:9" }],
                } });
                response.end();
                return;
            }
            if (resumed) assert.equal(input.resume?.[0]?.interruptId, "prop:9");
            active = response;
            if (failure === "reported-problem") frame({ type: "CUSTOM", name: "plurnk.problem", value: reportedProblem });
            if (failure === "terminal") frame({ type: "CUSTOM", name: "plurnk.terminated", value: {
                workspaceId: 7, workerId: 11, loopId: 3, hitMaxTurns: false,
                turnIds: resumed ? [1, 2] : [1], usage, result: { status: 200 },
            } });
            frame({ type: "CUSTOM", name: "plurnk.notice", value: {
                source: "engine:turn", kind: "turn_generated", message: "turn observed",
                accounting: { inputTokens: 10, outputTokens: 5, costUsd: "0.01" },
            } });
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        t.after(() => new Promise<void>((done, reject) => {
            server.closeAllConnections();
            server.close((error) => error === undefined ? done() : reject(error));
        }));
        const address = server.address();
        assert.ok(address !== null && typeof address !== "string");
        const child = spawn(process.execPath, [
            resolve(import.meta.dirname, "../../bin/plurnk.js"),
            "--json", "--yolo", "--status-stream", "--workspace", "world", "--worker", "actor", "test prompt",
        ], {
            cwd: directory,
            env: { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: directory, NO_COLOR: "1", PLURNK_AGUI_URL: `http://127.0.0.1:${address.port}` },
            stdio: ["ignore", "pipe", "pipe"],
        });
        t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        let stdout = "";
        let stderr = "";
        let dropped = false;
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
            if (!dropped && stderr.includes("status-stream: turn")) {
                dropped = true;
                if (failure === "eof") active!.end();
                else if (failure === "invalid-frame") active!.end("data: broken-frame\n\n");
                else active!.destroy();
            }
        });
        const [code, signal] = await once(child, "close");
        assert.ok(dropped, stderr + stdout);
        assert.equal(code, failure === "eof" ? 4 : 1, stderr);
        assert.equal(signal, null);
        const record = JSON.parse(stdout);
        assert.equal(record.response, `observed segment ${resumed ? 2 : 1}`, "received response survives a transport exception");
        assert.equal(record.workerId, 11);
        assert.deepEqual(record.usage, failure === "terminal" ? usage : null, "preserve terminal accounting, never promote a partial tally");
        assert.equal(record.turns.length, resumed ? 2 : 1);
        assert.ok(record.notices.some((notice: { kind: string }) => notice.kind === "turn_generated"), "retain partial accounting evidence");
        if (failure === "terminal") {
            assert.equal(record.finalStatus, 200, "a later transport failure does not rewrite the known loop outcome");
            assert.equal(record.problem, undefined);
            assert.equal(record.loopId, 3);
        } else if (failure === "reported-problem") {
            assert.equal(record.finalStatus, 403);
            assert.deepEqual(record.problem, reportedProblem);
        } else {
            assert.equal(record.finalStatus, 502);
        }
        const fault = failure === "terminal" || failure === "reported-problem"
            ? record.notices.at(-1).problem : record.problem;
        assert.equal(fault.type, failure === "eof"
            ? "https://problems.plurnk.xyz/client/transport/terminal-missing"
            : "https://problems.plurnk.xyz/client/agui/error");
        if (failure === "invalid-frame") assert.match(fault.detail, /broken-frame/u);
        else if (failure !== "eof") assert.equal(fault.detail, "terminated");
        assert.equal(runs, resumed ? 2 : 1, "no automatic prompt replay");
    });
}
}
