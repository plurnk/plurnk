import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { RunAgentInputSchema } from "@ag-ui/core/schemas";
import { Validator } from "@plurnk/plurnk-contracts";
import { clientTransportTerminalMissing } from "../../src/diagnostics.ts";
import { bootDaemon, locateDaemon } from "./harness.ts";

for (const [interrupt, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
for (const [resumed, reportedFailure, cancelMode] of [
    [false, false, "accepted"], [false, true, "accepted"], [true, false, "accepted"], [true, true, "accepted"],
    [true, false, "refused"], [true, false, "interrupted"],
] as const) {
    test(`[§cli-interrupted-record] built CLI cancels and flushes its ${resumed ? "resumed" : "initial"} in-flight record on ${interrupt} (${reportedFailure ? "reported failure" : "missing outcome"}; cancellation ${cancelMode})`, { timeout: 15_000 }, async (t) => {
        const problem = reportedFailure ? {
            type: "https://problems.example.test/forbidden",
            title: "Forbidden",
            status: 403,
            detail: "The requested operation was denied.",
        } : clientTransportTerminalMissing();
        const directory = await mkdtemp(join(tmpdir(), "plurnk-sigterm-"));
        t.after(() => rm(directory, { recursive: true, force: true }));
        const body = "partial ✓ ".repeat(40_000);
        let runs = 0;
        let cancellations = 0;
        const server = createServer(async (request, response) => {
            let raw = "";
            for await (const chunk of request) raw += chunk;
            const input = RunAgentInputSchema.parse(JSON.parse(raw));
            response.writeHead(200, { "content-type": "text/event-stream" });
            const frame = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
            frame({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId });
            const action = input.forwardedProps?.plurnk?.action;
            if (action !== undefined) {
                if (action.kind === "loop.cancel") {
                    assert.equal(input.threadId, "actor");
                    assert.equal(input.forwardedProps.plurnk.workspace, "world");
                    assert.equal(action.reason, interrupt === "SIGINT" ? "user_sigint" : "user_sigterm");
                    cancellations += 1;
                    if (cancelMode === "interrupted") { child.kill(interrupt); return; }
                    if (cancelMode === "refused") {
                        frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: action.kind, ok: false, problem: {
                            type: "https://problems.example.test/cancel-refused", title: "Cancellation refused", status: 409,
                            detail: "Cancellation was refused by the fixture.",
                        } } });
                        frame({ type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId, outcome: { type: "success" } });
                        response.end();
                        return;
                    }
                } else assert.equal(action.kind, "worker.model.get");
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
                if (reportedFailure) frame({ type: "CUSTOM", name: "plurnk.problem", value: problem });
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
                child.kill(interrupt);
            }
        });
        const [code, signal] = await once(child, "close");
        assert.ok(signalled, stderr + stdout);
        assert.equal(code, exitCode, stderr);
        assert.equal(signal, null);
        assert.equal(cancellations, 1, "interruption explicitly cancels the same worker, including proposal-resume segments");
        if (cancelMode !== "accepted") assert.match(stderr, /Cancellation could not be confirmed:/u);
        const record = JSON.parse(stdout);
        Validator.assertOperationResult({ status: record.finalStatus, ...(record.problem === undefined ? {} : { problem: record.problem }) });
        assert.equal(record.finalStatus, problem.status, "preserve a reported failure; never invent success without terminal truth");
        assert.deepEqual(record.problem, problem, "the partial record must retain a complete, matching failure");
        assert.equal(record.response, body, "the latest observed response survives, including pipe-sized output");
        assert.equal(record.workerId, 11);
        assert.equal(record.loopId, 0, "unknown terminal coordinates are not invented");
        assert.equal(record.usage, null, "turn hints do not fabricate authoritative terminal accounting");
        assert.equal(record.turns.length, resumed ? 2 : 1);
        assert.equal(record.notices.at(-1).kind, "turn_generated");
        assert.equal(runs, resumed ? 2 : 1);
    });
}
}

test("[§cli-interrupted-record] SIGINT stops real daemon inference after a proposal resume", { timeout: 45_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service, "the composed cancellation test requires the sibling service");
    const resumed = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    let requests = 0;
    const provider = createServer(async (request, response) => {
        if (request.method !== "POST") { response.writeHead(200).end("{}"); return; }
        for await (const _chunk of request) { /* drain the request */ }
        const call = ++requests;
        response.writeHead(200, { "content-type": "text/event-stream" });
        const frame = (delta: object, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({
            id: `interrupt-${call}`, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`);
        if (call === 1) {
            frame({ role: "assistant", content: "````sh\nprintf signal-fixture\n````\n\n````WAIT\n````" });
            frame({}, "stop");
            response.end("data: [DONE]\n\n");
        } else {
            frame({ role: "assistant", reasoning_content: "The resumed inference is in progress." });
            response.once("close", () => cancelled.resolve());
            resumed.resolve();
        }
    });
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    t.after(() => { provider.closeAllConnections(); return new Promise<void>((resolve) => provider.close(() => resolve())); });
    const address = provider.address();
    assert.ok(address !== null && typeof address === "object");
    const daemon = await bootDaemon(service, { readyTimeoutMs: 30_000, extraEnv: {
        PLURNK_MODEL: "interruptfixture", PLURNK_MODEL_interruptfixture: "openai/interrupt-fixture",
        OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`, OPENAI_API_KEY: "interrupt-fixture",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768", PLURNK_PROVIDERS_EFFORT: "off", PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(() => daemon.cleanup());
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    const child = spawn(process.execPath, [resolve(import.meta.dirname, "../../bin/plurnk.js"),
        "--json", "--yolo", "--workspace", "interrupt-workspace", "--worker", "actor", "Execute and continue.",
    ], {
        cwd: daemon.workspace, env: {
            PATH: process.env.PATH, HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`,
            PLURNK_AGUI_URL: daemon.url, NO_COLOR: "1",
        }, stdio: ["ignore", "pipe", "pipe"],
    });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
    const exited = once(child, "close");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    await resumed.promise;
    child.kill("SIGINT");
    assert.deepEqual(await exited, [130, null], stderr);
    await cancelled.promise;
    assert.equal(requests, 2, "cancelling the resumed segment stops inference without another model call");
    assert.equal(JSON.parse(stdout).prompt, "Execute and continue.");
    assert.doesNotMatch(stderr, /Cancellation could not be confirmed|Could not flush/u);
});
