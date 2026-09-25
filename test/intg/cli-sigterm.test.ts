import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";

for (const resumed of [false, true]) {
    test(`[§cli-interrupted-record] built CLI flushes its ${resumed ? "resumed" : "initial"} in-flight record on SIGTERM`, { timeout: 15_000 }, async (t) => {
        const directory = await mkdtemp(join(tmpdir(), "plurnk-sigterm-"));
        t.after(() => rm(directory, { recursive: true, force: true }));
        const body = "partial ✓ ".repeat(40_000);
        let runs = 0;
        const server = createServer(async (request, response) => {
            let raw = "";
            for await (const chunk of request) raw += chunk;
            const input = RunAgentInputSchema.parse(JSON.parse(raw));
            response.writeHead(200, { "content-type": "text/event-stream" });
            const frame = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
            frame({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
            const action = input.forwardedProps?.plurnk?.action;
            if (action !== undefined) {
                assert.equal(action.kind, "worker.model.get");
                frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: action.kind, ok: true, result: { model: null } } });
                frame({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId, outcome: { type: "success" } });
                response.end();
                return;
            }
            runs++;
            frame({ type: "CUSTOM", name: "plurnk.row", value: {
                id: runs, worker_id: 11, loop_seq: 1, turn_seq: runs, sequence: 1,
                op: "SEND", origin: "model", signal: null, scheme: null, hostname: null,
                pathname: null, fragment: null, lineMarker: null, status_rx: 200, tags: [],
                tx: { body: { raw: resumed && runs === 1 ? "before proposal" : body } }, rx: { answers: [] },
            } });
            if (resumed && runs === 1) {
                frame({ type: "TOOL_CALL_START", toolCallId: "prop:9", toolCallName: "request_approval" });
                frame({ type: "TOOL_CALL_ARGS", toolCallId: "prop:9", delta: JSON.stringify({ logEntryId: 9, op: "EDIT", target: {}, body: "diff", attrs: {} }) });
                frame({ type: "TOOL_CALL_END", toolCallId: "prop:9" });
                frame({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId, outcome: {
                    type: "interrupt", interrupts: [{ id: "prop:9", reason: "tool_call", toolCallId: "prop:9" }],
                } });
                response.end();
            } else {
                if (resumed) assert.equal(input.resume?.[0]?.interruptId, "prop:9");
                frame({ type: "CUSTOM", name: "plurnk.notice", value: {
                    source: "engine:turn", kind: "turn_generated", message: "turn observed",
                    accounting: { inputTokens: 10, outputTokens: 5, costUsd: "0.01" },
                } });
                // Leave the exchange open: termination is deliberately never delivered.
            }
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
        let signalled = false;
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
            if (!signalled && stderr.includes("status-stream: turn")) {
                signalled = true;
                child.kill("SIGTERM");
            }
        });
        const [code, signal] = await once(child, "close");
        assert.ok(signalled, stderr + stdout);
        assert.equal(code, 143, stderr);
        assert.equal(signal, null);
        const record = JSON.parse(stdout);
        assert.equal(record.finalStatus, 502, "no daemon terminal truth means no invented success");
        assert.equal(record.response, body, "the latest observed response survives, including pipe-sized output");
        assert.equal(record.workerId, 11);
        assert.equal(record.loopId, 0, "unknown terminal coordinates are not invented");
        assert.equal(record.usage, null, "turn hints do not fabricate authoritative terminal accounting");
        assert.equal(record.turns.length, resumed ? 2 : 1);
        assert.equal(record.notices.at(-1).kind, "turn_generated");
        assert.equal(runs, resumed ? 2 : 1);
    });
}
