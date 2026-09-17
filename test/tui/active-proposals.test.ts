import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { bootDaemon, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

test("[§cli-active-command-admission] stopping a model proposal preserves a concurrent client proposal", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service);
    let requests = 0;
    const endpoint = createServer(async (request, response) => {
        if (request.method !== "POST") {
            response.writeHead(200, { "content-type": "application/json" }).end('{"object":"list","data":[]}');
            return;
        }
        for await (const _chunk of request) { /* drain the fixture request */ }
        requests += 1;
        const content = "```sh\nprintf model-result > model.txt\n```\n```WAIT\nAwait the command.\n```";
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ id: "proposal-fixture", object: "chat.completion.chunk", choices: [
            { index: 0, delta: { role: "assistant", content }, finish_reason: null },
        ] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id: "proposal-fixture", object: "chat.completion.chunk", choices: [
            { index: 0, delta: {}, finish_reason: "stop" },
        ], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
        response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    t.after(() => { endpoint.closeAllConnections(); return new Promise<void>((resolve) => endpoint.close(() => resolve())); });
    const address = endpoint.address();
    assert.ok(address !== null && typeof address !== "string");
    const daemon = await bootDaemon(service, { extraEnv: {
        PLURNK_MODEL: "proposalfixture",
        PLURNK_MODEL_proposalfixture: "openai/proposal-fixture",
        PLURNK_BASEURL_proposalfixture: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_API_KEY: "proposal-fixture",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
        PLURNK_PROVIDERS_REASONING: "off",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(() => daemon.cleanup());
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    const tui = spawnTui(daemon.url, ["--workspace", "proposal-controls", "--worker", "main", "--max-turns", "3"], {
        HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "", PLURNK_CLIENT_YOLO: "0",
    }, daemon.workspace);
    t.after(() => tui.kill());
    await tui.waitFor(/plurnk[\s\S]*\/help/);
    tui.write("? Write the model witness.\r");
    await tui.waitFor(/resolve: a\/e\/r\/c/);
    tui.write("! printf client-result > client.txt && printf '\\141\\143\\164\\151\\157\\156\\055\\144\\157\\156\\145'\r");
    tui.write("/model\r");
    await tui.waitFor(/model: proposalfixture/);
    tui.write("/stop\r");
    await tui.waitFor(/cancelled|final 499/);
    await tui.waitFor(/(?:resolve: a\/e\/r\/c[\s\S]*){2}/);
    await assert.rejects(readFile(join(daemon.workspace, "model.txt")), { code: "ENOENT" });
    await assert.rejects(readFile(join(daemon.workspace, "client.txt")), { code: "ENOENT" });
    tui.write("/accept\r");
    await tui.waitFor(/action-done/);
    assert.equal(await readFile(join(daemon.workspace, "client.txt"), "utf8"), "client-result");
    await assert.rejects(readFile(join(daemon.workspace, "model.txt")), { code: "ENOENT" });
    assert.equal(requests, 1, "only the human's operation is resumed after cancelling the model");
    tui.write("/attach next\r");
    await tui.waitFor(/worker: next \(new\)/);
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);
});
