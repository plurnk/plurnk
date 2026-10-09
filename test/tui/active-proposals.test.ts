import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { bootDaemon, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";
import { AguiTransport } from "../../src/transport.ts";

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
        const content = requests === 1
            ? "````sh\nprintf model-result > model.txt\n````\n````WAIT\nAwait the command.\n````"
            : requests === 2
                ? "````sh\nprintf child-result > child.txt\n````\n````WAIT\n````"
                : "````SEND [200]\nChild finished.\n````";
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
        PLURNK_PROVIDERS_EFFORT: "off",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(() => daemon.cleanup());
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    const tui = spawnTui(daemon.url, ["--workspace", "proposal-controls", "--worker", "main", "--max-turns", "3"], {
        HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "", PLURNK_CLIENT_YOLO: "0",
    }, daemon.workspace);
    t.after(() => tui.kill());
    t.after(() => { if (!t.passed) t.diagnostic(stripVTControlCharacters(tui.output())); });
    await tui.waitFor(/plurnk[\s\S]*\/help/);
    tui.write("? Write the model witness.\r");
    await tui.waitFor(/↑\/↓: choose.*Enter: confirm.*Esc: composer/);
    tui.write("\x1b");
    await tui.waitFor(/1 pending review.*\/review/);
    tui.write("! printf client-result > client.txt && printf '\\141\\143\\164\\151\\157\\156\\055\\144\\157\\156\\145'; while [ ! -f release-client ]; do sleep 0.05; done; printf '\\143\\154\\151\\145\\156\\164\\055\\163\\145\\164\\164\\154\\145\\144'\r");
    await tui.waitFor(/2 pending reviews.*\/review/);
    tui.write("/model\r");
    await tui.waitFor(/model: proposalfixture/);
    tui.write("/stop\r");
    await tui.waitFor(/cancelled|final 499/);
    await assert.rejects(readFile(join(daemon.workspace, "model.txt")), { code: "ENOENT" });
    await assert.rejects(readFile(join(daemon.workspace, "client.txt")), { code: "ENOENT" });
    const since = tui.output().length;
    tui.write("/review\r");
    await tui.waitFor(/↑\/↓: choose.*Enter: confirm.*Esc: composer/, 10_000, since);
    tui.write("\r");
    await t.waitFor(async () => assert.equal(await readFile(join(daemon.workspace, "client.txt"), "utf8"), "client-result"), { timeout: 10_000 });
    assert.equal(await readFile(join(daemon.workspace, "client.txt"), "utf8"), "client-result");
    await assert.rejects(readFile(join(daemon.workspace, "model.txt")), { code: "ENOENT" });
    assert.equal(requests, 1, "only the human's operation is resumed after cancelling the model");
    const parent = new AguiTransport({ aguiUrl: daemon.url }, "main", { workspace: "proposal-controls" });
    const child = new AguiTransport({ aguiUrl: daemon.url }, "background", { workspace: "proposal-controls" });
    t.after(() => { parent.shutdown(); child.shutdown(); });
    await parent.rpc("run.fork", { name: "background" });
    const childReview = tui.output().length;
    const work = child.run("Write the child witness.", { maxTurns: 3 });
    void work.done.catch(() => {});
    await tui.waitFor(/↑\/↓: choose.*Enter: confirm.*Esc: composer/, 10_000, childReview);
    await assert.rejects(readFile(join(daemon.workspace, "child.txt")), { code: "ENOENT" });
    tui.write("\r");
    assert.equal((await work.done).finalStatus, 200);
    assert.equal(await readFile(join(daemon.workspace, "child.txt"), "utf8"), "child-result",
        "the owner can review new work while the already-approved client command is still running");
    await writeFile(join(daemon.workspace, "release-client"), "release");
    await tui.waitFor(/client-settled/);
    tui.write("/attach next\r");
    await tui.waitFor(/worker: next \(new\)/);
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);
});
