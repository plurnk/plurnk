import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { bootDaemon, completionsEndpoint, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";
import { actionViaAgui } from "../../src/agui.ts";

test("[§cli-status-wait] built TUI counts down a bounded park and retains its deadline on reattachment", { timeout: 60_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service, "the composed test requires the sibling service");
    let calls = 0;
    const endpoint = await completionsEndpoint(() => ++calls === 1
        ? "```sh\nsleep 30\n```\n\n```WAIT [8]\nAwait the check.\n```"
        : "```KILL (worker://user)\nEnd the fixture.\n```");
    t.after(() => endpoint.close());
    const daemon = await bootDaemon(service, { extraEnv: {
        PLURNK_MODEL: "waitfixture", PLURNK_MODEL_waitfixture: "openai/wait-fixture",
        OPENAI_BASE_URL: endpoint.url, OPENAI_API_KEY: "wait-fixture",
        PLURNK_PROVIDERS_EFFORT: "off", PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0", PLURNK_SERVICE_OPTIMISTIC_WAIT_MS: "0",
        PLURNK_SERVICE_WAIT_SEC: "300",
    } });
    t.after(() => daemon.cleanup());
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    const args = ["--workspace", "wait-countdown", "--worker", "user", "--project-root", "", "--yolo"];
    const env = { HOME: daemon.home, XDG_CONFIG_HOME: join(daemon.home, ".config"), PLURNK_MODEL: "" };
    const first = spawnTui(daemon.url, args, env, daemon.workspace);
    t.after(() => first.kill());
    await first.waitFor(/\[wait-countdown\/~user\(0\)\]/);
    first.write("Start the check.\r");
    await first.waitFor(/updates in [78]\.0s/);
    await first.waitFor(/updates in [56]\.0s/);
    const second = spawnTui(daemon.url, args, env, daemon.workspace);
    t.after(() => second.kill());
    await second.waitFor(/updates in [1-6]\.0s/);
    assert.equal(calls, 1, "reattachment observes the existing park without another model call");
    const beforeWake = first.output().length;
    await first.waitFor(/✋|cancelled|499/, 12_000, beforeWake);
    assert.equal(calls, 2, "the explicit eight-second wait expires before the 30-second process ends");
    await first.waitFor(/\[wait-countdown\/~user[^\r\n]*(?:✋|❌)/, 5_000, beforeWake);
    const footer = stripVTControlCharacters(first.output()).split(/\r?\n/).filter((line) => line.includes("[wait-countdown/~user")).at(-1);
    assert.ok(footer);
    assert.doesNotMatch(footer, /updates (?:in|due)/,
        "the settled status no longer carries a countdown");
    first.write("/quit\r");
    second.write("/quit\r");
    assert.equal(await first.exited, 0);
    assert.equal(await second.exited, 0);
});

for (const mode of ["tui", "cli"] as const) {
    test(`[§cli-status-preparation] built ${mode} displays a cold MCP and advances elapsed time before inference`, { timeout: 60_000 }, async (t) => {
        const service = await locateDaemon();
        assert.ok(service, "the composed test requires the sibling service");
        let calls = 0;
        const endpoint = await completionsEndpoint(() => { calls++; return "```SEND [200]\nREADY_FIXTURE\n```"; });
        t.after(() => endpoint.close());
        const daemon = await bootDaemon(service, { mcp: {
            slow: {
                type: "stdio", command: "node",
                args: [resolve("../plurnk-service/plurnk-mcp/src/fixtures/echo-server.mjs")],
                env: { PLURNK_MCP_TEST_START_DELAY_MS: "3000" },
            },
        }, extraEnv: {
            PLURNK_MODEL: "preparefixture", PLURNK_MODEL_preparefixture: "openai/prepare-fixture",
            OPENAI_BASE_URL: endpoint.url, OPENAI_API_KEY: "prepare-fixture",
            PLURNK_PROVIDERS_EFFORT: "off", PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
        } });
        t.after(() => daemon.cleanup());
        t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
        const args = ["--workspace", `preparation-${mode}`, "--worker", "main", "--project-root", ""];
        if (mode === "cli") args.push("--timeout", "25", "Reply briefly.");
        const terminal = spawnTui(daemon.url, args, {
            HOME: daemon.home, XDG_CONFIG_HOME: join(daemon.home, ".config"), PLURNK_MODEL: "",
        }, daemon.workspace);
        t.after(() => terminal.kill());
        if (mode === "tui") {
            await terminal.waitFor(/\[preparation-tui\/~main\(0\)\]/);
            terminal.write("Reply briefly.\r");
        }
        const first = await terminal.waitFor(/preparing mcp\/slow (\d+\.\d+s)/, 10_000);
        assert.equal(calls, 0, "preparation is visible before a model request");
        const elapsed = /preparing mcp\/slow (\d+\.\d+s)/.exec(first)?.[1];
        assert.ok(elapsed);
        const offset = terminal.output().length;
        await terminal.waitFor(new RegExp(`preparing mcp/slow (?!${RegExp.escape(elapsed)}\\b)\\d+\\.\\d+s`), 5_000, offset);
        await terminal.waitFor(/READY_FIXTURE/, 20_000);
        if (mode === "tui") terminal.write("/quit\r");
        assert.equal(await terminal.exited, 0, terminal.output());
        assert.equal(calls, 1);
        assert.doesNotMatch(terminal.output(), /problem:|runtime:error/);
    });
}

test("[§cli-status-project-root] startup and workspace changes show the daemon's folder, not the launch directory", { timeout: 60_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service, "the composed test requires the sibling service");
    const daemon = await bootDaemon(service);
    t.after(() => daemon.cleanup());
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    const first = join(daemon.workspace, "first project");
    const second = join(daemon.workspace, "second project");
    await Promise.all([mkdir(first), mkdir(second)]);
    for (const [name, projectRoot] of [["project-first", first], ["project-second", second], ["project-headless", null]] as const) {
        await actionViaAgui({ aguiUrl: daemon.url }, { threadId: name, kind: "workspace.create", params: { name, projectRoot } });
    }
    const tui = spawnTui(daemon.url, ["--workspace", "project-first"], {
        HOME: daemon.home, XDG_CONFIG_HOME: join(daemon.home, ".config"), PLURNK_MODEL: "",
    }, daemon.home);
    t.after(() => tui.kill());
    await tui.waitFor(new RegExp(`${RegExp.escape(first)} \\[project-first/`));
    assert.match(stripVTControlCharacters(tui.output()), new RegExp(`(?:^|[\\r\\n])${RegExp.escape(first)} \\[project-first/`),
        "the folder is at column zero, before the workspace/worker coordinates");
    const switched = tui.output().length;
    tui.write("/workspace project-second\r");
    await tui.waitFor(new RegExp(`${RegExp.escape(second)} \\[project-second/`), 10_000, switched);
    await tui.waitFor(/workspace: project-second \(new\)/, 10_000, switched);
    const headless = tui.output().length;
    tui.write("/workspace project-headless\r");
    const headlessStatus = /\[project-headless\/~user\(0\)\] [^\r\n]*/;
    await tui.waitFor(headlessStatus, 10_000, headless);
    const headlessLines = stripVTControlCharacters(tui.output().slice(headless)).split(/[\r\n]/).filter((line) => headlessStatus.test(line));
    assert.ok(headlessLines.length > 0);
    assert.ok(headlessLines.every((line) => line.startsWith("[project-headless/")),
        "a headless footer starts with its coordinates, without an old root or the creation-option cwd");
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);
});

test("[§cli-status-project-root] the built one-shot CLI status uses the resumed workspace folder", { timeout: 60_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service, "the composed test requires the sibling service");
    const endpoint = await completionsEndpoint(() => "````SEND [200]\nFolder confirmed.\n````");
    t.after(() => endpoint.close());
    const daemon = await bootDaemon(service, { extraEnv: {
        PLURNK_MODEL: "rootfixture", PLURNK_MODEL_rootfixture: "openai/root-fixture",
        OPENAI_BASE_URL: endpoint.url, OPENAI_API_KEY: "root-fixture", PLURNK_PROVIDERS_EFFORT: "off",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768", PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(() => daemon.cleanup());
    await actionViaAgui({ aguiUrl: daemon.url }, { threadId: "project-cli", kind: "workspace.create", params: { name: "project-cli", projectRoot: daemon.workspace } });
    const cli = spawnTui(daemon.url, ["--workspace", "project-cli", "--max-turns", "2", "--timeout", "15", "Answer briefly."], {
        HOME: daemon.home, XDG_CONFIG_HOME: join(daemon.home, ".config"), PLURNK_MODEL: "",
    }, daemon.home);
    t.after(() => cli.kill());
    assert.equal(await cli.exited, 0, cli.output());
    assert.match(cli.output(), /Folder confirmed\./);
    const rendered = stripVTControlCharacters(cli.output());
    assert.match(rendered, new RegExp(`(?:^|[\\r\\n])${RegExp.escape(daemon.workspace)} ⌛︎`));
    assert.doesNotMatch(rendered, new RegExp(`(?:^|[\\r\\n])${RegExp.escape(daemon.home)} ⌛︎`));
});

const statusRelay = async (t: TestContext, url: string, hooks: {
    onPrompt?: (response: ServerResponse) => void;
    afterFrame?: (frame: string) => Promise<void>;
} = {}): Promise<string> => {
    const failures: unknown[] = [];
    const shutdown = new AbortController();
    const relay = createServer((request, response) => {
        const connection = new AbortController();
        response.on("close", () => { if (!response.writableFinished) connection.abort(); });
        const signal = AbortSignal.any([shutdown.signal, connection.signal]);
        void (async () => {
            let raw = "";
            for await (const chunk of request) raw += chunk;
            if (raw.length > 0 && JSON.parse(raw).messages?.length > 0) hooks.onPrompt?.(response);
            const upstream = await fetch(new URL(request.url ?? "/", url), {
                method: request.method, headers: { "content-type": "application/json" },
                ...(raw.length > 0 ? { body: raw } : {}), signal,
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
            if (!signal.aborted) failures.push(error);
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
            frame({ content: `\`\`\`\`${index === 0 ? "SEND" : "SEND [200]"}\n${message}\n\`\`\`\`${work}` });
            frame({}, "stop");
            const factor = 2 ** index;
            response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: factor * 1000, completion_tokens: factor * 100, total_tokens: factor * 1100 }, knownUsage: { prompt_tokens: factor * 1000, completion_tokens: factor * 100, total_tokens: factor * 1100 } })}\n\n`);
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
    await tui.waitFor(/plurnk.*\/help/s);
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
                : `\`\`\`\`SEND [200]\n${index === 1 ? "CHILD_CLOCK_RESULT" : "PARENT_CLOCK_RESULT"}\n\`\`\`\``;
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
    const tui = spawnTui(daemon.url, ["--workspace", "delegation-clock", "--worker", "main", "--project-root", ""], {
        HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "",
    }, daemon.workspace);
    t.after(() => tui.kill());
    await tui.waitFor(/plurnk.*\/help/s);
    tui.write("Delegate and wait for the result.\r");
    const parked = /💤[^\r\n]* · (\d+(?:\.\d+)?s)\b/u;
    const first = await tui.waitFor(parked);
    const firstElapsed = parked.exec(first)?.[1];
    assert.ok(firstElapsed, "a parked parent displays elapsed wall time");
    const afterFirst = tui.output().length;
    await tui.waitFor(new RegExp(`💤[^\\r\\n]* · (?!${firstElapsed.replaceAll(".", "\\.")}\\b)\\d+(?:\\.\\d+)?s\\b`, "u"), 5_000, afterFirst);
    const afterWait = tui.output().length;
    childRelease.resolve();
    await resumed.promise;
    await tui.waitFor(/CLOCK_REASONING_2/, 10_000, afterWait);
    await tui.waitFor(/⌛︎[^\r\n]*clockfixture/, 10_000, afterWait);
    assert.doesNotMatch(tui.output().slice(afterWait), /PARENT_CLOCK_RESULT/u, "resumption is visible before any new parent operation");
    parentRelease.resolve();
    await tui.waitFor(/PARENT_CLOCK_RESULT/);
    await tui.waitFor(/⏹️[^\r\n]*clockfixture/);
    assert.equal(calls, 3);
    assert.doesNotMatch(tui.output(), /problem:|runtime:error/);
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);
});
