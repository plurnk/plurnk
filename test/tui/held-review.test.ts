// [§cli-inline-review] [§cli-review-menu-interactive] plurnk-service {§agui-held-interrupts} — two views of one worker on the
// real daemon: the built TUI or the one-shot CLI with manual review, and a second client of the same thread. Whichever
// answers the gate, the other's review is withdrawn, never answered there, and it follows the work that continues; the
// command runs once.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { bootDaemon, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";
import { openTransport } from "../transport.ts";
import type { RunHandlers } from "../../src/transport.ts";

// A model that runs one reviewed command, then answers. Given a prompt, the built client runs it one-shot and the second
// view joins once its review menu shows; otherwise the TUI starts and the second view joins once it is up.
const boot = async (t: TestContext, workspace: string, prompt?: string) => {
    const service = await locateDaemon();
    assert.ok(service, "the composed client test requires the sibling service");
    let requests = 0;
    const endpoint = createServer(async (request, response) => {
        if (request.method !== "POST") {
            response.writeHead(200, { "content-type": "application/json" }).end('{"object":"list","data":[]}');
            return;
        }
        for await (const _chunk of request) { /* drain the fixture request */ }
        requests += 1;
        const content = requests === 1 ? "````sh\nprintf once >> ran.txt\n````" : "````SEND [200]\nThe command ran.\n````";
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ id: "held-fixture", object: "chat.completion.chunk", choices: [
            { index: 0, delta: { role: "assistant", content }, finish_reason: null },
        ] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id: "held-fixture", object: "chat.completion.chunk", choices: [
            { index: 0, delta: {}, finish_reason: "stop" },
        ], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
        response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    t.after(() => { endpoint.closeAllConnections(); return new Promise<void>((resolve) => endpoint.close(() => resolve())); });
    const address = endpoint.address();
    assert.ok(address !== null && typeof address !== "string");
    const daemon = await bootDaemon(service, { extraEnv: {
        PLURNK_MODEL: "heldfixture",
        PLURNK_MODEL_heldfixture: "openai/held-fixture",
        PLURNK_BASEURL_heldfixture: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_API_KEY: "held-fixture",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
        PLURNK_PROVIDERS_EFFORT: "off",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(() => daemon.cleanup());
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    const tui = spawnTui(daemon.url, ["--workspace", workspace, "--worker", "main", "--max-turns", "3", ...(prompt === undefined ? [] : [prompt])], {
        HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "", PLURNK_CLIENT_YOLO: "0",
    }, daemon.workspace);
    t.after(() => tui.kill());
    t.after(() => { if (!t.passed) t.diagnostic(stripVTControlCharacters(tui.output())); });
    // The client acquires the workspace, its project root among its options; the second view then joins it.
    await tui.waitFor(prompt === undefined ? /plurnk[\s\S]*\/help/ : /\[a\]ccept · \[e\]dit · \[r\]eject · \[c\]ancel/);
    const other = await openTransport({ aguiUrl: daemon.url }, "main", { workspace });
    t.after(() => other.shutdown());
    const ran = async (): Promise<string> => await readFile(join(daemon.workspace, "ran.txt"), "utf8").catch(() => "");
    return { tui, other, ran, requests: () => requests };
};

const quiet: RunHandlers = {
    onEntry: () => {}, onHistory: () => {}, onOutside: () => {}, onReasoning: () => {}, onProposal: () => {}, onInteraction: () => {},
    onStream: () => {}, onNotice: () => {}, onProblem: () => {}, onTerminated: () => {}, onStatus: () => {},
};

test("[§cli-inline-review] a review another client settles is withdrawn, and the TUI follows the work", { timeout: 90_000 }, async (t) => {
    const { tui, other, ran, requests } = await boot(t, "held-elsewhere");
    tui.write("Run the command.\r");
    await tui.waitFor(/↑\/↓: choose.*Enter: confirm.*Esc: composer/);
    const reviewing = tui.output().length;

    // The second view is presented the same gate, accepts it automatically, and follows the work to its end.
    other.subscribe({ ...quiet, onProposal: (proposal) => { void other.resolve({ logEntryId: proposal.logEntryId, decision: "accept" }); } });
    const observed = await other.observe().done;
    assert.equal(observed?.finalStatus, 200, "the answering view saw the work complete");

    await tui.waitFor(/The command ran\./, 15_000, reviewing);
    assert.equal(await ran(), "once", "the command ran once");
    assert.equal(requests(), 2, "and the model answered once after it");
    const asked = tui.output().length;
    tui.write("/review\r");
    await tui.waitFor(/\(no pending review\)/, 10_000, asked);
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);
});

test("[§cli-inline-review] a client holding a review converges when the TUI answers it", { timeout: 90_000 }, async (t) => {
    const { tui, other, ran } = await boot(t, "held-here");
    tui.write("Run the command.\r");
    await tui.waitFor(/↑\/↓: choose.*Enter: confirm.*Esc: composer/);

    // The second view is presented the gate and holds it for its person, who never answers.
    const presented = Promise.withResolvers<void>();
    const ended: string[] = [];
    other.subscribe({ ...quiet, onProposal: () => presented.resolve(), onInterruptEnd: (id) => ended.push(id) });
    const observation = other.observe();
    await presented.promise;
    await new Promise((resolve) => setTimeout(resolve, 300));

    tui.write("\r");
    const observed = await observation.done;
    assert.equal(observed?.finalStatus, 200, "the holding view follows the work to its end");
    assert.equal(ended.length, 1, "its review was withdrawn");
    assert.match(ended[0] ?? "", /^proposal:\d+$/u);
    assert.equal(await ran(), "once", "the command ran once");
    await tui.waitFor(/The command ran\./, 15_000);
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);
});

test("[§cli-review-menu-interactive] a one-shot menu another client settles withdraws, and the CLI follows the work to its end", { timeout: 90_000 }, async (t) => {
    const { tui: cli, other, ran, requests } = await boot(t, "held-cli-elsewhere", "Run the command.");
    other.subscribe({ ...quiet, onProposal: (proposal) => { void other.resolve({ logEntryId: proposal.logEntryId, decision: "accept" }); } });
    assert.equal((await other.observe().done)?.finalStatus, 200, "the answering view saw the work complete");
    await cli.waitFor(/settled elsewhere/, 15_000);
    await cli.waitFor(/The command ran\./, 15_000);
    assert.equal(await cli.exited, 0, "the CLI followed the work to its end");
    assert.equal(await ran(), "once", "the command ran once");
    assert.equal(requests(), 2);
});

test("[§cli-review-menu-interactive] a client holding a review converges when the one-shot menu answers it", { timeout: 90_000 }, async (t) => {
    const { tui: cli, other, ran } = await boot(t, "held-cli-here", "Run the command.");
    const presented = Promise.withResolvers<void>();
    const ended: string[] = [];
    other.subscribe({ ...quiet, onProposal: () => presented.resolve(), onInterruptEnd: (id) => ended.push(id) });
    const observation = other.observe();
    await presented.promise;
    await new Promise((resolve) => setTimeout(resolve, 300));

    cli.write("a");
    assert.equal((await observation.done)?.finalStatus, 200, "the holding view follows the work to its end");
    assert.deepEqual(ended.map((id) => /^proposal:\d+$/u.test(id)), [true], "its review was withdrawn");
    assert.equal(await cli.exited, 0);
    assert.equal(await ran(), "once", "the command ran once");
    assert.doesNotMatch(stripVTControlCharacters(cli.output()), /settled elsewhere/u, "the CLI's own answer withdrew nothing of its own");
});
