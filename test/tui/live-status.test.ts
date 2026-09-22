import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { bootDaemon, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

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
        PLURNK_PROVIDERS_REASONING: "off",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(() => daemon.cleanup());
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    const tui = spawnTui(daemon.url, ["--workspace", "live-status", "--worker", "main", "--project-root", ""], {
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
    await tui.waitFor(/LIVE_REASONING_2/);
    // {plurnk#91} — and when it works, the status names the operation that just ran.
    await tui.waitFor(/⌛︎[^\r\n]*FIND worker:\/\/\/\*/, 10_000, first);
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
