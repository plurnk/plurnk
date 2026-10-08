import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AguiTransport } from "../../src/transport.ts";
import { bootDaemon, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

test("[§cli-worker-ownership] an idle TUI reviews later child work after inspection and a direct command", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service);
    let requests = 0;
    const endpoint = createServer(async (request, response) => {
        if (request.method !== "POST") {
            response.writeHead(200, { "content-type": "application/json" }).end('{"object":"list","data":[]}');
            return;
        }
        for await (const _chunk of request) { /* drain the fixture request */ }
        const content = requests++ === 0
            ? "````sh\nprintf child-result > child.txt\n````\n````WAIT\n````"
            : "````KILL\nChild work completed.\n````";
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ id: "owner-fixture", object: "chat.completion.chunk", choices: [
            { index: 0, delta: { role: "assistant", content }, finish_reason: null },
        ] })}\n\n`);
        response.write(`data: ${JSON.stringify({ id: "owner-fixture", object: "chat.completion.chunk", choices: [
            { index: 0, delta: {}, finish_reason: "stop" },
        ], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
        response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    t.after(() => { endpoint.closeAllConnections(); return new Promise<void>((resolve) => endpoint.close(() => resolve())); });
    const address = endpoint.address();
    assert.ok(address !== null && typeof address !== "string");
    const daemon = await bootDaemon(service, { extraEnv: {
        PLURNK_MODEL: "ownerfixture",
        PLURNK_MODEL_ownerfixture: "openai/owner-fixture",
        PLURNK_BASEURL_ownerfixture: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_API_KEY: "owner-fixture",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
        PLURNK_PROVIDERS_EFFORT: "off",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(() => daemon.cleanup());
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    const tui = spawnTui(daemon.url, ["--workspace", "idle-owner", "--worker", "main"], {
        HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "", PLURNK_CLIENT_YOLO: "0",
    }, daemon.workspace);
    t.after(() => tui.kill());
    await tui.waitFor(/plurnk[\s\S]*\/help/);
    tui.write("/model\r");
    await tui.waitFor(/model: ownerfixture/);
    tui.write("! printf local-result > local.txt && printf '\\141\\143\\164\\151\\157\\156\\055\\144\\157\\156\\145'\r");
    await tui.waitFor(/↑\/↓: choose.*Enter: confirm.*Esc: composer/);
    tui.write("\r");
    await tui.waitFor(/action-done/);
    assert.equal(await readFile(join(daemon.workspace, "local.txt"), "utf8"), "local-result");
    assert.equal(requests, 0, "inspection and direct commands admit no model inference");

    const parent = new AguiTransport({ aguiUrl: daemon.url }, "main", { workspace: "idle-owner" });
    t.after(() => parent.shutdown());
    await parent.rpc("run.fork", { name: "background" });
    const child = new AguiTransport({ aguiUrl: daemon.url }, "background", { workspace: "idle-owner" });
    t.after(() => child.shutdown());
    const since = tui.output().length;
    const running = child.run("Write the child witness.", { maxTurns: 3 });
    void running.done.catch(() => {});
    await tui.waitFor(/↑\/↓: choose.*Enter: confirm.*Esc: composer/, 20_000, since);
    await assert.rejects(readFile(join(daemon.workspace, "child.txt")), { code: "ENOENT" });
    tui.write("\r");
    assert.equal((await running.done).finalStatus, 200);
    assert.equal(await readFile(join(daemon.workspace, "child.txt"), "utf8"), "child-result");
    assert.equal(requests, 2, "only the child runs; answering its approval does not prompt the parent");
    const afterChild = tui.output().length;
    tui.write("/model\r");
    await tui.waitFor(/model: ownerfixture/, 10_000, afterChild);
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);
});
