// Unit tests for the transport seam: AguiTransport against a mock AG-UI endpoint
// (un-projection + done from the Run's end). No live daemon.

import { servicePath } from "../test/service-checkout.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AguiTransport, type RunHandlers } from "./transport.ts";
import { ProblemError } from "./diagnostics.ts";

import { runViaAgui } from "./agui.ts";
import { wholeRow } from "./rows.ts";
import type { LogEntryWire } from "./render.ts";
import { ambientOf, partsOf } from "../test/agui-parts.ts";

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
    const sibling = servicePath("plurnk-contracts/conformance/agui-v1.json");
    const path = existsSync(sibling)
        ? sibling
        : fileURLToPath(import.meta.resolve("@plurnk/plurnk-contracts/conformance/agui-v1.json"));
    return JSON.parse(await readFile(path, "utf8")) as ConformanceKit;
};

const collectingHandlers = () => {
    const seen: { entries: unknown[]; reasoning: unknown[]; proposals: unknown[]; interactions: unknown[]; streams: unknown[]; notices: unknown[]; problems: unknown[]; terminated: unknown[]; status: unknown[]; outside: unknown[] } = { entries: [], reasoning: [], proposals: [], interactions: [], streams: [], notices: [], problems: [], terminated: [], status: [], outside: [] };
    const h: RunHandlers = {
        onEntry: (e) => seen.entries.push(e),
        onHistory: (history) => seen.entries.push(...history.entries),
        onOutside: (outside) => seen.outside.push(outside),
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

// ── AguiTransport ──────────────────────────────────────────────────

// A row as the daemon records it, whole (log.read answers these), and the parts it builds live
// (plurnk-service `{§agui-projection}`).
type WireRow = Record<string, unknown> & { id: number; op: string };
const wire = (over: WireRow): WireRow => ({
    worker_id: 1, loop_seq: 1, turn_seq: 1, sequence: over.id, origin: "model", source: null, signal: null,
    scheme: null, hostname: null, pathname: null, fragment: null, lineMarker: null, tx: null, rx: { status: 200 }, status_rx: 200, attrs: {}, ...over,
});
const live = (row: WireRow): Array<Record<string, unknown>> => partsOf(wholeRow(row)!) as unknown as Array<Record<string, unknown>>;
// The rows a handler observed, by durable identity and operation.
const drawn = (entries: readonly unknown[]): string[] => (entries as LogEntryWire[]).map(({ id, op }) => `${id} ${op}`);

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
                    for await (const event of runViaAgui(
                        { aguiUrl: mock.url },
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

test("{§cli-agui-conformance}: AguiTransport consumes every shared lifecycle specimen", async (t) => {
    const kit = await loadConformanceKit();
    const terminalContinuation = kit.lifecycles
        .find(({ name }) => name === "ordinary-run")!
        .events.filter((event) => event.type === "RUN_FINISHED");

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
                const transport = new AguiTransport({ aguiUrl: mock.url }, "fixture");
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
                    const result = await transport.run("fixture", {}).done;
                    assert.equal(
                        result.finalStatus,
                        specimen.expect.completion === "interrupt" ? 200 : specimen.expect.status,
                    );
                }

                const families = new Set<string>();
                if (seen.entries.length > 0) families.add("log/entry");
                if (seen.status.length > 0) families.add("loop/packet");
                if (seen.status.some((value) => ((value as { plurnk?: { workspace?: { preparation?: unknown[] } } }).plurnk?.workspace?.preparation?.length ?? 0) > 0)) families.add("workspace/preparation");
                if (seen.proposals.length > 0) families.add("loop/proposal");
                if (seen.interactions.length > 0) families.add("loop/interaction");
                if (seen.reasoning.length > 0) families.add("reasoning/event");
                if (seen.outside.length > 0) families.add("outside/event");
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
        const transport = new AguiTransport({ aguiUrl: mock.url }, "fixture");
        const { h, seen } = collectingHandlers();
        transport.subscribe(h);
        const result = await transport.run("fixture", {}).done;
        assert.equal(result.finalStatus, 200);
        const gauges = seen.status as Array<{ plurnk: { status: { lifecycle: string; loopId: number | null; packetCount: number }; workspace: { preparation: unknown[] } } }>;
        assert.equal(gauges.length, 4, "one gauge per STATE_SNAPSHOT and STATE_DELTA");
        assert.deepEqual(gauges.map((g) => g.plurnk.status.lifecycle), ["idle", "idle", "running", "completed"]);
        assert.deepEqual(gauges.map((g) => g.plurnk.status.packetCount), [0, 0, 1, 1]);
        assert.deepEqual(gauges[1]!.plurnk.workspace.preparation, [{ family: "mcp", alias: "search", phase: "preparing", since: "2026-09-29T00:00:00.000Z" }]);
        assert.deepEqual(gauges[2]!.plurnk.workspace.preparation, [], "published capabilities clear preparation");
        assert.equal(gauges[3]!.plurnk.status.loopId, 1);
    } finally {
        await mock.close();
    }
});

test("{§cli-agui-conformance}: a Run that binds no worker carries its workspace and reports no gauge", async () => {
    const specimen = (await loadConformanceKit()).lifecycles.find(({ name }) => name === "action-problem")!;
    assert.ok(specimen.events.some((event) => event.type === "STATE_SNAPSHOT"), "the specimen's Run binds a workspace");
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of specimen.events) res.write(frame(event));
        res.end();
    });
    try {
        const transport = new AguiTransport({ aguiUrl: mock.url }, "fixture");
        const { h, seen } = collectingHandlers();
        transport.subscribe(h);
        await assert.rejects(() => transport.rpc(specimen.expect.action!.kind),
            (error: unknown) => error instanceof ProblemError && error.problem.status === specimen.expect.action!.status);
        assert.deepEqual(seen.status, [], "no worker, no gauge");
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
        const transport = new AguiTransport({ aguiUrl: mock.url }, "fixture");
        transport.subscribe(collectingHandlers().h);
        await assert.rejects(
            () => transport.run("fixture", {}).done,
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
    const terminal = ordinary.filter((event) => event.type === "RUN_FINISHED");
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
        response.end(frame({ type: "RUN_FINISHED", result: { kind: "providers.list", ok: true, result: { aliases: [] } } }));
    });
    const transport = new AguiTransport({ aguiUrl: mock.url }, "thread");
    try {
        const { h, seen } = collectingHandlers();
        transport.subscribe({ ...h, onStatus: (status) => { seen.status.push(status); ready.resolve(); } });
        const run = transport.run("fixture", {});
        // A run that settles before its first status fails here instead of waiting forever.
        await Promise.race([ready.promise, run.done.then(() => assert.fail("the model run settled before its first status"))]);
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

test("[§cli-conformance] AguiTransport: run() un-projects plurnk.* to daemon shapes; done resolves from the Run's end", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "TEXT_MESSAGE_CONTENT", messageId: "generic", delta: "generic-ignored" }));
        res.write(frame({ type: "REASONING_START", messageId: "1/1/2/SEND/reasoning" }));
        res.write(frame({ type: "REASONING_MESSAGE_START", messageId: "1/1/2/SEND/reasoning", role: "reasoning" }));
        res.write(frame({ type: "REASONING_MESSAGE_CONTENT", messageId: "1/1/2/SEND/reasoning", delta: "checked " }));
        res.write(frame({ type: "REASONING_MESSAGE_CONTENT", messageId: "1/1/2/SEND/reasoning", delta: "the evidence" }));
        res.write(frame({ type: "REASONING_MESSAGE_END", messageId: "1/1/2/SEND/reasoning" }));
        res.write(frame({ type: "REASONING_END", messageId: "1/1/2/SEND/reasoning" }));
        for (const event of live(wire({ id: 5, op: "NOTE", tx: { body: "Work." } }))) res.write(frame(event));
        res.write(frame({ type: "CUSTOM", name: "plurnk.outside", value: { coordinate: "alice-1-2", text: "Prose outside the fences.", tokens: 5 } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.stream", value: { entryId: 2, state: "active" } }));
        res.write(frame({ type: "CUSTOM", name: "plurnk.notice", value: { source: "grammar", kind: "parse_advisory", level: "warn" } }));
        res.write(frame({ type: "RUN_FINISHED", metadata: { plurnk: { terminal: { workspaceId: 7, loopId: 3, hitMaxTurns: false, turnIds: [1], result: { status: 200 } } } } }));
        res.end();
    });
    try {
        const bt = new AguiTransport({ aguiUrl: mock.url }, "th", { projectRoot: "/proj", settings: { questions: true } });
        const { h, seen } = collectingHandlers();
        bt.subscribe(h);
        const t = await bt.run("largest planet?", {}).done;
        assert.deepEqual(drawn(seen.entries), ["5 NOTE"], "{§cli-row-sources} the NOTE's call and receipt are one row");
        assert.deepEqual(seen.outside, [{ coordinate: "alice-1-2", text: "Prose outside the fences.", tokens: 5 }], "{§cli-outside-text} outside text un-projects to its own handler, never a row");
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
                interactive: true,
                projectRoot: "/proj",
                settings: { questions: true },
                control: true,
            },
        }, "the workspace (world) + options and control attachment ride the first run's forwardedProps");
    } finally { await mock.close(); }
});

test("{plurnk#108} AguiTransport: a session that observes its delegation asks for descendants on every run and learns each one's worker", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "RUN_STARTED" }));
        // The daemon presents a delegation a call opened as a subagent run of that call; its start names the worker.
        const subagentRunId = "ops://child/1";
        res.write(frame({ type: "SUBAGENT_STARTED", subagentRunId, name: "child", parentToolCallId: "1/1/1",
            metadata: { plurnk: { workerId: 20, name: "child", parentWorkerId: 10, depth: 1 } } }));
        res.write(frame({ type: "STEP_STARTED", stepName: "turn-9", subagentRunId }));
        for (const type of ["REASONING_START", "REASONING_MESSAGE_START", "REASONING_MESSAGE_CONTENT", "REASONING_MESSAGE_END", "REASONING_END"]) {
            res.write(frame({ type, messageId: "model-call-4/request-1/reasoning", subagentRunId,
                ...(type === "REASONING_MESSAGE_START" ? { role: "reasoning" } : {}), ...(type === "REASONING_MESSAGE_CONTENT" ? { delta: "the child's thought" } : {}) }));
        }
        for (const event of live(wire({ id: 7, op: "READ", worker_id: 20 }))) res.write(frame({ ...event, subagentRunId }));
        res.write(frame({ type: "STEP_FINISHED", stepName: "turn-9", subagentRunId }));
        res.write(frame({ type: "SUBAGENT_FINISHED", subagentRunId, outcome: { type: "success" }, result: { status: 200 } }));
        // A descendant whose work belongs to no subagent is introduced before its first event.
        res.write(frame({ type: "CUSTOM", name: "plurnk.descendant", value: { workerId: 30, name: "stray", parentWorkerId: 20, depth: 2 } }));
        res.write(frame(ambientOf(wholeRow(wire({ id: 8, op: "READ", worker_id: 30 }))!) as unknown as Record<string, unknown>));
        res.write(frame({ type: "RUN_FINISHED", metadata: { plurnk: { terminal: { workspaceId: 7, loopId: 3, hitMaxTurns: false, turnIds: [1], result: { status: 200 } } } } }));
        res.end();
    });
    try {
        const bt = new AguiTransport({ aguiUrl: mock.url }, "th", { descendants: true });
        const { h, seen } = collectingHandlers();
        const introduced: unknown[] = [];
        bt.subscribe({ ...h, onDescendant: (descendant) => introduced.push(descendant) });
        await bt.run("delegate", {}).done;
        assert.deepEqual(introduced, [{ workerId: 20, name: "child", parentWorkerId: 10, depth: 1 }, { workerId: 30, name: "stray", parentWorkerId: 20, depth: 2 }],
            "a subagent's start and a stray descendant's introduction both reach the handler");
        assert.deepEqual((seen.entries as LogEntryWire[]).map(({ id, op, worker_id }) => [id, op, worker_id]), [[7, "READ", 20], [8, "READ", 30]], "each descendant's row reaches onEntry");
        assert.deepEqual(seen.reasoning, [], "{§cli-workers-topology} a subagent's reasoning is not the session worker's");
        assert.equal((mock.captured[0].body as { forwardedProps: { plurnk: { descendants?: boolean } } }).forwardedProps.plurnk.descendants, true, "the run asks for its delegation");
    } finally { await mock.close(); }
});

test("AguiTransport: the Run error's Problem supplies the exact terminal status instead of parsing RUN_ERROR.code", async () => {
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
        res.write(frame({ type: "RUN_ERROR", message: problem.detail, code: problem.type, metadata: { plurnk: { problem: problem } } }));
        res.end();
    });
    try {
        const bt = new AguiTransport({ aguiUrl: mock.url }, "th");
        const { h, seen } = collectingHandlers();
        bt.subscribe(h);
        const result = await bt.run("go", {}).done;
        assert.equal(result.finalStatus, 429);
        assert.deepEqual(seen.problems, [problem]);
    } finally { await mock.close(); }
});

test("AguiTransport: RUN_ERROR without the exact Problem returns a client contract Problem", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "RUN_ERROR", message: "loop terminated 429", code: "429" }));
        res.end();
    });
    try {
        const bt = new AguiTransport({ aguiUrl: mock.url }, "th");
        const { h } = collectingHandlers();
        bt.subscribe(h);
        const result = await bt.run("go", {}).done;
        assert.equal(result.finalStatus, 502);
        assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/client/transport/problem-missing");
    } finally { await mock.close(); }
});

test("AguiTransport: the terminal record's result is the ordinary terminal truth", async () => {
    const problem = {
        type: "https://problems.plurnk.xyz/lifecycle/cancel/loop-cancelled",
        title: "Loop cancelled",
        status: 499,
        detail: "The loop was cancelled.",
        retryable: false,
    };
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "RUN_ERROR", message: problem.detail, code: problem.type, metadata: { plurnk: { terminal: {
                workspaceId: 7,
                loopId: 3,
                hitMaxTurns: false,
                turnIds: [1],
                result: { status: problem.status, problem },
            } } } }));
        res.end();
    });
    try {
        const bt = new AguiTransport({ aguiUrl: mock.url }, "th");
        const { h, seen } = collectingHandlers();
        bt.subscribe(h);
        const result = await bt.run("go", {}).done;
        assert.equal(result.finalStatus, 499);
        assert.deepEqual(result.result, { status: 499, problem });
        assert.deepEqual(seen.problems, [problem]);
    } finally { await mock.close(); }
});

test("AguiTransport.rpc: an action failure throws its exact Problem", async () => {
    const problem = {
        type: "https://problems.plurnk.xyz/agui/action/unknown-action",
        title: "Unknown action",
        status: 404,
        detail: "Unknown action 'missing'.",
        retryable: false,
    };
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "RUN_FINISHED", result: { kind: "missing", ok: false, problem } }));
        res.end();
    });
    try {
        const bt = new AguiTransport({ aguiUrl: mock.url }, "th");
        await assert.rejects(
            () => bt.rpc("missing"),
            (error: unknown) => error instanceof ProblemError && error.problem.type === problem.type,
        );
    } finally { await mock.close(); }
});

test("AguiTransport.rpc: an action stream without a result fails explicitly", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "RUN_FINISHED" }));
        res.end();
    });
    try {
        const bt = new AguiTransport({ aguiUrl: mock.url }, "th");
        await assert.rejects(
            () => bt.rpc("op.exec", { command: "printf done" }),
            (error: unknown) => error instanceof ProblemError
                && error.problem.type === "https://problems.plurnk.xyz/client/action/result-missing",
        );
    } finally { await mock.close(); }
});

test("[§cli-tui-flow] AguiTransport: after a rename, later Runs name the new workspace and keep the bound worker", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(frame({ type: "RUN_FINISHED", result: { kind: "worker.env.list", ok: true, result: {} } }));
    });
    try {
        const split = new AguiTransport({ aguiUrl: mock.url }, "second", { workspace: "fresh" });
        split.renameWorkspace("renamed");
        await split.rpc("worker.env.list");
        const implicit = new AguiTransport({ aguiUrl: mock.url }, "fresh");
        implicit.renameWorkspace("renamed");
        await implicit.rpc("worker.env.list");
        const bindings = mock.captured.map(({ body }) => {
            const input = body as { threadId: string; forwardedProps: { plurnk: { workspace: string } } };
            return [input.threadId, input.forwardedProps.plurnk.workspace];
        });
        assert.deepEqual(bindings, [["second", "renamed"], ["fresh", "renamed"]],
            "the thread keeps naming its worker; only the workspace's name moves");
    } finally { await mock.close(); }
});

test("AguiTransport: inject + rpc ride §3 action runs", async () => {
    const mock = await bootMock((req, res) => {
        // An action run answers on its own SSE: result custom + RUN_FINISHED.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "RUN_FINISHED", result: { kind: "x", ok: true, result: { status: 100, action: "injected_next_turn", loopId: 7 } } }));
        res.end();
    });
    try {
        const bt = new AguiTransport({ aguiUrl: mock.url }, "th");
        assert.deepEqual(await bt.inject("steer mid-run"), { status: 100, action: "injected_next_turn", loopId: 7 });
        const providers = await bt.rpc<{ action: string }>("providers.list");
        assert.equal(providers.action, "injected_next_turn", "the action result returns verbatim");
        const injectRun = mock.captured.find((c) => c.url === "/" && (c.body as { forwardedProps?: { plurnk?: { action?: { kind: string } } } }).forwardedProps?.plurnk?.action?.kind === "loop.inject");
        assert.ok(injectRun !== undefined, "inject rides an action run");
        assert.deepEqual((injectRun?.body as { forwardedProps: { plurnk: { action: unknown } } }).forwardedProps.plurnk.action, { kind: "loop.inject", prompt: "steer mid-run" });
        const rpcRun = mock.captured.find((c) => (c.body as { forwardedProps?: { plurnk?: { action?: { kind: string } } } })?.forwardedProps?.plurnk?.action?.kind === "providers.list");
        assert.ok(rpcRun !== undefined, "verbs ride action runs");
        // A worker thread injects into ITS world: the daemon would otherwise fall back to the
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
    const early = wire({ id: 8, op: "SEND", tx: { body: { raw: "committed before attachment", json: null } } });
    const late = wire({ id: 9, op: "NOTE", tx: { body: null } });
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
            for (const event of live(late)) response.write(frame(event));
            response.write(frame({ type: "MESSAGES_SNAPSHOT", messages: [] }));
        } else {
            assert.deepEqual(input.forwardedProps.plurnk.action, { kind: "log.read", sinceId: 0, limit: 1000 });
        }
        response.end(frame({ type: "RUN_FINISHED", outcome: { type: "success" }, result: { kind: "log.read", ok: true, result: { entries: [late, early] } } }));
    });
    const transport = new AguiTransport({ aguiUrl: mock.url }, "alice", { workspace: "world" });
    try {
        const { h, seen } = collectingHandlers();
        transport.subscribe(h);
        assert.equal(await transport.observe().done, null, "a successful sync with no terminal event has no loop result");
        assert.deepEqual(drawn(seen.entries), ["8 SEND", "9 NOTE"], "history precedes overlapping live rows without skipping or duplicating either");
        assert.deepEqual(seen.terminated, [], "no model terminal or usage was synthesized");
        assert.deepEqual(seen.problems, []);
        assert.equal(mock.captured.length, 2, "one sync and one bounded history read");
    } finally { transport.shutdown(); await mock.close(); }
});

test("{§cli-active-command-admission}: client operation rows do not advance the history cursor", async () => {
    const events = (await loadConformanceKit()).lifecycles.find(({ name }) => name === "ordinary-run")!.events;
    const previous = wire({ id: 7, op: "SEND", tx: { body: { raw: "previous loop", json: null } } });
    const unseen = wire({ id: 8, op: "SEND", tx: { body: { raw: "successor finished before attachment", json: null } } });
    const human = wire({ id: 10, op: "sh", origin: "client", tx: { body: "independent client operation" } });
    const mock = await bootMock((_request, response) => {
        const input = mock.captured.at(-1)!.body as { forwardedProps: { plurnk: { mode?: string; action?: { kind: string; sinceId?: number } } } };
        const action = input.forwardedProps.plurnk.action;
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (action === undefined && input.forwardedProps.plurnk.mode === undefined) {
            for (const event of events) {
                if (String(event.type).startsWith("TOOL_CALL")) continue;
                if (event.type === "RUN_FINISHED") for (const part of live(previous)) response.write(frame(part));
                response.write(frame(event));
            }
            response.end();
            return;
        }
        response.write(frame({ type: "RUN_STARTED" }));
        if (input.forwardedProps.plurnk.mode === "sync") response.write(frame({ type: "MESSAGES_SNAPSHOT", messages: [] }));
        if (action?.kind === "op.exec") {
            response.write(frame(ambientOf(wholeRow(human)!) as unknown as Record<string, unknown>));
            response.end(frame({ type: "RUN_FINISHED", outcome: { type: "success" }, result: { kind: action.kind, ok: true, result: { status: 200 } } }));
        } else if (action?.kind === "log.read") {
            response.end(frame({ type: "RUN_FINISHED", outcome: { type: "success" }, result: { kind: action.kind, ok: true,
                result: { entries: [previous, unseen].filter((entry) => entry.id > action.sinceId!) } } }));
        } else {
            response.end(frame({ type: "RUN_FINISHED", outcome: { type: "success" } }));
        }
    });
    const transport = new AguiTransport({ aguiUrl: mock.url }, "world");
    try {
        const { h, seen } = collectingHandlers();
        transport.subscribe(h);
        await transport.run("first", {}).done;
        await transport.rpc("op.exec", { command: "echo human" });
        assert.equal(await transport.observe().done, null);
        assert.deepEqual(drawn(seen.entries), ["7 SEND", "10 sh", "8 SEND"]);
    } finally { transport.shutdown(); await mock.close(); }
});

test("{§cli-active-command-admission}: injection refuses missing admission identity", async () => {
    const mock = await bootMock((_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(frame({ type: "RUN_FINISHED", outcome: { type: "success" }, result: { kind: "loop.inject", ok: true, result: { status: 100 } } }));
    });
    try {
        const transport = new AguiTransport({ aguiUrl: mock.url }, "world");
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
            if (mock.captured.length === 1) response.write(frame({ type: "MESSAGES_SNAPSHOT", messages: [] }));
            response.end(frame({ type: "RUN_FINISHED", outcome: { type: "success" }, result: { kind: "log.read", ok: true, result: { entries } } }));
        });
        try {
            const transport = new AguiTransport({ aguiUrl: mock.url }, "world");
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
        const transport = new AguiTransport({ aguiUrl: mock.url }, "world");
        const result = await transport.observe().done;
        assert.equal(result?.result.problem?.kind, "terminal-missing");
        assert.equal(mock.captured.length, 1);
    } finally { await mock.close(); }
});

for (const historyLimit of [0, 2]) {
    test(`{§cli-worker-history}: bounded attachment restores before live rows (${historyLimit})`, async () => {
        const release = Promise.withResolvers<void>();
        const older = wire({ id: 8, op: "READ", tx: { body: "old output" } });
        const overlap = wire({ id: 9, op: "SEND", status_rx: 202, rx: { status: 202 }, tx: { body: { raw: "old answer", json: null } } });
        const fresh = wire({ id: 10, op: "SEND", tx: { body: { raw: "new answer", json: null } } });
        const updated = { ...overlap, status_rx: 200, rx: { status: 200 } };
        const messages = [{ id: "9", role: "assistant", content: "old answer" }];
        const mock = await bootMock((_request, response) => {
            const input = mock.captured.at(-1)!.body as { forwardedProps: { plurnk: { action?: object } } };
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(frame({ type: "RUN_STARTED" }));
            if (input.forwardedProps.plurnk.action !== undefined) {
                assert.deepEqual(input.forwardedProps.plurnk.action, { kind: "log.read", limit: Math.max(1, historyLimit) });
                response.end(frame({ type: "RUN_FINISHED", outcome: { type: "success" }, result: { kind: "log.read", ok: true,
                    result: { entries: historyLimit === 0 ? [overlap] : [overlap, older] } } }));
                return;
            }
            response.write(frame({ type: "MESSAGES_SNAPSHOT", messages }));
            for (const event of live(overlap)) response.write(frame(event));
            void release.promise.then(() => {
                for (const event of [...live(updated), ...live(fresh)]) response.write(frame(event));
                response.end(frame({ type: "RUN_FINISHED", outcome: { type: "success" } }));
            });
        });
        const transport = new AguiTransport({ aguiUrl: mock.url }, "world");
        try {
            const { h, seen } = collectingHandlers();
            const histories: unknown[] = [];
            transport.subscribe({ ...h, onHistory: (history) => { histories.push(history); } });
            const run = transport.observe({ historyLimit });
            await run.ready;
            assert.deepEqual(histories, [{ entries: historyLimit === 0 ? [] : [wholeRow(older), wholeRow(overlap)], messages, attachment: true }]);
            assert.deepEqual(seen.entries, [], "replayed rows are historical, not new operation events");
            release.resolve();
            assert.equal(await run.done, null);
            assert.deepEqual(drawn(seen.entries), ["9 SEND", "10 SEND"], "unchanged overlap is suppressed, but receipt updates and fresh work survive");
            assert.deepEqual(seen.terminated, [], "no historical terminal or accounting event is synthesized");
        } finally { release.resolve(); transport.shutdown(); await mock.close(); }
    });
}

test("{§cli-worker-history}: successful sync without a message snapshot is a protocol error", async () => {
    const mock = await bootMock((_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(frame({ type: "RUN_STARTED" }));
        response.end(frame({ type: "RUN_FINISHED", outcome: { type: "success" } }));
    });
    const transport = new AguiTransport({ aguiUrl: mock.url }, "world");
    try {
        await assert.rejects(transport.observe({ historyLimit: 10 }).done,
            (cause: unknown) => cause instanceof ProblemError && cause.problem.kind === "result-invalid"
                && String(cause.problem.reason).includes("MESSAGES_SNAPSHOT"));
    } finally { transport.shutdown(); await mock.close(); }
});

test("{§cli-worker-history}: a recreated worker resets replay identities and cursor", async () => {
    const events = (await loadConformanceKit()).lifecycles.find(({ name }) => name === "ordinary-run")!.events;
    const snapshot = structuredClone(events.find((event) => event.type === "STATE_SNAPSHOT")!) as {
        type: string; snapshot: { plurnk: { status: { loopId: number | null } } };
    };
    snapshot.snapshot.plurnk.status.loopId = null;
    const row = wire({ id: 9, op: "NOTE", tx: { body: "retained body" } });
    const mock = await bootMock((_request, response) => {
        const input = mock.captured.at(-1)!.body as { forwardedProps: { plurnk: { mode?: string; action?: object } } };
        response.writeHead(200, { "content-type": "text/event-stream" });
        if (input.forwardedProps.plurnk.action !== undefined) {
            assert.deepEqual(input.forwardedProps.plurnk.action, { kind: "log.read", sinceId: 0, limit: 1000 });
            response.end(frame({ type: "RUN_FINISHED", outcome: { type: "success" }, result: {
                kind: "log.read", ok: true, result: { entries: [row] },
            } }));
            return;
        }
        if (input.forwardedProps.plurnk.mode === "sync") {
            response.write(frame(snapshot));
            response.write(frame({ type: "MESSAGES_SNAPSHOT", messages: [] }));
        } else {
            for (const event of events) {
                response.write(frame(event));
                if (event.type === "STATE_SNAPSHOT") for (const part of live(row)) response.write(frame(part));
            }
        }
        response.end(frame({ type: "RUN_FINISHED", outcome: { type: "success" } }));
    });
    const transport = new AguiTransport({ aguiUrl: mock.url }, "thread");
    try {
        const { h, seen } = collectingHandlers();
        transport.subscribe(h);
        await transport.run("first", {}).done;
        seen.entries.length = 0;
        assert.equal(await transport.observe().done, null);
        assert.deepEqual(drawn(seen.entries), ["9 NOTE"], "new persistence may reuse the old row identity");
    } finally { transport.shutdown(); await mock.close(); }
});

test("[§cli-conformance] run preserves explicitly requested file paths", async () => {
    const events = (await loadConformanceKit()).lifecycles.find(({ name }) => name === "ordinary-run")!.events;
    const mock = await bootMock((_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of events) response.write(frame(event));
        response.end();
    });
    try {
        const paths = ["src/main.ts", "docs/use.md"];
        const transport = new AguiTransport({ aguiUrl: mock.url }, "world");
        await transport.run("inspect the referenced files", { openPaths: paths }).done;
        const input = mock.captured[0].body as { forwardedProps: { plurnk: { control: boolean; openPaths: unknown } } };
        assert.deepEqual(input.forwardedProps.plurnk.openPaths, paths);
        assert.equal(input.forwardedProps.plurnk.control, true);
    } finally { await mock.close(); }
});

test("[§cli-cancellation] AguiTransport: cancel() aborts the SSE and done resolves (499), not a throw", async () => {
    const mock = await bootMock((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(frame({ type: "RUN_STARTED" })); });
    try {
        const bt = new AguiTransport({ aguiUrl: mock.url }, "th");
        bt.subscribe(collectingHandlers().h);
        const handle = bt.run("go", {});
        await new Promise((r) => setTimeout(r, 50));
        handle.cancel();
        assert.equal((await handle.done).finalStatus, 499, "cancel → clean 499 outcome");
    } finally { await mock.close(); }
});

test("{§cli-daemon-autostart}: disposing the TUI transport releases its open observation", async () => {
    const connected = Promise.withResolvers<void>();
    const disconnected = Promise.withResolvers<void>();
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "RUN_STARTED" }));
        res.once("close", disconnected.resolve);
        connected.resolve();
    });
    const transport = new AguiTransport({ aguiUrl: mock.url }, "th");
    try {
        const observation = transport.observe();
        await connected.promise;
        await transport[Symbol.asyncDispose]();
        assert.equal((await observation.done)?.finalStatus, 499);
        await disconnected.promise;
        await assert.rejects(transport.rpc("workspace.workers"), { name: "AbortError" });
        assert.throws(() => transport.observe(), { name: "AbortError" });
        assert.equal(mock.captured.length, 1, "closed transport must not reopen the daemon connection");
    } finally { transport.shutdown(); await mock.close(); }
});

test("AguiTransport.useWorkspace: re-maps the threadId — the next run addresses the new workspace", async () => {
    const mock = await bootMock((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(frame({ type: "RUN_FINISHED", metadata: { plurnk: { terminal: { hitMaxTurns: false, result: { status: 200 } } } } })); res.end(); });
    try {
        const bt = new AguiTransport({ aguiUrl: mock.url }, "old", { projectRoot: "/old", settings: { client: "plurnk-tui" } });
        const s = await bt.useWorkspace("new-thread", { projectRoot: "/chosen" });
        assert.equal(s.name, "new-thread");
        bt.subscribe(collectingHandlers().h);
        await bt.run("go", {}).done;
        assert.equal((mock.captured[0].body as { threadId: string }).threadId, "new-thread", "the run targets the re-mapped thread");
        const properties = (mock.captured[0].body as { forwardedProps: { plurnk: Record<string, unknown> } }).forwardedProps.plurnk;
        assert.equal(properties.projectRoot, "/chosen", "{§cli-project-root}: a switch uses its selected root, not the previous binding's root");
        assert.deepEqual(properties.settings, { client: "plurnk-tui" });
        await bt.useWorkspace("headless", { projectRoot: null });
        await bt.run("go", {}).done;
        assert.equal((mock.captured[1].body as { forwardedProps: { plurnk: { projectRoot: unknown } } }).forwardedProps.plurnk.projectRoot, null);
    } finally { await mock.close(); }
});

test("AguiTransport: terminate-resume — a proposal tool-call pauses done; resolve() resumes with the tool-result", async () => {
    let call = 0;
    const mock = await bootMock((_req, res) => {
        call += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (call === 1) {
            res.write(frame({ type: "TOOL_CALL_START", toolCallId: "prop:42", toolCallName: "request_approval" }));
            res.write(frame({ type: "TOOL_CALL_ARGS", toolCallId: "prop:42", delta: JSON.stringify({ op: "EDIT", target: { scheme: "file", pathname: "a.ts" }, body: "diff" }) }));
            res.write(frame({ type: "TOOL_CALL_END", toolCallId: "prop:42" }));
            res.write(frame({ type: "RUN_FINISHED", threadId: "th", runId: "r1", outcome: { type: "interrupt", interrupts: [{ id: "proposal-presentation", reason: "tool_call", toolCallId: "prop:42" }] } }));
        } else {
            res.write(frame({ type: "RUN_FINISHED", metadata: { plurnk: { terminal: { hitMaxTurns: false, turnIds: [1], result: { status: 200 } } } } }));
        }
        res.end();
    });
    try {
        const bt = new AguiTransport({ aguiUrl: mock.url }, "th");
        const { h, seen } = collectingHandlers();
        bt.subscribe(h);
        const handle = bt.run("edit it", {});
        // the proposal surfaces mid-run as an unprojected tool-call
        while (seen.proposals.length === 0) await new Promise((r) => setTimeout(r, 10));
        assert.equal((seen.proposals[0] as { logEntryId: number; op: string }).logEntryId, 42);
        assert.equal((seen.proposals[0] as { op: string }).op, "EDIT");
        await bt.resolve({ logEntryId: 42, decision: "accept", body: "edited", outcome: "reviewed" });
        const t = await handle.done;
        assert.equal(t.finalStatus, 200, "done spans the pause/resume chain");
        const resume = mock.captured[1].body as { resume: Array<{ interruptId: string; status: string; payload: unknown }> };
        assert.deepEqual(resume.resume, [{ interruptId: "proposal-presentation", status: "resolved", payload: { decision: "accept", body: "edited", outcome: "reviewed" } }], "the standard resume carries the decision, edited body, and resolution reason");
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
        const transport = new AguiTransport({ aguiUrl: mock.url }, "worker");
        transport.subscribe({ ...collectingHandlers().h, onProposal: () => ready.resolve() });
        const run = transport.run("review", {});
        await ready.promise;
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        run.cancel();
        assert.equal((await run.done).finalStatus, 499);
        await assert.rejects(transport.resolve({ logEntryId: 17, decision: "accept" }), /Proposal 17 has no pending/);
        assert.equal(mock.captured.length, 1, "cancel never submits a resume to execute the proposal");
    } finally { await mock.close(); }
});

test("AguiTransport: a client interaction uses interrupt guidance and resumes with the answer", async () => {
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
                        id: "interaction-presentation",
                        reason: "tool_call",
                        toolCallId: "int:8",
                        message: "Choose one repository.",
                        responseSchema,
                    }],
                },
            }));
        } else {
            res.write(frame({ type: "RUN_FINISHED", metadata: { plurnk: { terminal: { hitMaxTurns: false, turnIds: [2], result: { status: 200 } } } } }));
        }
        res.end();
    });
    try {
        const bt = new AguiTransport({ aguiUrl: mock.url }, "th");
        const { h, seen } = collectingHandlers();
        bt.subscribe(h);
        const handle = bt.run("choose", {});
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
            interruptId: "interaction-presentation",
            status: "resolved",
            payload: { repository: "plurnk-service" },
        }]);
    } finally { await mock.close(); }
});

test("AguiTransport: a proposal without the matching interrupt outcome returns an exact Problem", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "TOOL_CALL_START", toolCallId: "prop:42", toolCallName: "request_approval" }));
        res.write(frame({ type: "TOOL_CALL_ARGS", toolCallId: "prop:42", delta: JSON.stringify({ op: "EDIT", target: {}, body: "diff" }) }));
        res.write(frame({ type: "TOOL_CALL_END", toolCallId: "prop:42" }));
        res.end();
    });
    try {
        const bt = new AguiTransport({ aguiUrl: mock.url }, "th");
        const { h, seen } = collectingHandlers();
        bt.subscribe(h);
        const result = await bt.run("edit it", {}).done;
        assert.equal(result.finalStatus, 502);
        assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/client/transport/interrupt-mismatch");
        assert.deepEqual(seen.problems, [result.result.problem]);
    } finally { await mock.close(); }
});

test("AguiTransport: malformed proposal arguments return an exact Problem", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "TOOL_CALL_START", toolCallId: "prop:42", toolCallName: "request_approval" }));
        res.write(frame({ type: "TOOL_CALL_ARGS", toolCallId: "prop:42", delta: "{" }));
        res.write(frame({ type: "TOOL_CALL_END", toolCallId: "prop:42" }));
        res.end();
    });
    try {
        const bt = new AguiTransport({ aguiUrl: mock.url }, "th");
        const { h, seen } = collectingHandlers();
        bt.subscribe(h);
        const result = await bt.run("edit it", {}).done;
        assert.equal(result.result.problem?.type, "https://problems.plurnk.xyz/client/transport/proposal-invalid");
        assert.deepEqual(seen.problems, [result.result.problem]);
    } finally { await mock.close(); }
});

test("[§cli-yolo-plurnkyolo] AguiTransport: proposal can resolve synchronously from onProposal", async () => {
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
            res.write(frame({ type: "RUN_FINISHED", metadata: { plurnk: { terminal: { hitMaxTurns: false, turnIds: [2], result: { status: 200 } } } } }));
        }
        res.end();
    });
    try {
        const bt = new AguiTransport({ aguiUrl: mock.url }, "th");
        const { h } = collectingHandlers();
        bt.subscribe({
            ...h,
            onProposal: (p) => { void bt.resolve({ logEntryId: p.logEntryId, decision: "accept", outcome: "client_yolo" }); },
        });
        const t = await bt.run("exec it", {}).done;
        assert.equal(t.finalStatus, 200, "immediate yolo resolution resumes and finishes the loop");
        assert.equal(call, 2, "the proposal segment is followed by one resume segment");
        const resume = mock.captured[1].body as { resume: Array<{ interruptId: string; status: string; payload: unknown }> };
        assert.deepEqual(resume.resume, [{ interruptId: "prop:575", status: "resolved", payload: { decision: "accept", outcome: "client_yolo" } }]);
    } finally { await mock.close(); }
});

test("AguiTransport: resolve without a delivered interrupt fails hard", async () => {
    const bt = new AguiTransport({ aguiUrl: "http://127.0.0.1:1" }, "th");
    await assert.rejects(() => bt.resolve({ logEntryId: 1, decision: "accept" }), /Proposal 1 has no pending AG-UI interrupt\./);
});

test("AguiTransport: a stream that dies without terminal truth is an ERROR, never a fabricated 200", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "RUN_STARTED" }));
        for (const event of live(wire({ id: 1, op: "READ" }))) res.write(frame(event));
        res.end();   // no Run end, no RUN_ERROR — the stream just dies
    });
    try {
        const bt = new AguiTransport({ aguiUrl: mock.url }, "th");
        bt.subscribe(collectingHandlers().h);
        const t = await bt.run("go", {}).done;
        assert.equal(t.finalStatus, 502, "silent stream death surfaces as 502, not success");
    } finally { await mock.close(); }
});

test("[§cli-workspaces-and-workers] every request preserves rooted, headless, or unspecified creation options", async () => {
    const mock = await bootMock((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame({ type: "RUN_FINISHED", result: { kind: "worker.model.get", ok: true, result: { model: null } } }));
        res.end();
    });
    try {
        for (const projectRoot of ["/home/user/repo", null, undefined]) {
            mock.captured.length = 0;
            const bt = new AguiTransport({ aguiUrl: mock.url }, "th", {
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
        res.write(frame({ type: "RUN_FINISHED", metadata: { plurnk: { terminal: { hitMaxTurns: false, turnIds: [1], result: { status: 200 } } } } }));
        res.end();
    });
    try {
        const bt = new AguiTransport({ aguiUrl: mock.url }, "th");
        bt.subscribe(collectingHandlers().h);
        await bt.run("first", {}).done;
        await bt.run("second", {}).done;
        const runs = mock.captured.filter((c) => (c.body as { messages?: unknown[] }).messages !== undefined && ((c.body as { messages: unknown[] }).messages.length > 0 || (c.body as { forwardedProps?: { plurnk?: { action?: unknown } } }).forwardedProps?.plurnk?.action === undefined));
        assert.equal(runs.length, 2, "two loops drove");
        for (const c of runs) {
            const fp = (c.body as { forwardedProps: { plurnk: Record<string, unknown> } }).forwardedProps.plurnk;
            for (const key of ["selector", "childSelector"]) {
                assert.equal(Object.hasOwn(fp, key), false, `${key} is worker policy, not a loop knob`);
            }
        }
        for (const run of runs) {
            const input = run.body as { tools: { name: string }[] };
            assert.ok(input.tools.some(({ name }) => name === "request_approval"));
        }
    } finally { await mock.close(); }
});
