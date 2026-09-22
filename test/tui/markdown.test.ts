import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { stripVTControlCharacters } from "node:util";
import { bootDaemon, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

test("[§cli-markdown-projection] built TUI survives nested lists, long code, and Mermaid source fallback", { timeout: 60_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service, "the composed rendering test requires the sibling service");
    const responseBody = [
        "2. **Addressable Context**: Everything in the agent environment is an addressable URI resource:",
        "   * `file:///` / project relative paths: Local project source code.",
        "   * `worker:///`: Extended worker context and sub-worker communication.",
        "",
        "```text",
        "abcdefghijklmnopqrstuvwxyz".repeat(8),
        "```",
        "",
        "```mermaid",
        "graph TD",
        `a[${"abcdefghijklmnopqrstuvwxyz".repeat(8)}] --> b[End]`,
        "```",
        "",
        "RENDER_FINISHED",
    ].join("\n");
    let calls = 0;
    const provider = createServer((request, response) => {
        if (request.method !== "POST") { response.writeHead(200).end("{}"); return; }
        request.resume();
        calls++;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({
            id: "markdown-fixture", object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { role: "assistant", content: `\`\`\`\`KILL\n${responseBody}\n\`\`\`\`` }, finish_reason: null }],
        })}\n\n`);
        response.write(`data: ${JSON.stringify({
            id: "markdown-fixture", object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`);
        response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    t.after(() => {
        provider.closeAllConnections();
        return new Promise<void>((resolve) => provider.close(() => resolve()));
    });
    const address = provider.address();
    assert.ok(address !== null && typeof address !== "string");
    const daemon = await bootDaemon(service, { readyTimeoutMs: 30_000, extraEnv: {
        PLURNK_MODEL: "markdownfixture",
        PLURNK_MODEL_markdownfixture: "openai/markdown-fixture",
        OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
        OPENAI_API_KEY: "markdown-fixture",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
        PLURNK_PROVIDERS_REASONING: "off",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(() => daemon.cleanup());
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    const tui = spawnTui(daemon.url, ["--workspace", "markdown", "--worker", "main", "--project-root", ""], {
        HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "", NO_COLOR: "",
    }, daemon.workspace);
    t.after(() => tui.kill());
    await tui.waitFor(/plurnk.*\/help/);
    tui.write("Describe the project.\r");
    await tui.waitFor(/RENDER_FINISHED/);
    const output = stripVTControlCharacters(tui.output());
    assert.match(output, /Addressable Context/);
    assert.match(output, /💻 mermaid/);
    assert.doesNotMatch(output, /exceeds terminal width|rendered width|mermaid source|runtime:error/);
    const afterResponse = tui.output().length;
    tui.write("/model\r");
    await tui.waitFor(/model:.*markdownfixture/, 10_000, afterResponse);
    assert.equal(calls, 1);
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);
});
