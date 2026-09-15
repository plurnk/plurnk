import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { bootDaemon, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

test("[§cli-active-command-admission] ordinary commands and client operations remain available during a controlled model run", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service, "the composed client test requires the sibling service");
    const incoming = Promise.withResolvers<ServerResponse>();
    let requests = 0;
    const endpoint = createServer(async (request, response) => {
        if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
            response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [] }));
            return;
        }
        for await (const _chunk of request) { /* consume the complete request before holding inference */ }
        requests += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ id: "active-fixture", object: "chat.completion.chunk", choices: [
            { index: 0, delta: { role: "assistant", reasoning_content: "The controlled inference stream is open." }, finish_reason: null },
        ] })}\n\n`);
        incoming.resolve(response);
    });
    await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
    t.after(() => { endpoint.closeAllConnections(); return new Promise<void>((resolve) => endpoint.close(() => resolve())); });
    const address = endpoint.address();
    assert.ok(address !== null && typeof address !== "string");
    const daemon = await bootDaemon(service, { readyTimeoutMs: 30_000, extraEnv: {
        PLURNK_MODEL: "activefixture",
        PLURNK_MODEL_activefixture: "openai/active-fixture",
        PLURNK_MODEL_alternate: "openai/alternate-fixture",
        PLURNK_BASEURL_activefixture: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_API_KEY: "active-fixture",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
        PLURNK_PROVIDERS_REASONING: "off",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(() => daemon.cleanup());
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    const tui = spawnTui(daemon.url, ["--workspace", "active-controls", "--worker", "main", "--project-root", "", "--max-turns", "3"], {
        HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "",
    }, daemon.workspace);
    t.after(() => tui.kill());
    await tui.waitFor(/plurnk.*\/help/);
    tui.write("Keep the inference open.\r");
    await incoming.promise;
    await tui.waitFor(/controlled inference stream is open/);

    tui.write("/yolo\r");
    await tui.waitFor(/yolo: OFF/);
    tui.write("/yolo\r");
    await tui.waitFor(/yolo: ON/);
    tui.write("/env add CARGO_TARGET_DIR /tmp/active-controls\r");
    await tui.waitFor(/added: CARGO_TARGET_DIR/);
    tui.write("/env\r");
    await tui.waitFor(/CARGO_TARGET_DIR\s+worker\s+active/);
    tui.write("/model alternate\r");
    await tui.waitFor(/unfinished tasks/);
    tui.write("/model\r");
    await tui.waitFor(/model: activefixture/);
    tui.write("/workers\r");
    await tui.waitFor(/● main/);

    tui.write("/attach elsewhere\r");
    await tui.waitFor(/conversation.*attached/);
    tui.write("\x1bh");
    await tui.waitFor(/(?:conversation.*attached[\s\S]*){2}/);

    tui.write("! printf '\\141\\143\\164\\151\\157\\156\\055\\157\\153'\r");
    await tui.waitFor(/action-ok/);
    tui.write("/look worker:///missing.md\r");
    await tui.waitFor(/LOOK \(worker:\/\/\/missing\.md\) —/);
    assert.equal(requests, 1, "commands did not request more inference");
    assert.doesNotMatch(tui.output(), /busy;|loop running —/, "no blanket busy path");
    tui.write("... added while streaming\r");
    await tui.waitFor(/added to the run/);
    tui.write("? do this in review mode\r");
    await tui.waitFor(/review.*new loop/);
    tui.write("/stop\r");
    await tui.waitFor(/cancelled|final 499/);
    tui.write("/attach elsewhere\r");
    await tui.waitFor(/worker: elsewhere \(new\)/);
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);
});
