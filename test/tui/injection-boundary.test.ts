import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { bootDaemon, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

const json = async (request: IncomingMessage): Promise<Record<string, any>> => {
    let text = "";
    for await (const chunk of request) text += chunk;
    return JSON.parse(text);
};

for (const terminalFirst of [true, false]) {
test(`[§cli-active-command-admission] an admitted successor stays visible (terminal first=${terminalFirst})`, { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service, "the composed client test requires the sibling service");
    const release = Promise.withResolvers<void>();
    let inferenceCount = 0;
    const provider = createServer(async (request, response) => {
        if (request.method !== "POST") { response.writeHead(200).end("{}"); return; }
        const body = await json(request);
        inferenceCount += 1;
        const first = inferenceCount === 1;
        if (!first) assert.match(JSON.stringify(body.messages), /Continue with the new requirement/);
        response.writeHead(200, { "content-type": "text/event-stream" });
        const frame = (delta: object, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({
            id: `injection-${inferenceCount}`, object: "chat.completion.chunk",
            choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`);
        frame({ role: "assistant", reasoning_content: first ? "Awaiting the controlled injection." : "Handling the successor requirement." });
        if (first) await release.promise;
        frame({ content: `\`\`\`\`SEND\n${first ? "FIRST_FINISHED" : "SUCCESSOR_VISIBLE"}\n\`\`\`\`\n\n\`\`\`\`TASK\n[{"content":"Delivered","status":"completed"}]\n\`\`\`\`` });
        frame({}, "stop");
        response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    t.after(() => { provider.closeAllConnections(); return new Promise<void>((resolve) => provider.close(() => resolve())); });
    const providerAddress = provider.address();
    assert.ok(providerAddress !== null && typeof providerAddress !== "string");
    const daemon = await bootDaemon(service, { readyTimeoutMs: 30_000, extraEnv: {
        PLURNK_MODEL: "injectionfixture",
        PLURNK_MODEL_injectionfixture: "openai/injection-fixture",
        OPENAI_BASE_URL: `http://127.0.0.1:${providerAddress.port}/v1`,
        OPENAI_API_KEY: "injection-fixture",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
        PLURNK_PROVIDERS_REASONING: "off",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(() => daemon.cleanup());
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });

    const originalClosed = Promise.withResolvers<void>();
    const admitted = Promise.withResolvers<void>();
    const releaseTerminal = Promise.withResolvers<void>();
    let observers = 0;
    const relay = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
        const body = await json(request);
        const properties = body.forwardedProps?.plurnk;
        const injecting = properties?.action?.kind === "loop.inject";
        const originating = !properties?.action && !properties?.mode && body.messages?.length > 0;
        if (properties?.mode === "sync") observers += 1;
        if (injecting) {
            release.resolve();
            await originalClosed.promise;
        }
        const result = await fetch(daemon.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        if (injecting) {
            const receipt = await result.text();
            assert.match(receipt, /enqueued_new_loop/);
            // Finish the successor before the client receives admission. This independent
            // observer calls the real public sync path without adding a model request.
            const observed = await fetch(daemon.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
                ...body, runId: "fixture-observer", messages: [],
                forwardedProps: { plurnk: { workspace: properties.workspace, mode: "sync" } },
            }) });
            assert.match(await observed.text(), /RUN_FINISHED/);
            admitted.resolve();
            response.writeHead(result.status, { "content-type": "text/event-stream" }).end(receipt);
            return;
        }
        response.writeHead(result.status, { "content-type": result.headers.get("content-type") ?? "application/json" });
        assert.ok(result.body);
        if (originating && !terminalFirst) {
            const decoder = new TextDecoder();
            let buffered = "";
            const held: string[] = [];
            for await (const chunk of result.body) {
                buffered += decoder.decode(chunk, { stream: true });
                const frames = buffered.split("\n\n");
                buffered = frames.pop()!;
                for (const frame of frames) {
                    const event = JSON.parse(frame.slice(6));
                    if (event.type === "RUN_FINISHED" || event.name === "plurnk.terminated") held.push(frame);
                    else response.write(`${frame}\n\n`);
                }
            }
            originalClosed.resolve();
            await releaseTerminal.promise;
            for (const frame of held) response.write(`${frame}\n\n`);
            response.end(buffered);
        } else {
            for await (const chunk of result.body) response.write(chunk);
            response.end();
            if (originating) originalClosed.resolve();
        }
    };
    const proxy = createServer((request, response) => {
        void relay(request, response).catch((error) => {
            admitted.reject(error);
            response.destroy(error);
        });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    t.after(() => { proxy.closeAllConnections(); return new Promise<void>((resolve) => proxy.close(() => resolve())); });
    const proxyAddress = proxy.address();
    assert.ok(proxyAddress !== null && typeof proxyAddress !== "string");
    const tui = spawnTui(`http://127.0.0.1:${proxyAddress.port}`, ["--workspace", "injection-boundary", "--worker", "main", "--project-root", "", "--max-turns", "3"], {
        HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "",
    }, daemon.workspace);
    t.after(() => tui.kill());
    await tui.waitFor(/injectionfixture\(off\)/);
    tui.write("Start the first requirement.\r");
    await tui.waitFor(/Awaiting the controlled injection/);
    tui.write("... Continue with the new requirement.\r");
    await admitted.promise;
    if (!terminalFirst) {
        await tui.waitFor(/added to the run/);
        releaseTerminal.resolve();
    }
    await tui.waitFor(/SUCCESSOR_VISIBLE/);
    assert.equal(observers, 1, "the accepted successor has one client observer");
    assert.equal(inferenceCount, 2, "each admitted prompt generated exactly one model request");
    assert.doesNotMatch(tui.output(), /Terminal missing|State invalid/);
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);
});
}
