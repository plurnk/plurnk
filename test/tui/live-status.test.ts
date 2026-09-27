import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { bootDaemon, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

const statusRelay = async (t: TestContext, url: string, hooks: {
    onPrompt?: (response: ServerResponse) => void;
    afterFrame?: (frame: string) => Promise<void>;
} = {}): Promise<string> => {
    const failures: unknown[] = [];
    const shutdown = new AbortController();
    const relay = createServer((request, response) => {
        void (async () => {
            let raw = "";
            for await (const chunk of request) raw += chunk;
            if (raw.length > 0 && JSON.parse(raw).messages?.length > 0) hooks.onPrompt?.(response);
            const upstream = await fetch(`${url}${request.url ?? "/"}`, {
                method: request.method, headers: { "content-type": "application/json" },
                ...(raw.length > 0 ? { body: raw } : {}), signal: shutdown.signal,
            });
            response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
            assert.ok(upstream.body);
            const decoder = new TextDecoder();
            let pending = "";
            for await (const chunk of upstream.body) {
                pending += decoder.decode(chunk, { stream: true });
                const frames = pending.split("\n\n");
                pending = frames.pop()!;
                for (const frame of frames) {
                    response.write(`${frame}\n\n`);
                    await hooks.afterFrame?.(frame);
                }
            }
            response.end(pending + decoder.decode());
        })().catch((error: Error) => {
            if (!shutdown.signal.aborted) failures.push(error);
            response.destroy(error);
        });
    });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
        shutdown.abort();
        relay.closeAllConnections();
        await new Promise<void>((resolve) => relay.close(() => resolve()));
        assert.deepEqual(failures, [], "the status relay must preserve unexpected failures");
    });
    const address = relay.address();
    assert.ok(address !== null && typeof address === "object");
    return `http://127.0.0.1:${address.port}`;
};

test("[§cli-worker-status] the built TUI accrues each turn while reasoning is live, then settles each loop once", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service, "the composed test requires the sibling service");
    const incoming = Array.from({ length: 3 }, () => Promise.withResolvers<ServerResponse>());
    const release = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
    let calls = 0;
    const provider = createServer((request, response) => {
        const serve = async (): Promise<void> => {
            if (request.method !== "POST") { response.writeHead(200).end("{}"); return; }
            for await (const _chunk of request) { /* consume the provider request */ }
            const index = calls++;
            assert.ok(index < incoming.length, "the client must not introduce inference calls");
            response.writeHead(200, { "content-type": "text/event-stream" });
            const frame = (delta: object, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({
                id: `status-${index}`, object: "chat.completion.chunk",
                choices: [{ index: 0, delta, finish_reason }],
            })}\n\n`);
            frame({ role: "assistant", reasoning_content: `LIVE_REASONING_${index + 1}` });
            incoming[index].resolve(response);
            await release[index].promise;
            const message = index === 0 ? "Continuing the work." : `FINAL_RESPONSE_${index + 1}`;
            const work = index === 0 ? "\n\n````FIND (worker:///*)\n````" : "";
            frame({ content: `\`\`\`\`${index === 0 ? "SEND" : "KILL"}\n${message}\n\`\`\`\`${work}` });
            frame({}, "stop");
            const factor = 2 ** index;
            response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: factor * 1000, completion_tokens: factor * 100, total_tokens: factor * 1100 } })}\n\n`);
            response.end("data: [DONE]\n\n");
        };
        void serve().catch((error: Error) => { incoming.forEach((gate) => gate.reject(error)); response.destroy(error); });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    t.after(() => {
        release.forEach((gate) => gate.resolve());
        provider.closeAllConnections();
        return new Promise<void>((resolve) => provider.close(() => resolve()));
    });
    const address = provider.address();
    assert.ok(address !== null && typeof address !== "string");
    const daemon = await bootDaemon(service, { readyTimeoutMs: 30_000, extraEnv: {
        PLURNK_MODEL: "statusfixture",
        PLURNK_MODEL_statusfixture: "openai/status-fixture",
        OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_API_KEY: "status-fixture",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
        PLURNK_PROVIDERS_EFFORT: "off",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
        // The fixture bills round token counts for the gauge assertions, not real usage.
        PLURNK_PROVIDERS_DROPPED_OUTPUT_TOKENS: "0",
    } });
    t.after(() => daemon.cleanup());
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    const findRendered = Promise.withResolvers<void>();
    t.after(() => findRendered.resolve());
    // Hold subsequent wire events until this transient activity has been observed;
    // the next turn can otherwise replace it before pi-tui's coalesced redraw.
    const url = await statusRelay(t, daemon.url, { afterFrame: async (frame) => {
        if (!frame.startsWith("data: ")) return;
        const event = JSON.parse(frame.slice(6));
        if (event.name === "plurnk.row" && event.value?.origin === "model" && event.value.op === "FIND") {
            await findRendered.promise;
        }
    } });
    const tui = spawnTui(url, ["--workspace", "live-status", "--worker", "main", "--project-root", ""], {
        HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "",
    }, daemon.workspace);
    t.after(() => tui.kill());
    await tui.waitFor(/plurnk.*\/help/);
    tui.write("Work through two turns.\r");
    await incoming[0].promise;
    await tui.waitFor(/LIVE_REASONING_1/);
    // {plurnk#91} — the quiet part is named: the worker is waiting on the model, not hung.
    await tui.waitFor(/⌛︎[^\r\n]*awaiting model/, 10_000);
    const first = tui.output().length;
    release[0].resolve();
    await incoming[1].promise;
    // {plurnk#91} — and when it works, the status names the operation that just ran.
    await tui.waitFor(/⌛︎[^\r\n]*FIND worker:\/\/\/\*/, 10_000, first);
    findRendered.resolve();
    await tui.waitFor(/LIVE_REASONING_2/);
    await tui.waitFor(/⌛︎[^\r\n]*↓1k ↑100/, 10_000, first);
    assert.match(tui.output().slice(first), /Continuing the work\./, "the first delivered message remains in scrollback as the next reasoning streams");
    const command = tui.output().length;
    tui.write("/model\r");
    await tui.waitFor(/model: statusfixture/, 10_000, command);
    await tui.waitFor(/⌛︎[^\r\n]*↓1k ↑100/, 10_000, command);
    release[1].resolve();
    await tui.waitFor(/FINAL_RESPONSE_2/);
    await tui.waitFor(/⏹️[^\r\n]*↓3k ↑300/);
    const next = tui.output().length;
    tui.write("One more independent task.\r");
    await incoming[2].promise;
    await tui.waitFor(/LIVE_REASONING_3/);
    await tui.waitFor(/⌛︎[^\r\n]*↓3k ↑300/, 10_000, next);
    release[2].resolve();
    await tui.waitFor(/FINAL_RESPONSE_3/);
    await tui.waitFor(/⏹️[^\r\n]*↓7k ↑700/);
    assert.equal(calls, 3);
    assert.doesNotMatch(tui.output(), /problem:|runtime:error/);
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);
});

test("[§cli-worker-status] the built TUI clock advances through parked and resumed AG-UI gauges", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service, "the composed test requires the sibling service");
    const childRelease = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    const parentRelease = Promise.withResolvers<void>();
    const fixtureErrors: unknown[] = [];
    t.after(() => assert.deepEqual(fixtureErrors, [], "the fixture must not hide provider or relay failures"));
    let calls = 0;
    const provider = createServer((request, response) => {
        const serve = async (): Promise<void> => {
            if (request.method !== "POST") { response.writeHead(200).end("{}"); return; }
            for await (const _chunk of request) { /* consume the provider request */ }
            const index = calls++;
            assert.ok(index < 3, "one parent turn, one child turn and one resumed parent turn");
            response.writeHead(200, { "content-type": "text/event-stream" });
            const frame = (delta: object, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({
                id: `delegation-clock-${index}`, object: "chat.completion.chunk",
                choices: [{ index: 0, delta, finish_reason }],
            })}\n\n`);
            frame({ role: "assistant", reasoning_content: `CLOCK_REASONING_${index}` });
            if (index === 1) await childRelease.promise;
            if (index === 2) { resumed.resolve(); await parentRelease.promise; }
            const content = index === 0
                ? "````WORK (worker://timer_child)\nReturn CHILD_CLOCK_RESULT.\n````\n\n````WAIT\n````"
                : `\`\`\`\`KILL\n${index === 1 ? "CHILD_CLOCK_RESULT" : "PARENT_CLOCK_RESULT"}\n\`\`\`\``;
            frame({ content });
            frame({}, "stop");
            response.end("data: [DONE]\n\n");
        };
        void serve().catch((error: Error) => { fixtureErrors.push(error); resumed.resolve(); response.destroy(error); });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    t.after(() => {
        childRelease.resolve(); parentRelease.resolve();
        provider.closeAllConnections();
        return new Promise<void>((resolve) => provider.close(() => resolve()));
    });
    const address = provider.address();
    assert.ok(address !== null && typeof address === "object");
    const daemon = await bootDaemon(service, { readyTimeoutMs: 30_000, extraEnv: {
        PLURNK_MODEL: "clockfixture",
        PLURNK_MODEL_clockfixture: "openai/clock-fixture",
        OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_API_KEY: "clock-fixture",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
        PLURNK_PROVIDERS_EFFORT: "off",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(() => daemon.cleanup());
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    // The client clock consumes gauges, not inferred operation state. Control those
    // frames independently of the service's lifecycle-publication work in #122.
    let runResponse: ServerResponse | undefined;
    const url = await statusRelay(t, daemon.url, { onPrompt: (response) => { runResponse = response; } });
    const lifecycle = (value: "parked" | "running"): void => {
        assert.ok(runResponse, "the prompt has an active AG-UI stream");
        runResponse.write(`data: ${JSON.stringify({ type: "STATE_DELTA", delta: [
            { op: "replace", path: "/plurnk/status/lifecycle", value },
        ] })}\n\n`);
    };
    const tui = spawnTui(url, ["--workspace", "delegation-clock", "--worker", "main", "--project-root", ""], {
        HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "",
    }, daemon.workspace);
    t.after(() => tui.kill());
    await tui.waitFor(/plurnk.*\/help/);
    tui.write("Delegate and wait for the result.\r");
    await tui.waitFor(/WAIT[^\r\n]*🐜 1/);
    lifecycle("parked");
    const parked = /💤[^\r\n]* · (\d+(?:\.\d+)?s)\b/u;
    const first = await tui.waitFor(parked);
    const firstElapsed = parked.exec(first)?.[1];
    assert.ok(firstElapsed, "a parked parent displays elapsed wall time");
    const afterFirst = tui.output().length;
    await tui.waitFor(new RegExp(`💤[^\\r\\n]* · (?!${firstElapsed.replaceAll(".", "\\.")}\\b)\\d+(?:\\.\\d+)?s\\b`, "u"), 5_000, afterFirst);
    const afterWait = tui.output().length;
    childRelease.resolve();
    await resumed.promise;
    lifecycle("running");
    await tui.waitFor(/CLOCK_REASONING_2/, 10_000, afterWait);
    assert.doesNotMatch(tui.output().slice(afterWait), /PARENT_CLOCK_RESULT/u, "resumption is visible before any new parent operation");
    parentRelease.resolve();
    await tui.waitFor(/PARENT_CLOCK_RESULT/);
    await tui.waitFor(/⏹️[^\r\n]*clockfixture/);
    assert.equal(calls, 3);
    assert.doesNotMatch(tui.output(), /problem:|runtime:error/);
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);
});
