import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { stripVTControlCharacters } from "node:util";
import { bootDaemon, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

// plurnk-service {§agui-message-acceptance}: a message accepted while the worker's loop runs waits for its next turn; a
// loop cancelled first leaves it accepted and unread, listed with that loop's lifecycle.
test("[§cli-status-inbox] a message another client sent while the loop ran is said once to be unread when that loop is stopped, and a later session says nothing", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service, "the composed client test requires the sibling service");
    const incoming = Promise.withResolvers<ServerResponse>();
    const endpoint = createServer(async (request, response) => {
        if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [] }));
            return;
        }
        for await (const _chunk of request) { /* consume the complete request before holding inference */ }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ id: "inbox-fixture", object: "chat.completion.chunk", choices: [
            { index: 0, delta: { role: "assistant", reasoning_content: "The inference stream is held open." }, finish_reason: null },
        ] })}\n\n`);
        incoming.resolve(response);
    });
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    t.after(() => { endpoint.closeAllConnections(); return new Promise<void>((resolve) => endpoint.close(() => resolve())); });
    const address = endpoint.address();
    assert.ok(address !== null && typeof address !== "string");
    const daemon = await bootDaemon(service, { readyTimeoutMs: 30_000, extraEnv: {
        PLURNK_MODEL: "inboxfixture",
        PLURNK_MODEL_inboxfixture: "openai/inbox-fixture",
        PLURNK_BASEURL_inboxfixture: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_API_KEY: "inbox-fixture",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
        PLURNK_PROVIDERS_EFFORT: "off",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(() => daemon.cleanup());
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    const tui = spawnTui(daemon.url, ["--workspace", "inbox", "--worker", "main", "--project-root", ""], {
        HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "", PLURNK_CLIENT_YOLO: "0",
    }, daemon.workspace);
    t.after(() => tui.kill());
    await tui.waitFor(/plurnk[\s\S]*\/help/);
    tui.write("Keep the inference open.\r");
    await incoming.promise;
    await tui.waitFor(/inference stream is held open/);

    // Another client sends the worker a message while its loop runs; the daemon accepts it for the loop's next turn.
    const other = new AbortController();
    t.after(() => other.abort());
    const sent = await fetch(daemon.url, {
        method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, signal: other.signal,
        body: JSON.stringify({ threadId: "main", runId: "follow-up-run", state: {}, tools: [], context: [],
            messages: [{ id: "follow-up", role: "user", content: "Also note the deadline." }], forwardedProps: { plurnk: { workspace: "inbox" } } }),
    });
    assert.equal(sent.status, 200);
    const reader = sent.body!.getReader();
    for (let seen = ""; !seen.includes("RUN_STARTED");) {
        const { value, done } = await reader.read();
        assert.equal(done, false, "the other client's Run opens");
        seen += new TextDecoder().decode(value);
    }

    tui.write("/stop\r");
    await tui.waitFor(/cancelled|final 499/);
    // The notice wraps at the terminal's width; the message is named by its address, another client's words being its own.
    await tui.waitFor(/was not read: the loop holding[\s\S]*?it was cancelled first[\s\S]*?agui:\/\/\S*\/messages\/follow-up/u, 20_000);
    tui.write("/workers\r");
    await tui.waitFor(/● main/);
    assert.equal(stripVTControlCharacters(tui.output()).match(/was not read: the loop holding\s+it was cancelled first/gu)?.length, 1, "said once");
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);

    // A later session attaches after that loop concluded: the unread message is the loop's past, said by no one again.
    const later = spawnTui(daemon.url, ["--workspace", "inbox", "--worker", "main", "--project-root", ""], {
        HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "", PLURNK_CLIENT_YOLO: "0",
    }, daemon.workspace);
    t.after(() => later.kill());
    await later.waitFor(/plurnk[\s\S]*\/help/);
    later.write("/workers\r");
    await later.waitFor(/● main/);
    assert.doesNotMatch(stripVTControlCharacters(later.output()), /was not read/u);
    later.write("/quit\r");
    assert.equal(await later.exited, 0);
});
