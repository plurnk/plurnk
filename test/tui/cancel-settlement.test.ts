// {§cli-cancellation} {§cli-provider-reasoning}: a cancelled run settles on the daemon's own terminal record,
// and the live reasoning it was streaming is retired with it, so the next prompt starts clean.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTcpServer, connect, type AddressInfo, type Socket } from "node:net";
import { bootDaemon, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

type Inference = (request: IncomingMessage, response: ServerResponse, index: number) => Promise<void>;

const streamer = (response: ServerResponse) => (delta: object, finish_reason: string | null = null): boolean => response.write(`data: ${JSON.stringify({
    id: "cancel-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }],
})}\n\n`);

const answer = (response: ServerResponse, text: string): void => {
    const frame = streamer(response);
    frame({ content: "````SEND [200]\n" + text + "\n````" });
    frame({}, "stop");
    response.end("data: [DONE]\n\n");
};

// A TCP relay between the client and the daemon. `freezeStream` stops forwarding what the daemon writes on the
// connection it wrote to last — the run's event stream — so a terminal record can no longer reach the client,
// while the cancel action, on its own connection, still goes through.
const relay = async (t: TestContext, daemonUrl: string): Promise<{ url: string; freezeStream: () => void }> => {
    const target = new URL(daemonUrl);
    const links: Array<{ client: Socket; upstream: Socket; lastWriteAt: number; frozen: boolean }> = [];
    const server = createTcpServer((client) => {
        const upstream = connect({ host: target.hostname, port: Number(target.port) });
        const link = { client, upstream, lastWriteAt: 0, frozen: false };
        links.push(link);
        const close = (): void => { client.destroy(); upstream.destroy(); };
        client.on("data", (chunk) => { upstream.write(chunk); });
        upstream.on("data", (chunk) => { link.lastWriteAt = performance.now(); if (!link.frozen) client.write(chunk); });
        client.on("close", close).on("error", close);
        upstream.on("close", close).on("error", close);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
        for (const { client, upstream } of links) { client.destroy(); upstream.destroy(); }
        return new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const proxied = new URL(daemonUrl);
    proxied.port = String((server.address() as AddressInfo).port);
    return {
        url: proxied.toString(),
        freezeStream: () => {
            const latest = links.filter(({ client }) => !client.destroyed).toSorted((a, b) => b.lastWriteAt - a.lastWriteAt)[0];
            assert.ok(latest !== undefined, "the run's event stream is open");
            latest.frozen = true;
        },
    };
};

const fixture = async (t: TestContext, infer: Inference, opts: { clientArgs?: string[]; relayed?: boolean } = {}) => {
    const service = await locateDaemon();
    assert.ok(service, "the composed client test requires the sibling service");
    let requests = 0;
    const endpoint = createServer(async (request, response) => {
        if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [] }));
            return;
        }
        for await (const _chunk of request) { /* consume the complete request before answering */ }
        const index = requests;
        requests += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        await infer(request, response, index);
    });
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    t.after(() => { endpoint.closeAllConnections(); return new Promise<void>((resolve) => endpoint.close(() => resolve())); });
    const address = endpoint.address();
    assert.ok(address !== null && typeof address !== "string");
    const daemon = await bootDaemon(service, { readyTimeoutMs: 30_000, extraEnv: {
        PLURNK_MODEL: "cancelfixture",
        PLURNK_MODEL_cancelfixture: "openai/cancel-fixture",
        PLURNK_BASEURL_cancelfixture: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_API_KEY: "cancel-fixture",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
        PLURNK_PROVIDERS_EFFORT: "off",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(() => daemon.cleanup());
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    const route = opts.relayed === true ? await relay(t, daemon.url) : null;
    const tui = spawnTui(route?.url ?? daemon.url, [
        "--workspace", "cancel-settlement", "--worker", "main", "--project-root", "", "--max-turns", "6", ...opts.clientArgs ?? [],
    ], { HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "" }, daemon.workspace);
    t.after(() => tui.kill());
    await tui.waitFor(/plurnk[\s\S]*\/help/);
    return { tui, requests: () => requests, freezeStream: route?.freezeStream };
};

test("{§cli-provider-reasoning} cancelling live reasoning retires its tail; the next prompt's reasoning streams clean", { timeout: 120_000 }, async (t) => {
    // Every response holds after its reasoning: the first until the cancellation ends it, the second until the
    // test has seen its reasoning on screen.
    const held: ServerResponse[] = [];
    const { tui } = await fixture(t, async (_request, response, index) => {
        streamer(response)({ role: "assistant", reasoning_content: `AUDIT_REASONING_${index + 1}` });
        held.push(response);
    });
    tui.write("Think about the first prompt.\r");
    await tui.waitFor(/AUDIT_REASONING_1/);
    tui.write("\x03");
    await tui.waitFor(/cancelled · \d+ turns?/);
    const second = tui.output().length;
    tui.write("Now answer the second prompt.\r");
    await tui.waitFor(/AUDIT_REASONING_2/, 30_000, second);
    answer(held[1], "SECOND_PROMPT_ANSWERED");
    await tui.waitFor(/SECOND_PROMPT_ANSWERED/, 30_000, second);
    await tui.waitFor(/done · 1 turn/, 30_000, second);
    assert.doesNotMatch(tui.output(), /second reasoning message started before the first ended/u, "the retired tail cannot collide with the next run's reasoning");
    assert.doesNotMatch(tui.output().slice(second), /AUDIT_REASONING_1/u, "the cancelled run's reasoning does not linger into the next prompt");
});

test("{§cli-cancellation} a cancellation summary carries the daemon's turn count, not zero", { timeout: 120_000 }, async (t) => {
    const { tui, requests } = await fixture(t, async (_request, response, index) => {
        const frame = streamer(response);
        if (index < 2) {
            frame({ content: "````NOTE\nStep " + String(index + 1) + " recorded.\n````" });
            frame({}, "stop");
            response.end("data: [DONE]\n\n");
            return;
        }
        frame({ role: "assistant", reasoning_content: "HELD_REASONING_BEFORE_CANCEL" });   // held open
    });
    tui.write("Record two steps, then think.\r");
    await tui.waitFor(/HELD_REASONING_BEFORE_CANCEL/);
    assert.equal(requests(), 3, "two NOTE turns completed and the third holds");
    tui.write("\x03");
    const summary = await tui.waitFor(/cancelled · \d+ turns?|cancelled · turns unknown/);
    // The daemon's own count for the worker's first loop: the opening turn it authors itself, the two NOTE
    // turns and the cancelled one.
    assert.match(summary, /cancelled · 4 turns/u, "the summary carries the turn ids of the daemon's terminal record");
    assert.doesNotMatch(tui.output(), /cancelled · 0 turns/u);
});

test("{§cli-cancellation} a run whose terminal record cannot arrive says turns unknown, never zero, and the session goes on", { timeout: 120_000 }, async (t) => {
    const { tui, freezeStream } = await fixture(t, async (_request, response, index) => {
        if (index === 0) { streamer(response)({ role: "assistant", reasoning_content: "HELD_UNTIL_HANGUP" }); return; }
        answer(response, "AFTER_HANGUP_ANSWERED");
    }, { relayed: true, clientArgs: ["--cancel-grace-ms", "500"] });
    tui.write("Think until I hang up.\r");
    await tui.waitFor(/HELD_UNTIL_HANGUP/);
    freezeStream!();
    tui.write("\x03");
    await tui.waitFor(/cancelled · turns unknown/);
    assert.doesNotMatch(tui.output(), /cancelled · 0 turns/u, "a hung-up run never reports zero work");
    const second = tui.output().length;
    tui.write("Answer after the hangup.\r");
    await tui.waitFor(/AFTER_HANGUP_ANSWERED/, 30_000, second);
    await tui.waitFor(/done · 1 turn/, 30_000, second);
    assert.doesNotMatch(tui.output(), /second reasoning message started before the first ended/u, "the tail whose end never arrived was retired with its run");
});
