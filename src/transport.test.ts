// Unit tests for the transport seam. WsTransport against a fake Rpc (persistent
// forwarding + loopId-keyed done); BridgeTransport against a mock SSE bridge
// (un-projection + done from plurnk.terminated). No live daemon.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeTransport, type RunHandlers } from "./transport.ts";
import { ProblemError } from "./diagnostics.ts";

const REVIEW_POLICY = { capabilities: {}, proposals: "review" as const };
import { runViaBridge } from "./agui.ts";

interface ConformanceKit {
    schemaVersion: number;
    transport: Array<{
        name: string;
        chunks: string[];
        eof: boolean;
        expect: { events: Array<Record<string, unknown>> } | { error: "invalid-json" };
    }>;
    lifecycles: Array<{
        name: string;
        events: Array<Record<string, unknown>>;
        expect: {
            completion: "success" | "interrupt" | "error" | "dead-stream";
            families: string[];
            status?: number;
            interrupt?: "proposal" | "interaction";
            action?: { kind: string; ok: boolean; status?: number };
        };
    }>;
}

const loadConformanceKit = async (): Promise<ConformanceKit> => {
    let path: string;
    try {
        path = fileURLToPath(import.meta.resolve("@plurnk/plurnk-contracts/conformance/agui-v1.json"));
    } catch {
        path = resolve(import.meta.dirname, "../../plurnk-service/plurnk-contracts/conformance/agui-v1.json");
    }
    return JSON.parse(await readFile(path, "utf8")) as ConformanceKit;
};

const collectingHandlers = () => {
    const seen: { entries: unknown[]; reasoning: unknown[]; proposals: unknown[]; interactions: unknown[]; streams: unknown[]; notices: unknown[]; problems: unknown[]; branches: unknown[]; terminated: unknown[]; status: unknown[] } = { entries: [], reasoning: [], proposals: [], interactions: [], streams: [], notices: [], problems: [], branches: [], terminated: [], status: [] };
    const h: RunHandlers = {
        onEntry: (e) => seen.entries.push(e),
        onReasoning: (reasoning) => seen.reasoning.push(reasoning),
        onProposal: (p) => seen.proposals.push(p),
        onInteraction: (interaction) => seen.interactions.push(interaction),
        onStream: (s) => seen.streams.push(s),
        onNotice: (notice) => seen.notices.push(notice),
        onProblem: (problem) => seen.problems.push(problem),
        onBranchBatch: (event) => seen.branches.push(event),
        onTerminated: (t) => seen.terminated.push(t),
        onStatus: (gauge) => seen.status.push(gauge),
    };
    return { h, seen };
};

// ── BridgeTransport ──────────────────────────────────────────────────

const bootMock = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
    const captured: Array<{ url: string | undefined; body: unknown }> = [];
    const server = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => { captured.push({ url: req.url, body: body.length > 0 ? JSON.parse(body) : null }); handler(req, res); });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    return { url: `http://127.0.0.1:${port}`, captured, close: () => new Promise<void>((r) => server.close(() => r())) };
};
const frame = (event: Record<string, unknown>): string => {
    const lifecycle = event.type === "RUN_STARTED" || event.type === "RUN_FINISHED"
        ? { threadId: "th", runId: "r", ...event }
        : event;
    return `data: ${JSON.stringify(lifecycle)}\n\n`;
};

test("{§cli-agui-conformance}: the official AG-UI transport consumes every shared SSE specimen", async (t) => {
    const kit = await loadConformanceKit();
    assert.equal(kit.schemaVersion, 1);
    for (const specimen of kit.transport) {
        await t.test(specimen.name, async () => {
            const mock = await bootMock((_req, res) => {
                res.writeHead(200, { "content-type": "text/event-stream" });
                const chunks = [...specimen.chunks];
                const write = (): void => {
                    const chunk = chunks.shift();
                    if (chunk === undefined) { res.end(); return; }
                    res.write(chunk);
                    setImmediate(write);
                };
                write();
            });
            try {
                const events: unknown[] = [];
                const consume = async (): Promise<void> => {
                    for await (const event of runViaBridge(
                        { bridgeUrl: mock.url },
                        { threadId: "fixture", messages: [] },
                    )) events.push(event);
                };
                if ("error" in specimen.expect) {
                    await assert.rejects(consume, /JSON|parse|event/i);
                } else {
                    await consume();
                    assert.deepEqual(events, specimen.expect.events);
                }
            } finally {
                await mock.close();
            }
        });
    }
});

test("{§cli-agui-conformance}: BridgeTransport consumes every shared lifecycle specimen", async (t) => {
    const kit = await loadConformanceKit();
    const terminalContinuation = kit.lifecycles
        .find(({ name }) => name === "ordinary-run")!
        .events.filter((event) => event.type === "RUN_FINISHED" || (event.type === "CUSTOM" && (event as { name?: string }).name === "plurnk.terminated"));

    for (const specimen of kit.lifecycles) {
        await t.test(specimen.name, async () => {
            let request = 0;
            const mock = await bootMock((_req, res) => {
                request += 1;
                res.writeHead(200, { "content-type": "text/event-stream" });
                const events = request === 1 ? specimen.events : terminalContinuation;
                for (const event of events) res.write(frame(event));
                res.end();
            });
            try {
                const transport = new BridgeTransport({ bridgeUrl: mock.url }, "fixture");
                const { h, seen } = collectingHandlers();
                transport.subscribe({
                    ...h,
                    onProposal: (proposal) => {
                        seen.proposals.push(proposal);
                        void transport.resolve({ logEntryId: proposal.logEntryId, decision: "accept" });
                    },
                    onInteraction: (interaction) => {
                        seen.interactions.push(interaction);
                        void transport.resolveInteraction(interaction.interactionId, { answer: "yes" });
                    },
                });

                if (specimen.expect.action !== undefined) {
                    if (specimen.expect.action.ok) {
                        const result = await transport.rpc<Record<string, unknown>>(specimen.expect.action.kind);
                        if (specimen.expect.action.status !== undefined) {
                            assert.equal(result.status, specimen.expect.action.status);
                        }
                    } else {
                        await assert.rejects(
                            () => transport.rpc(specimen.expect.action!.kind),
                            (error: unknown) => error instanceof ProblemError
                                && error.problem.status === specimen.expect.action!.status,
                        );
                    }
                } else {
                    const result = await transport.run("fixture", { policy: REVIEW_POLICY }).done;
                    assert.equal(
                        result.finalStatus,
                        specimen.expect.completion === "interrupt" ? 200 : specimen.expect.status,
                    );
                }

                const families = new Set<string>();
                if (seen.entries.length > 0) families.add("log/entry");
                if (seen.status.length > 0) families.add("loop/packet");
                if (seen.proposals.length > 0) families.add("loop/proposal");
                if (seen.interactions.length > 0) families.add("loop/interaction");
                if (seen.reasoning.length > 0) families.add("reasoning/event");
                if (seen.notices.length > 0) families.add("notice/event");
                if (seen.problems.length > 0) families.add("problem/event");
                if (seen.branches.length > 0) families.add("workspace/branch-batch");
                if (seen.streams.some((value) => "result" in (value as object))) families.add("stream/concluded");
                if (seen.streams.some((value) => !("result" in (value as object)))) families.add("stream/event");
                if (seen.terminated.length > 0) families.add("loop/terminated");
                for (const family of specimen.expect.families) {
                    assert.ok(families.has(family), `${specimen.name} projects ${family}`);
                }
                if (specimen.expect.interrupt !== undefined) assert.equal(request, 2, "the interrupt resumed once");
            } finally {
                await mock.close();
            }
        });
    }
});

test("{§cli-agui-conformance}: the status gauge is the snapshot patched by each STATE_DELTA", async () => {
    const kit = await loadConformanceKit();
    const ordinary = kit.lifecycles.find(({ name }) => name === "ordinary-run")!;
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of ordinary.events) res.write(frame(event));
        res.end();
    });
    try {
        const transport = new BridgeTransport({ bridgeUrl: mock.url }, "fixture");
        const { h, seen } = collectingHandlers();
        transport.subscribe(h);
        const result = await transport.run("fixture", { policy: REVIEW_POLICY }).done;
        assert.equal(result.finalStatus, 200);
        const gauges = seen.status as Array<{ plurnk: { status: { lifecycle: string; loopId: number | null; packetCount: number } } }>;
        assert.equal(gauges.length, 3, "one gauge per STATE_SNAPSHOT and STATE_DELTA");
        assert.deepEqual(gauges.map((g) => g.plurnk.status.lifecycle), ["idle", "running", "completed"]);
        assert.deepEqual(gauges.map((g) => g.plurnk.status.packetCount), [0, 1, 1]);
        assert.equal(gauges[2]!.plurnk.status.loopId, 1);
    } finally {
        await mock.close();
    }
});

test("{§cli-agui-conformance}: a STATE_DELTA before any snapshot is a 502 state-invalid Problem", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "RUN_STARTED", threadId: "fixture", runId: "r1" }));
        res.write(frame({ type: "STATE_DELTA", delta: [{ op: "replace", path: "/plurnk/status/packetCount", value: 1 }] }));
        res.end();
    });
    try {
        const transport = new BridgeTransport({ bridgeUrl: mock.url }, "fixture");
        transport.subscribe(collectingHandlers().h);
        await assert.rejects(
            () => transport.run("fixture", { policy: REVIEW_POLICY }).done,
            (error: unknown) => error instanceof ProblemError && error.problem.status === 502 && error.problem.kind === "state-invalid",
        );
    } finally {
        await mock.close();
    }
});

test("[§cli-conformance] BridgeTransport: run() un-projects plurnk.* to daemon shapes; done resolves from plurnk.terminated", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "generic", delta: "generic-ignored" }));
        res.write(frame({ type: "REASONING_START", messageId: "1/1/2/SEND/reasoning" }));
        res.write(frame({ type: "REASONING_MESSAGE_START", messageId: "1/1/2/SEND/reasoning", role: "reasoning" }));
        res.write(frame({ type: "REASONING_MESSAGE_CONTENT", messageId: "1/1/2/SEND/reasoning", delta: "checked " }));
        res.write(frame({ type: "REASONING_MESSAGE_CONTENT", messageId: "1/1/2/SEND/reasoning", delta: "the evidence" }));
        res.write(frame({ type: "REASONING_MESSAGE_END", messageId: "1/1/2/SEND/reasoning" }));
        res.write(frame({ type: "REASONING_END", messageId: "1/1/2/SEND/reasoning" }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.row", value: { id: 5, op: "PLAN" } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.stream", value: { entryId: 2, state: "active" } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.notice", value: { source: "grammar", kind: "parse_advisory", level: "warn" } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.branch_batch", value: { batchId: 9, state: "running", branch: "feature/x", completed: 1, total: 2 } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { workspaceId: 7, loopId: 3, hitMaxTurns: false, turnIds: [1], result: { status: 200 } } }));
        res.write(frame({ type: "RUN_FINISHED" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th", { projectRoot: "/proj", settings: { questions: true } });
        const { h, seen } = collectingHandlers();
        bt.subscribe(h);
        const t = await bt.run("largest planet?", { policy: REVIEW_POLICY }).done;
        assert.deepEqual(seen.entries, [{ id: 5, op: "PLAN" }]);
        assert.deepEqual(seen.reasoning, [
            { phase: "start", messageId: "1/1/2/SEND/reasoning" },
            { phase: "content", messageId: "1/1/2/SEND/reasoning", delta: "checked ", content: "checked " },
            { phase: "content", messageId: "1/1/2/SEND/reasoning", delta: "the evidence", content: "checked the evidence" },
            { phase: "end", messageId: "1/1/2/SEND/reasoning", content: "checked the evidence" },
        ]);
        assert.equal((seen.notices[0] as { source: string }).source, "grammar");
        assert.deepEqual(seen.branches, [{ batchId: 9, state: "running", branch: "feature/x", completed: 1, total: 2 }]);
        assert.equal(seen.entries.length, 1, "the generic TEXT_MESSAGE was ignored");
        assert.equal(t.workspaceId, 7, "done resolves with the terminated outcome incl. workspaceId");
        assert.deepEqual((mock.captured[0].body as { forwardedProps: unknown }).forwardedProps, {
            plurnk: {
                workspace: "th",
                projectRoot: "/proj",
                settings: { questions: true },
                policy: REVIEW_POLICY,
            },
        }, "the workspace (world) + options and loop policy ride the first run's forwardedProps");
    } finally { await mock.close(); }
});

test("BridgeTransport: plurnk.problem supplies the exact terminal status instead of parsing RUN_ERROR.code", async () => {
    const problem = {
        type: "https://problems.plurnk.xyz/engine/rails/max-turns",
        title: "Max turns",
        status: 429,
        detail: "The configured turn ceiling is exhausted.",
        maximumTurns: 8,
        retryable: false,
    };
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "CUSTOM", name: "plurnk.problem", value: problem }));
        res.write(frame({ type: "RUN_ERROR", message: problem.detail, code: problem.type }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        const { h, seen } = collectingHandlers();
        bt.subscribe(h);
        const result = await bt.run("go", { policy: REVIEW_POLICY }).done;
        assert.equal(result.finalStatus, 429);
        assert.deepEqual(seen.problems, [problem]);
    } finally { await mock.close(); }
});

test("BridgeTransport: RUN_ERROR without the exact Problem returns a client contract Problem", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "RUN_ERROR", message: "loop terminated 429", code: "429" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        const { h } = collectingHandlers();
        bt.subscribe(h);
        const result = await bt.run("go", { policy: REVIEW_POLICY }).done;
        assert.equal(result.finalStatus, 502);
        assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/client/transport/problem-missing");
    } finally { await mock.close(); }
});

test("BridgeTransport: plurnk.terminated.result is the ordinary terminal truth", async () => {
    const problem = {
        type: "https://problems.plurnk.xyz/lifecycle/cancel/loop-cancelled",
        title: "Loop cancelled",
        status: 499,
        detail: "The loop was cancelled.",
        retryable: false,
    };
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({
            type: "CUSTOM",
            name: "plurnk.terminated",
            value: {
                workspaceId: 7,
                loopId: 3,
                hitMaxTurns: false,
                turnIds: [1],
                result: { status: problem.status, problem },
            },
        }));
        res.write(frame({ type: "RUN_ERROR", message: problem.detail, code: problem.type }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        const { h, seen } = collectingHandlers();
        bt.subscribe(h);
        const result = await bt.run("go", { policy: REVIEW_POLICY }).done;
        assert.equal(result.finalStatus, 499);
        assert.deepEqual(result.result, { status: 499, problem });
        assert.deepEqual(seen.problems, [problem]);
    } finally { await mock.close(); }
});

test("BridgeTransport.rpc: an action failure throws its exact Problem", async () => {
    const problem = {
        type: "https://problems.plurnk.xyz/agui/action/unknown-action",
        title: "Unknown action",
        status: 404,
        detail: "Unknown action 'missing'.",
        retryable: false,
    };
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: "missing", ok: false, problem } }));
        res.write(frame({ type: "RUN_FINISHED" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        await assert.rejects(
            () => bt.rpc("missing"),
            (error: unknown) => error instanceof ProblemError && error.problem.type === problem.type,
        );
    } finally { await mock.close(); }
});

test("BridgeTransport.rpc: a proposal-gated action resumes and returns its result", async () => {
    let call = 0;
    const mock = await bootMock((_req, res) => {
        call += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (call === 1) {
            res.write(frame({ type: "TOOL_CALL_START", toolCallId: "prop:42", toolCallName: "request_approval" }));
            res.write(frame({ type: "TOOL_CALL_ARGS", toolCallId: "prop:42", delta: JSON.stringify({ op: "EXEC", target: null, body: "printf done" }) }));
            res.write(frame({ type: "TOOL_CALL_END", toolCallId: "prop:42" }));
            res.write(frame({ type: "RUN_FINISHED", outcome: { type: "interrupt", interrupts: [{ id: "prop:42", reason: "tool_call", toolCallId: "prop:42" }] } }));
        } else {
            res.write(frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: "op.exec", ok: true, result: { status: 200 } } }));
            res.write(frame({ type: "RUN_FINISHED" }));
        }
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        const { h, seen } = collectingHandlers();
        bt.subscribe({
            ...h,
            onProposal: (proposal) => {
                seen.proposals.push(proposal);
                void bt.resolve({ logEntryId: proposal.logEntryId, decision: "accept", outcome: "client_yolo" });
            },
        });
        assert.deepEqual(await bt.rpc("op.exec", { command: "printf done" }), { status: 200 });
        assert.equal(seen.proposals.length, 1);
        assert.equal(call, 2);
        const resume = mock.captured[1].body as { resume: Array<{ interruptId: string; status: string; payload: unknown }> };
        assert.deepEqual(resume.resume, [{ interruptId: "prop:42", status: "resolved", payload: { decision: "accept" } }]);
    } finally { await mock.close(); }
});

test("BridgeTransport.rpc: an action stream without a result or interrupt fails explicitly", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "RUN_FINISHED" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        await assert.rejects(
            () => bt.rpc("op.exec", { command: "printf done" }),
            (error: unknown) => error instanceof ProblemError
                && error.problem.type === "https://problems.plurnk.xyz/client/action/result-missing",
        );
    } finally { await mock.close(); }
});

test("BridgeTransport: inject + rpc ride §3 action runs (AG-UI+ — no /plurnk/rpc side-channel)", async () => {
    const mock = await bootMock((req, res) => {
        // An action run answers on its own SSE: result custom + RUN_FINISHED.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: "x", ok: true, result: { action: "injected_next_turn", loopId: 7 } } }));
        res.write(frame({ type: "RUN_FINISHED" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        await bt.inject("steer mid-run");
        const providers = await bt.rpc<{ action: string }>("providers.list");
        assert.equal(providers.action, "injected_next_turn", "the action result returns verbatim");
        const injectRun = mock.captured.find((c) => c.url === "/" && (c.body as { forwardedProps?: { plurnk?: { action?: { kind: string } } } }).forwardedProps?.plurnk?.action?.kind === "loop.inject");
        assert.ok(injectRun !== undefined, "inject rides an action run");
        assert.deepEqual((injectRun?.body as { forwardedProps: { plurnk: { action: unknown } } }).forwardedProps.plurnk.action, { kind: "loop.inject", prompt: "steer mid-run" });
        const rpcRun = mock.captured.find((c) => (c.body as { forwardedProps?: { plurnk?: { action?: { kind: string } } } })?.forwardedProps?.plurnk?.action?.kind === "providers.list");
        assert.ok(rpcRun !== undefined, "verbs ride action runs");
    } finally { await mock.close(); }
});

test("[§cli-cancellation] BridgeTransport: cancel() aborts the SSE and done resolves (499), not a throw", async () => {
    const mock = await bootMock((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(frame({ type: "RUN_STARTED" })); });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        bt.subscribe(collectingHandlers().h);
        const handle = bt.run("go", { policy: REVIEW_POLICY });
        await new Promise((r) => setTimeout(r, 50));
        handle.cancel();
        assert.equal((await handle.done).finalStatus, 499, "cancel → clean 499 outcome");
    } finally { await mock.close(); }
});

test("BridgeTransport.useSession: re-maps the threadId — the next run addresses the new workspace", async () => {
    const mock = await bootMock((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { hitMaxTurns: false, result: { status: 200 } } })); res.write(frame({ type: "RUN_FINISHED" })); res.end(); });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "old");
        const s = await bt.useSession("new-thread", {});
        assert.equal(s.name, "new-thread");
        bt.subscribe(collectingHandlers().h);
        await bt.run("go", { policy: REVIEW_POLICY }).done;
        assert.equal((mock.captured[0].body as { threadId: string }).threadId, "new-thread", "the run targets the re-mapped thread");
    } finally { await mock.close(); }
});

test("BridgeTransport: terminate-resume — a proposal tool-call pauses done; resolve() resumes with the tool-result", async () => {
    let call = 0;
    const mock = await bootMock((_req, res) => {
        call += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (call === 1) {
            res.write(frame({ type: "TOOL_CALL_START", toolCallId: "prop:42", toolCallName: "request_approval" }));
            res.write(frame({ type: "TOOL_CALL_ARGS", toolCallId: "prop:42", delta: JSON.stringify({ op: "EDIT", target: { scheme: "file", pathname: "a.ts" }, body: "diff" }) }));
            res.write(frame({ type: "TOOL_CALL_END", toolCallId: "prop:42" }));
            res.write(frame({ type: "RUN_FINISHED", threadId: "th", runId: "r1", outcome: { type: "interrupt", interrupts: [{ id: "prop:42", reason: "tool_call", toolCallId: "prop:42" }] } }));
        } else {
            res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { hitMaxTurns: false, turnIds: [1], result: { status: 200 } } }));
            res.write(frame({ type: "RUN_FINISHED" }));
        }
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        const { h, seen } = collectingHandlers();
        bt.subscribe(h);
        const handle = bt.run("edit it", { policy: REVIEW_POLICY });
        // the proposal surfaces mid-run as an unprojected tool-call
        while (seen.proposals.length === 0) await new Promise((r) => setTimeout(r, 10));
        assert.equal((seen.proposals[0] as { logEntryId: number; op: string }).logEntryId, 42);
        assert.equal((seen.proposals[0] as { op: string }).op, "EDIT");
        await bt.resolve({ logEntryId: 42, decision: "accept", body: "edited" });
        const t = await handle.done;
        assert.equal(t.finalStatus, 200, "done spans the pause/resume chain");
        const resume = mock.captured[1].body as { resume: Array<{ interruptId: string; status: string; payload: unknown }> };
        assert.deepEqual(resume.resume, [{ interruptId: "prop:42", status: "resolved", payload: { decision: "accept", body: "edited" } }], "the standard resume carries the decision + edited body");
    } finally { await mock.close(); }
});

test("BridgeTransport: a client interaction uses interrupt guidance and resumes with the answer", async () => {
    let call = 0;
    const responseSchema = {
        type: "object",
        required: ["repository"],
        properties: { repository: { enum: ["plurnk-service", "plurnk"] } },
    };
    const mock = await bootMock((_req, res) => {
        call += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (call === 1) {
            res.write(frame({ type: "TOOL_CALL_START", toolCallId: "int:8", toolCallName: "select_repository" }));
            res.write(frame({ type: "TOOL_CALL_ARGS", toolCallId: "int:8", delta: JSON.stringify({ owner: "plurnk" }) }));
            res.write(frame({ type: "TOOL_CALL_END", toolCallId: "int:8" }));
            res.write(frame({
                type: "RUN_FINISHED",
                outcome: {
                    type: "interrupt",
                    interrupts: [{
                        id: "int:8",
                        reason: "tool_call",
                        toolCallId: "int:8",
                        message: "Choose one repository.",
                        responseSchema,
                    }],
                },
            }));
        } else {
            res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { hitMaxTurns: false, turnIds: [2], result: { status: 200 } } }));
            res.write(frame({ type: "RUN_FINISHED" }));
        }
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        const { h, seen } = collectingHandlers();
        bt.subscribe(h);
        const handle = bt.run("choose", { policy: REVIEW_POLICY });
        while (seen.interactions.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.deepEqual(seen.interactions, [{
            interactionId: 8,
            toolName: "select_repository",
            arguments: { owner: "plurnk" },
            message: "Choose one repository.",
            responseSchema,
        }]);
        await bt.resolveInteraction(8, { repository: "plurnk-service" });
        assert.equal((await handle.done).finalStatus, 200);
        const resume = mock.captured[1].body as { resume: Array<{ interruptId: string; status: string; payload: unknown }> };
        assert.deepEqual(resume.resume, [{
            interruptId: "int:8",
            status: "resolved",
            payload: { repository: "plurnk-service" },
        }]);
    } finally { await mock.close(); }
});

test("BridgeTransport: a proposal without the matching interrupt outcome returns an exact Problem", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "TOOL_CALL_START", toolCallId: "prop:42", toolCallName: "request_approval" }));
        res.write(frame({ type: "TOOL_CALL_ARGS", toolCallId: "prop:42", delta: JSON.stringify({ op: "EDIT", target: {}, body: "diff" }) }));
        res.write(frame({ type: "TOOL_CALL_END", toolCallId: "prop:42" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        const { h, seen } = collectingHandlers();
        bt.subscribe(h);
        const result = await bt.run("edit it", { policy: REVIEW_POLICY }).done;
        assert.equal(result.finalStatus, 502);
        assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/client/transport/interrupt-mismatch");
        assert.deepEqual(seen.problems, [result.result.problem]);
    } finally { await mock.close(); }
});

test("BridgeTransport: malformed proposal arguments return an exact Problem", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "TOOL_CALL_START", toolCallId: "prop:42", toolCallName: "request_approval" }));
        res.write(frame({ type: "TOOL_CALL_ARGS", toolCallId: "prop:42", delta: "{" }));
        res.write(frame({ type: "TOOL_CALL_END", toolCallId: "prop:42" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        const { h, seen } = collectingHandlers();
        bt.subscribe(h);
        const result = await bt.run("edit it", { policy: REVIEW_POLICY }).done;
        assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/client/transport/proposal-invalid");
        assert.deepEqual(seen.problems, [result.result.problem]);
    } finally { await mock.close(); }
});

test("[§cli-yolo-plurnkyolo] BridgeTransport: proposal can resolve synchronously from onProposal", async () => {
    let call = 0;
    const mock = await bootMock((_req, res) => {
        call += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (call === 1) {
            res.write(frame({ type: "TOOL_CALL_START", toolCallId: "prop:575", toolCallName: "request_approval" }));
            res.write(frame({ type: "TOOL_CALL_ARGS", toolCallId: "prop:575", delta: JSON.stringify({ op: "EXEC", target: null, body: "gh issue view 573" }) }));
            res.write(frame({ type: "TOOL_CALL_END", toolCallId: "prop:575" }));
            res.write(frame({ type: "RUN_FINISHED", threadId: "th", runId: "r1", outcome: { type: "interrupt", interrupts: [{ id: "prop:575", reason: "tool_call", toolCallId: "prop:575" }] } }));
        } else {
            res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { hitMaxTurns: false, turnIds: [2], result: { status: 200 } } }));
            res.write(frame({ type: "RUN_FINISHED" }));
        }
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        const { h } = collectingHandlers();
        bt.subscribe({
            ...h,
            onProposal: (p) => { void bt.resolve({ logEntryId: p.logEntryId, decision: "accept", outcome: "client_yolo" }); },
        });
        const t = await bt.run("exec it", { policy: REVIEW_POLICY }).done;
        assert.equal(t.finalStatus, 200, "immediate yolo resolution resumes and finishes the loop");
        assert.equal(call, 2, "the proposal segment is followed by one resume segment");
        const resume = mock.captured[1].body as { resume: Array<{ interruptId: string; status: string; payload: unknown }> };
        assert.deepEqual(resume.resume, [{ interruptId: "prop:575", status: "resolved", payload: { decision: "accept" } }]);
    } finally { await mock.close(); }
});

test("BridgeTransport: resolve without a delivered interrupt fails hard", async () => {
    const bt = new BridgeTransport({ bridgeUrl: "http://127.0.0.1:1" }, "th");
    await assert.rejects(() => bt.resolve({ logEntryId: 1, decision: "accept" }), /without a delivered AG-UI interrupt/);
});

test("BridgeTransport: a stream that dies without terminal truth is an ERROR, never a fabricated 200", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "RUN_STARTED" }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.row", value: { id: 1, op: "READ" } }));
        res.end();   // no plurnk.terminated, no RUN_ERROR — the stream just dies
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        bt.subscribe(collectingHandlers().h);
        const t = await bt.run("go", { policy: REVIEW_POLICY }).done;
        assert.equal(t.finalStatus, 502, "silent stream death surfaces as 502, not success");
    } finally { await mock.close(); }
});

test("[§cli-workspaces-and-workers] EVERY request carries the workspace options — creation is atomic with the projectRoot whichever request wins (#140)", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: "workspace.prompts", ok: true, result: { prompts: [] } } }));
        res.write(frame({ type: "RUN_FINISHED" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th", { projectRoot: "/home/user/repo", settings: { capabilities: { deny: [{ runtime: "sh" }] } } });
        await bt.rpc("workspace.prompts", { limit: 50 });   // the TUI's real first touch (seedPromptHistory)
        await bt.rpc("workspace.prompts", { limit: 50 });   // and the SECOND — no consumed-once race
        for (const c of mock.captured) {
            const fp = (c.body as { forwardedProps: { plurnk: Record<string, unknown> } }).forwardedProps.plurnk;
            assert.equal(fp.projectRoot, "/home/user/repo", "projectRoot rides EVERY request — whichever creates, creates rooted");
            assert.deepEqual(fp.settings, { capabilities: { deny: [{ runtime: "sh" }] } });
        }
    } finally { await mock.close(); }
});

test("[§cli-model-selection] model policy never rides an individual loop", async () => {
    // Model and child-model policy are changed once through worker actions. Keeping
    // them structurally absent from RunOpts prevents a second per-loop authority.
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { hitMaxTurns: false, turnIds: [1], result: { status: 200 } } }));
        res.write(frame({ type: "RUN_FINISHED" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        bt.subscribe(collectingHandlers().h);
        await bt.run("first", { policy: { capabilities: {}, proposals: "accept" } }).done;
        await bt.run("second", { policy: { capabilities: {}, proposals: "review" } }).done;
        const runs = mock.captured.filter((c) => (c.body as { messages?: unknown[] }).messages !== undefined && ((c.body as { messages: unknown[] }).messages.length > 0 || (c.body as { forwardedProps?: { plurnk?: { action?: unknown } } }).forwardedProps?.plurnk?.action === undefined));
        assert.equal(runs.length, 2, "two loops drove");
        for (const c of runs) {
            const fp = (c.body as { forwardedProps: { plurnk: Record<string, unknown> } }).forwardedProps.plurnk;
            for (const retired of ["alias", "model", "selector", "childAlias", "childModel", "childSelector"]) {
                assert.equal(Object.hasOwn(fp, retired), false, `${retired} is worker policy, not a loop knob`);
            }
        }
        assert.deepEqual(
            runs.map((c) => (c.body as { forwardedProps: { plurnk: { policy: unknown } } }).forwardedProps.plurnk.policy),
            [
                { capabilities: {}, proposals: "accept" },
                { capabilities: {}, proposals: "review" },
            ],
        );
    } finally { await mock.close(); }
});
