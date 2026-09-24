// Unit tests for the transport seam. WsTransport against a fake Rpc (persistent
// forwarding + loopId-keyed done); BridgeTransport against a mock SSE bridge
// (un-projection + done from plurnk.terminated). No live daemon.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeTransport, type RunHandlers } from "./transport.ts";
import { ProblemError } from "./diagnostics.ts";

const REVIEW_POLICY = { proposals: "review" as const };
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
    const sibling = resolve(import.meta.dirname, "../../plurnk-service/plurnk-contracts/conformance/agui-v1.json");
    const path = existsSync(sibling)
        ? sibling
        : fileURLToPath(import.meta.resolve("@plurnk/plurnk-contracts/conformance/agui-v1.json"));
    return JSON.parse(await readFile(path, "utf8")) as ConformanceKit;
};

const collectingHandlers = () => {
    const seen: { entries: unknown[]; reasoning: unknown[]; proposals: unknown[]; interactions: unknown[]; streams: unknown[]; notices: unknown[]; problems: unknown[]; terminated: unknown[]; status: unknown[] } = { entries: [], reasoning: [], proposals: [], interactions: [], streams: [], notices: [], problems: [], terminated: [], status: [] };
    const h: RunHandlers = {
        onEntry: (e) => seen.entries.push(e),
        onReasoning: (reasoning) => seen.reasoning.push(reasoning),
        onProposal: (p) => seen.proposals.push(p),
        onInteraction: (interaction) => seen.interactions.push(interaction),
        onStream: (s) => seen.streams.push(s),
        onNotice: (notice) => seen.notices.push(notice),
        onProblem: (problem) => seen.problems.push(problem),
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

test("{§cli-active-command-admission}: an action cannot replace or lend state to a concurrent model stream", async () => {
    const kit = await loadConformanceKit();
    const ordinary = kit.lifecycles.find(({ name }) => name === "ordinary-run")!.events;
    const snapshot = ordinary.find((event) => event.type === "STATE_SNAPSHOT")!;
    const terminal = ordinary.filter((event) => event.type === "RUN_FINISHED" || event.name === "plurnk.terminated");
    const ready = Promise.withResolvers<void>();
    let modelResponse: ServerResponse;
    const mock = await bootMock((_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (mock.captured.length === 1) {
            modelResponse = response;
            response.write(frame(snapshot));
            return;
        }
        const ownSnapshot = structuredClone(snapshot) as { snapshot: { plurnk: { status: { packetCount: number } } } };
        ownSnapshot.snapshot.plurnk.status.packetCount = 99;
        response.write(frame(ownSnapshot));
        response.write(frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: "providers.list", ok: true, result: { aliases: [] } } }));
        response.end(frame({ type: "RUN_FINISHED" }));
    });
    const transport = new BridgeTransport({ bridgeUrl: mock.url }, "thread");
    try {
        const { h, seen } = collectingHandlers();
        transport.subscribe({ ...h, onStatus: (status) => { seen.status.push(status); ready.resolve(); } });
        const run = transport.run("fixture", { policy: REVIEW_POLICY });
        await ready.promise;
        await transport.rpc("providers.list");
        assert.equal(seen.status.length, 1, "action status does not repaint the model's status");
        modelResponse!.write(frame({ type: "STATE_DELTA", delta: [{ op: "replace", path: "/plurnk/status/lifecycle", value: "running" }] }));
        for (const event of terminal) modelResponse!.write(frame(event));
        modelResponse!.end();
        assert.equal((await run.done).finalStatus, 200);
        const last = seen.status.at(-1) as { plurnk: { status: { lifecycle: string; packetCount: number } } };
        assert.equal(last.plurnk.status.lifecycle, "running");
        assert.equal(last.plurnk.status.packetCount, 0, "the model delta uses its own preceding snapshot");
    } finally { transport.shutdown(); await mock.close(); }
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
        res.write(frame({ type: "CUSTOM", name: "plurnk.row", value: { id: 5, op: "NOTE" } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.stream", value: { entryId: 2, state: "active" } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.notice", value: { source: "grammar", kind: "parse_advisory", level: "warn" } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { workspaceId: 7, loopId: 3, hitMaxTurns: false, turnIds: [1], result: { status: 200 } } }));
        res.write(frame({ type: "RUN_FINISHED" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th", { projectRoot: "/proj", settings: { questions: true } });
        const { h, seen } = collectingHandlers();
        bt.subscribe(h);
        const t = await bt.run("largest planet?", { policy: REVIEW_POLICY }).done;
        assert.deepEqual(seen.entries, [{ id: 5, op: "NOTE" }]);
        assert.deepEqual(seen.reasoning, [
            { phase: "start", messageId: "1/1/2/SEND/reasoning" },
            { phase: "content", messageId: "1/1/2/SEND/reasoning", delta: "checked ", content: "checked " },
            { phase: "content", messageId: "1/1/2/SEND/reasoning", delta: "the evidence", content: "checked the evidence" },
            { phase: "end", messageId: "1/1/2/SEND/reasoning", content: "checked the evidence" },
        ]);
        assert.equal((seen.notices[0] as { source: string }).source, "grammar");
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

test("{plurnk#108} BridgeTransport: a session that observes its delegation asks for descendants on every run and un-projects plurnk.descendant", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "RUN_STARTED" }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.descendant", value: { workerId: 20, name: "child", parentWorkerId: 10, depth: 1 } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.row", value: { id: 7, op: "READ", worker_id: 20 } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.terminated", value: { workspaceId: 7, loopId: 3, hitMaxTurns: false, turnIds: [1], result: { status: 200 } } }));
        res.write(frame({ type: "RUN_FINISHED" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th", { descendants: true });
        const { h, seen } = collectingHandlers();
        const introduced: unknown[] = [];
        bt.subscribe({ ...h, onDescendant: (descendant) => introduced.push(descendant) });
        await bt.run("delegate", { policy: REVIEW_POLICY }).done;
        assert.deepEqual(introduced, [{ workerId: 20, name: "child", parentWorkerId: 10, depth: 1 }], "the introduction reaches its handler");
        assert.deepEqual(seen.entries, [{ id: 7, op: "READ", worker_id: 20 }], "the descendant's row still reaches onEntry");
        assert.equal((mock.captured[0].body as { forwardedProps: { plurnk: { descendants?: boolean } } }).forwardedProps.plurnk.descendants, true, "the run asks for its delegation");
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
            res.write(frame({ type: "TOOL_CALL_ARGS", toolCallId: "prop:42", delta: JSON.stringify({ op: "sh", target: null, body: "printf done" }) }));
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

for (const order of [[42, 99], [99, 42]]) {
    test(`concurrent model and action proposals resume their own requests (${order.join(", ")})`, async () => {
        const resumed: number[] = [];
        const announced = new Map<number, ReturnType<typeof Promise.withResolvers<void>>>();
        announced.set(42, Promise.withResolvers<void>());
        announced.set(99, Promise.withResolvers<void>());
        const mock = await bootMock((_req, res) => {
            const input = mock.captured.at(-1)!.body as {
                forwardedProps?: { plurnk?: { action?: unknown } };
                resume?: Array<{ interruptId: string }>;
            };
            res.writeHead(200, { "content-type": "text/event-stream" });
            if (input.resume !== undefined) {
                const id = Number(input.resume[0]!.interruptId.slice(5));
                resumed.push(id);
                res.write(frame(id === 42
                    ? { type: "CUSTOM", name: "plurnk.terminated", value: { hitMaxTurns: false, result: { status: 200 } } }
                    : { type: "CUSTOM", name: "plurnk.action.result", value: { kind: "op.exec", ok: true, result: { status: 201 } } }));
                res.end(frame({ type: "RUN_FINISHED" }));
                return;
            }
            const id = input.forwardedProps?.plurnk?.action === undefined ? 42 : 99;
            const toolCallId = `prop:${id}`;
            res.write(frame({ type: "TOOL_CALL_START", toolCallId, toolCallName: "request_approval" }));
            res.write(frame({ type: "TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify({ op: "sh", body: `echo ${id}` }) }));
            res.write(frame({ type: "TOOL_CALL_END", toolCallId }));
            res.end(frame({ type: "RUN_FINISHED", outcome: { type: "interrupt", interrupts: [{ id: toolCallId, reason: "tool_call", toolCallId }] } }));
        });
        try {
            const transport = new BridgeTransport({ bridgeUrl: mock.url }, "worker", { workspace: "world" });
            transport.subscribe({ ...collectingHandlers().h, onProposal: (proposal) => announced.get(proposal.logEntryId)!.resolve() });
            const model = transport.run("do the work", { policy: REVIEW_POLICY }).done;
            await announced.get(42)!.promise;
            const action = transport.rpc<{ status: number }>("op.exec", { command: "echo human" });
            await announced.get(99)!.promise;
            transport.useWorker("other-worker", "other-world");
            await assert.rejects(transport.resolve({ logEntryId: 123, decision: "accept" }), /123/, "an unknown proposal cannot consume an existing continuation");
            for (const id of order) await transport.resolve({ logEntryId: id, decision: "accept" });
            assert.equal((await model).finalStatus, 200);
            assert.equal((await action).status, 201);
            assert.deepEqual(resumed.sort(), [42, 99]);
            for (const request of mock.captured) {
                const input = request.body as { threadId: string; forwardedProps: { plurnk: { workspace: string } } };
                assert.equal(input.threadId, "worker", "resumes retain the submitted conversation");
                assert.equal(input.forwardedProps.plurnk.workspace, "world", "resumes retain the submitted workspace");
            }
        } finally { await mock.close(); }
    });
}

test("BridgeTransport: inject + rpc ride §3 action runs (AG-UI+ — no /plurnk/rpc side-channel)", async () => {
    const mock = await bootMock((req, res) => {
        // An action run answers on its own SSE: result custom + RUN_FINISHED.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: "x", ok: true, result: { status: 100, action: "injected_next_turn", loopId: 7 } } }));
        res.write(frame({ type: "RUN_FINISHED" }));
        res.end();
    });
    try {
        const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th");
        assert.deepEqual(await bt.inject("steer mid-run"), { status: 100, action: "injected_next_turn", loopId: 7 });
        const providers = await bt.rpc<{ action: string }>("providers.list");
        assert.equal(providers.action, "injected_next_turn", "the action result returns verbatim");
        const injectRun = mock.captured.find((c) => c.url === "/" && (c.body as { forwardedProps?: { plurnk?: { action?: { kind: string } } } }).forwardedProps?.plurnk?.action?.kind === "loop.inject");
        assert.ok(injectRun !== undefined, "inject rides an action run");
        assert.deepEqual((injectRun?.body as { forwardedProps: { plurnk: { action: unknown } } }).forwardedProps.plurnk.action, { kind: "loop.inject", prompt: "steer mid-run" });
        const rpcRun = mock.captured.find((c) => (c.body as { forwardedProps?: { plurnk?: { action?: { kind: string } } } })?.forwardedProps?.plurnk?.action?.kind === "providers.list");
        assert.ok(rpcRun !== undefined, "verbs ride action runs");
        // A worker thread injects into ITS world: the bridge would otherwise fall back to the
        // thread name and address a world named after the worker (the 2026-09-11 dogfood).
        bt.useWorker("designer", "plurnkpromo");
        await bt.inject("what are you waiting on?");
        const workerInject = mock.captured.filter((c) => (c.body as { forwardedProps?: { plurnk?: { action?: { kind: string } } } })?.forwardedProps?.plurnk?.action?.kind === "loop.inject").at(-1);
        assert.equal((workerInject?.body as { threadId: string }).threadId, "designer");
        assert.equal((workerInject?.body as { forwardedProps: { plurnk: { workspace: string } } }).forwardedProps.plurnk.workspace, "plurnkpromo", "inject names the worker's world beside the thread");
    } finally { await mock.close(); }
});

test("{§cli-active-command-admission}: sync restores the admission gap without fabricating a terminal outcome", async () => {
    const snapshot = (await loadConformanceKit()).lifecycles.find(({ name }) => name === "ordinary-run")!.events
        .find((event) => event.type === "STATE_SNAPSHOT")!;
    const early = { id: 8, op: "SEND", origin: "model", tx: { body: "committed before attachment" } };
    const late = { id: 9, op: "NOTE", origin: "model", tx: { body: null } };
    const mock = await bootMock((_request, response) => {
        const input = mock.captured.at(-1)!.body as { messages: unknown[]; threadId: string; forwardedProps: { plurnk: { workspace: string; mode?: string; action?: object } } };
        assert.equal(input.threadId, "alice");
        assert.equal(input.forwardedProps.plurnk.workspace, "world");
        assert.deepEqual(input.messages, [], "observation does not resubmit a prompt");
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(frame({ type: "RUN_STARTED" }));
        response.write(frame(snapshot));
        if (mock.captured.length === 1) {
            assert.equal(input.forwardedProps.plurnk.mode, "sync");
            response.write(frame({ type: "CUSTOM", name: "plurnk.row", value: late }));
        } else {
            assert.deepEqual(input.forwardedProps.plurnk.action, { kind: "log.read", sinceId: 0, limit: 1000 });
            response.write(frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: "log.read", ok: true, result: { entries: [late, early] } } }));
        }
        response.end(frame({ type: "RUN_FINISHED", outcome: { type: "success" } }));
    });
    const transport = new BridgeTransport({ bridgeUrl: mock.url }, "alice", { workspace: "world" });
    try {
        const { h, seen } = collectingHandlers();
        transport.subscribe(h);
        assert.equal(await transport.observe().done, null, "a successful sync with no terminal event has no loop result");
        assert.deepEqual(seen.entries, [late, early], "a later live row cannot skip an earlier missing row or duplicate itself");
        assert.deepEqual(seen.terminated, [], "no model terminal or usage was synthesized");
        assert.deepEqual(seen.problems, []);
        assert.equal(mock.captured.length, 2, "one sync and one bounded history read");
    } finally { transport.shutdown(); await mock.close(); }
});

test("{§cli-active-command-admission}: client operation rows do not advance the conversation history cursor", async () => {
    const events = (await loadConformanceKit()).lifecycles.find(({ name }) => name === "ordinary-run")!.events;
    const previous = { id: 7, op: "SEND", origin: "model", tx: { body: "previous loop" } };
    const unseen = { id: 8, op: "SEND", origin: "model", tx: { body: "successor finished before attachment" } };
    const human = { id: 10, op: "sh", origin: "client", tx: { body: "independent client operation" } };
    const mock = await bootMock((_request, response) => {
        const input = mock.captured.at(-1)!.body as { forwardedProps: { plurnk: { mode?: string; action?: { kind: string; sinceId?: number } } } };
        const action = input.forwardedProps.plurnk.action;
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (action === undefined && input.forwardedProps.plurnk.mode === undefined) {
            for (const event of events) {
                if (event.type === "CUSTOM" && event.name === "plurnk.row") continue;
                if (event.type === "CUSTOM" && event.name === "plurnk.terminated") {
                    response.write(frame({ type: "CUSTOM", name: "plurnk.row", value: previous }));
                }
                response.write(frame(event));
            }
            response.end();
            return;
        }
        response.write(frame({ type: "RUN_STARTED" }));
        if (action?.kind === "op.exec") {
            response.write(frame({ type: "CUSTOM", name: "plurnk.row", value: human }));
            response.write(frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: action.kind, ok: true, result: { status: 200 } } }));
        } else if (action?.kind === "log.read") {
            response.write(frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: action.kind, ok: true,
                result: { entries: [previous, unseen].filter((entry) => entry.id > action.sinceId!) } } }));
        }
        response.end(frame({ type: "RUN_FINISHED", outcome: { type: "success" } }));
    });
    const transport = new BridgeTransport({ bridgeUrl: mock.url }, "world");
    try {
        const { h, seen } = collectingHandlers();
        transport.subscribe(h);
        await transport.run("first", { policy: REVIEW_POLICY }).done;
        await transport.rpc("op.exec", { command: "echo human" });
        assert.equal(await transport.observe().done, null);
        assert.deepEqual(seen.entries, [previous, human, unseen]);
    } finally { transport.shutdown(); await mock.close(); }
});

test("{§cli-active-command-admission}: injection refuses missing admission identity", async () => {
    const mock = await bootMock((_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: "loop.inject", ok: true, result: { status: 100 } } }));
        response.end(frame({ type: "RUN_FINISHED", outcome: { type: "success" } }));
    });
    try {
        const transport = new BridgeTransport({ bridgeUrl: mock.url }, "world");
        await assert.rejects(transport.inject("next"), (error: unknown) =>
            error instanceof ProblemError && error.problem.kind === "result-invalid"
                && String(error.problem.reason).includes("admission disposition"));
    } finally { await mock.close(); }
});

for (const entries of [null, [{ id: null }], Array.from({ length: 1000 }, (_, index) => ({ id: index + 1 }))]) {
    test(`{§cli-active-command-admission}: incomplete sync history is not presented (${entries?.length ?? "missing"})`, async () => {
        const mock = await bootMock((_request, response) => {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(frame({ type: "RUN_STARTED" }));
            if (mock.captured.length > 1) response.write(frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: "log.read", ok: true, result: { entries } } }));
            response.end(frame({ type: "RUN_FINISHED", outcome: { type: "success" } }));
        });
        try {
            const transport = new BridgeTransport({ bridgeUrl: mock.url }, "world");
            const { h, seen } = collectingHandlers();
            transport.subscribe(h);
            await assert.rejects(transport.observe().done, (error: unknown) =>
                error instanceof ProblemError && error.problem.kind === "result-invalid"
                    && String(error.problem.reason).includes("complete bounded history window"));
            assert.deepEqual(seen.entries, [], "a partial or malformed history is not silently admitted");
            assert.deepEqual(seen.terminated, []);
        } finally { await mock.close(); }
    });
}

test("{§cli-active-command-admission}: a dead sync stream retains its original failure without attempting history", async () => {
    const mock = await bootMock((_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(frame({ type: "RUN_STARTED" }));
    });
    try {
        const transport = new BridgeTransport({ bridgeUrl: mock.url }, "world");
        const result = await transport.observe().done;
        assert.equal(result?.result.problem?.kind, "terminal-missing");
        assert.equal(mock.captured.length, 1);
    } finally { await mock.close(); }
});

test("[§cli-conformance] run preserves explicitly requested file paths beside its policy", async () => {
    const events = (await loadConformanceKit()).lifecycles.find(({ name }) => name === "ordinary-run")!.events;
    const mock = await bootMock((_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of events) response.write(frame(event));
        response.end();
    });
    try {
        const paths = ["src/main.ts", "docs/use.md"];
        const transport = new BridgeTransport({ bridgeUrl: mock.url }, "world");
        await transport.run("inspect the referenced files", { policy: REVIEW_POLICY, openPaths: paths }).done;
        const input = mock.captured[0].body as { forwardedProps: { plurnk: { policy: unknown; openPaths: unknown } } };
        assert.deepEqual(input.forwardedProps.plurnk.openPaths, paths);
        assert.deepEqual(input.forwardedProps.plurnk.policy, REVIEW_POLICY);
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

test("cancelling a model run waiting for a proposal settles it and retires its resolver", async () => {
    const ready = Promise.withResolvers<void>();
    const mock = await bootMock((_req, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(frame({ type: "TOOL_CALL_START", toolCallId: "prop:17", toolCallName: "request_approval" }));
        response.write(frame({ type: "TOOL_CALL_ARGS", toolCallId: "prop:17", delta: '{"op":"sh"}' }));
        response.write(frame({ type: "TOOL_CALL_END", toolCallId: "prop:17" }));
        response.end(frame({ type: "RUN_FINISHED", outcome: { type: "interrupt", interrupts: [{ id: "prop:17", reason: "tool_call" }] } }));
    });
    try {
        const transport = new BridgeTransport({ bridgeUrl: mock.url }, "worker");
        transport.subscribe({ ...collectingHandlers().h, onProposal: () => ready.resolve() });
        const run = transport.run("review", { policy: REVIEW_POLICY });
        await ready.promise;
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        run.cancel();
        assert.equal((await run.done).finalStatus, 499);
        await assert.rejects(transport.resolve({ logEntryId: 17, decision: "accept" }), /Proposal 17 has no pending/);
        assert.equal(mock.captured.length, 1, "cancel never submits a resume to execute the proposal");
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
        await assert.rejects(bt.resolveInteraction(7, { repository: "wrong-request" }), /Interaction 7 has no pending AG-UI interrupt\./u);
        assert.equal(mock.captured.length, 1, "a stale UI callback cannot answer the active interrupt");
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
            res.write(frame({ type: "TOOL_CALL_ARGS", toolCallId: "prop:575", delta: JSON.stringify({ op: "sh", target: null, body: "gh issue view 573" }) }));
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
    await assert.rejects(() => bt.resolve({ logEntryId: 1, decision: "accept" }), /Proposal 1 has no pending AG-UI interrupt\./);
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

test("[§cli-workspaces-and-workers] every request preserves rooted, headless, or unspecified creation options", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "CUSTOM", name: "plurnk.action.result", value: { kind: "worker.model.get", ok: true, result: { model: null } } }));
        res.write(frame({ type: "RUN_FINISHED" }));
        res.end();
    });
    try {
        for (const projectRoot of ["/home/user/repo", null, undefined]) {
            mock.captured.length = 0;
            const bt = new BridgeTransport({ bridgeUrl: mock.url }, "th", {
                projectRoot, settings: { capabilities: { deny: [{ runtime: "sh" }] } },
            });
            await bt.rpc("worker.model.get");
            await bt.rpc("worker.model.get");
            assert.equal(mock.captured.length, 2);
            for (const c of mock.captured) {
                const fp = (c.body as { forwardedProps: { plurnk: Record<string, unknown> } }).forwardedProps.plurnk;
                assert.equal(fp.projectRoot, projectRoot, "creation intent survives whichever request arrives first");
                assert.equal(Object.hasOwn(fp, "projectRoot"), projectRoot !== undefined);
                assert.deepEqual(fp.settings, { capabilities: { deny: [{ runtime: "sh" }] } });
            }
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
        await bt.run("first", { policy: { proposals: "accept" } }).done;
        await bt.run("second", { policy: { proposals: "review" } }).done;
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
                { proposals: "accept" },
                { proposals: "review" },
            ],
        );
    } finally { await mock.close(); }
});
