// [§cli-attention] The attention signal on the real daemon through a terminal: the bell rings when the person is needed
// (a question or a review now waits, a loop replies) and never for the person's own stop, nor when it is off.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { stripVTControlCharacters } from "node:util";
import { bootDaemon, locateDaemon } from "../intg/harness.ts";
import { spawnTui, type Tui } from "./harness.ts";

const QUESTION = "````question (question)\n" + JSON.stringify({
    message: "Supply the count.",
    requestedSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"] },
}) + "\n````\n````WAIT\nAwaiting the count.\n````";
const COMMAND = "````sh\nprintf ran\n````";
const reply = (text: string) => `\`\`\`\`SEND [200]\n${text}\n\`\`\`\``;

// The rings in the raw terminal stream: every BEL that does not end an OSC sequence (a window title, a colour query).
const bells = (output: string): number => (output.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu, "").match(/\x07/gu) ?? []).length;

const rung = async (tui: Tui, count: number): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (bells(tui.output()) < count) {
        if (Date.now() > deadline) throw new Error(`expected ${count} bell(s), heard ${bells(tui.output())}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
};

// A daemon whose model answers each request with the next scripted response, and a client against it.
const boot = async (t: TestContext, responses: readonly string[], args: readonly string[], env: NodeJS.ProcessEnv): Promise<Tui> => {
    const service = await locateDaemon();
    assert.ok(service, "the composed client test requires the sibling service");
    let requests = 0;
    const endpoint = createServer(async (request, response) => {
        if (request.method !== "POST") {
            response.writeHead(200, { "content-type": "application/json" }).end('{"object":"list","data":[]}');
            return;
        }
        for await (const _chunk of request) { /* drain the fixture request */ }
        const content = responses[Math.min(requests, responses.length - 1)]!;
        requests += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ id: "attention-fixture", object: "chat.completion.chunk", choices: [
            { index: 0, delta: { role: "assistant", content }, finish_reason: null },
        ] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id: "attention-fixture", object: "chat.completion.chunk", choices: [
            { index: 0, delta: {}, finish_reason: "stop" },
        ], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
        response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    t.after(() => { endpoint.closeAllConnections(); return new Promise<void>((resolve) => endpoint.close(() => resolve())); });
    const address = endpoint.address();
    assert.ok(address !== null && typeof address !== "string");
    const daemon = await bootDaemon(service, { readyTimeoutMs: 30_000, extraEnv: {
        PLURNK_MODEL: "attentionfixture",
        PLURNK_MODEL_attentionfixture: "openai/attention-fixture",
        PLURNK_BASEURL_attentionfixture: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_API_KEY: "attention-fixture",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
        PLURNK_PROVIDERS_EFFORT: "off",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
        PLURNK_SERVICE_OPTIMISTIC_WAIT_MS: "0",
    } });
    t.after(() => daemon.cleanup());
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    const tui = spawnTui(daemon.url, ["--worker", "main", "--project-root", "", "--max-turns", "3", ...args], {
        HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "", ...env,
    }, daemon.workspace);
    t.after(() => tui.kill());
    t.after(() => { if (!t.passed) t.diagnostic(stripVTControlCharacters(tui.output())); });
    return tui;
};

// The question's form is up; Esc returns to the composer with the question still waiting.
const awaitQuestion = async (tui: Tui): Promise<void> => {
    await tui.waitFor(/count \(integer; required\)/, 30_000);
    tui.write("\x1b");
    await tui.waitFor(/1 pending review.*\/review/, 10_000);
};

const quit = async (tui: Tui): Promise<void> => {
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);
};

test("[§cli-attention] a waiting question rings once, and the reply that answers it once more", { timeout: 120_000 }, async (t) => {
    const tui = await boot(t, [QUESTION, reply("Counted.")], ["--workspace", "attention-question"], { PLURNK_CLIENT_BELL: "1" });
    await tui.waitFor(/plurnk.*\/help/s);
    tui.write("Ask for the count.\r");
    await awaitQuestion(tui);
    await rung(tui, 1);
    tui.write("/cancel\r");
    await tui.waitFor(/Counted\./, 30_000);
    await rung(tui, 2);
    await quit(tui);
    assert.equal(bells(tui.output()), 2, "the question, then the reply");
});

test("[§cli-attention] the person's own stop rings nothing", { timeout: 120_000 }, async (t) => {
    const tui = await boot(t, [QUESTION, reply("Never sent.")], ["--workspace", "attention-stop"], { PLURNK_CLIENT_BELL: "1" });
    await tui.waitFor(/plurnk.*\/help/s);
    tui.write("Ask for the count.\r");
    await awaitQuestion(tui);
    await rung(tui, 1);
    tui.write("/stop\r");
    await tui.waitFor(/cancelled|final 499/, 30_000);
    await quit(tui);
    assert.equal(bells(tui.output()), 1, "the question alone: the stop was the person's");
});

test("[§cli-attention] a proposal waiting for review rings, and so does the reply after it", { timeout: 120_000 }, async (t) => {
    const tui = await boot(t, [COMMAND, reply("The command ran.")], ["--workspace", "attention-review"], {
        PLURNK_CLIENT_BELL: "1", PLURNK_CLIENT_YOLO: "0",
    });
    await tui.waitFor(/plurnk.*\/help/s);
    tui.write("Run the command.\r");
    await tui.waitFor(/↑\/↓: choose.*Enter: confirm.*Esc: composer/, 30_000);
    await rung(tui, 1);
    tui.write("\r");
    await tui.waitFor(/The command ran\./, 30_000);
    await rung(tui, 2);
    await quit(tui);
    assert.equal(bells(tui.output()), 2, "the review, then the reply");
});

test("[§cli-attention] without the bell nothing rings", { timeout: 120_000 }, async (t) => {
    const tui = await boot(t, [QUESTION, reply("Counted.")], ["--workspace", "attention-silent"], {});
    await tui.waitFor(/plurnk.*\/help/s);
    tui.write("Ask for the count.\r");
    await awaitQuestion(tui);
    tui.write("/cancel\r");
    await tui.waitFor(/Counted\./, 30_000);
    await quit(tui);
    assert.equal(bells(tui.output()), 0);
});

test("[§cli-attention] a one-shot prompt with --bell rings once, at its reply", { timeout: 120_000 }, async (t) => {
    const tui = await boot(t, [reply("Done.")], ["--workspace", "attention-one-shot", "--bell", "Say done."], {});
    assert.equal(await tui.exited, 0);
    assert.match(stripVTControlCharacters(tui.output()), /Done\./);
    assert.equal(bells(tui.output()), 1);
});
