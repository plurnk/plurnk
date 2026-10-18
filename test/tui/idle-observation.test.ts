// {§cli-summary-line-per-loop}: an observation that ends without a loop terminal is no loop outcome — the
// daemon stopping under an idle session is diagnosed once, and the one completed loop keeps its one summary.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { bootDaemon, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

type Inference = (request: IncomingMessage, response: ServerResponse, index: number) => Promise<void>;

const streamer = (response: ServerResponse) => (delta: object, finish_reason: string | null = null): boolean => response.write(`data: ${JSON.stringify({
    id: "idle-fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }],
})}\n\n`);

const answer = (response: ServerResponse, text: string): void => {
    const frame = streamer(response);
    frame({ content: "````SEND [200]\n" + text + "\n````" });
    frame({}, "stop");
    response.end("data: [DONE]\n\n");
};

const fixture = async (t: TestContext, infer: Inference) => {
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
        PLURNK_MODEL: "idlefixture",
        PLURNK_MODEL_idlefixture: "openai/idle-fixture",
        PLURNK_BASEURL_idlefixture: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_API_KEY: "idle-fixture",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
        PLURNK_PROVIDERS_EFFORT: "off",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(() => daemon.cleanup());
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    const tui = spawnTui(daemon.url, [
        "--workspace", "idle-observation", "--worker", "main", "--project-root", "", "--max-turns", "6",
    ], { HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "" }, daemon.workspace);
    t.after(() => tui.kill());
    await tui.waitFor(/plurnk[\s\S]*\/help/);
    return { tui, daemon };
};

test("{§cli-summary-line-per-loop} a completed loop keeps its one summary when the daemon stops under the idle session", { timeout: 120_000 }, async (t) => {
    const { tui, daemon } = await fixture(t, async (_request, response) => { answer(response, "FIRST_PROMPT_ANSWERED"); });
    tui.write("Answer once.\r");
    await tui.waitFor(/FIRST_PROMPT_ANSWERED/);
    await tui.waitFor(/done · \d+ turns?/);
    const afterSummary = tui.output().length;
    process.kill(daemon.pid, "SIGTERM");
    const diagnostic = await tui.waitFor(/problem:Service stopping/, 30_000, afterSummary);
    assert.match(diagnostic, /❌ problem:Service stopping — The PLURNK service is shutting down\./u, "the ending is diagnosed as a Problem row");
    assert.doesNotMatch(tui.output(), /final 503|turns unknown/u, "an ended observation is no loop outcome");
    assert.equal(tui.output().match(/done · \d+ turns? · /gu)?.length, 1, "the completed loop's summary stands alone");
});

test("{§cli-summary-line-per-loop} an idle attachment that the daemon ends prints no summary and no tally", { timeout: 120_000 }, async (t) => {
    const { tui, daemon } = await fixture(t, async (_request, response) => { answer(response, "UNUSED"); });
    const attached = tui.output().length;
    process.kill(daemon.pid, "SIGTERM");
    await tui.waitFor(/problem:Service stopping/, 30_000, attached);
    assert.doesNotMatch(tui.output(), /final \d+ · |turns unknown|· \d+ turns? · /u, "nothing was summarized or tallied");
});
