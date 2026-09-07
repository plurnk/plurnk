import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { bootDaemon, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

for (const action of ["accept", "cancel"]) {
    test(`[§cli-question-forms]: ${action} resumes a question's WAIT through the TUI and AG-UI`, { timeout: 90_000 }, async (t) => {
        const service = await locateDaemon();
        if (service === null) { t.skip("no plurnk-service binary reachable"); return; }
        const requests: string[] = [];
        const question = JSON.stringify({ message: "Supply the branch details.", requestedSchema: {
            type: "object", properties: {
                branch: { type: "string" }, count: { type: "integer" }, notes: { type: "string" },
            }, required: ["count"],
        } });
        // The same deterministic provider fixture posture as model-selection.test.ts.
        const endpoint = createServer(async (request, response) => {
            if (request.method === "GET" && request.url === "/v1/models") {
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify({ object: "list", data: [] }));
                return;
            }
            if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
                response.writeHead(404).end();
                return;
            }
            let body = "";
            for await (const chunk of request) body += chunk;
            requests.push(body);
            const content = requests.length === 1
                ? `## PLAN0\n[]\n### EXEC0 [question] (question)\n${question}\n### SEND0 (WAIT)\nAwaiting branch details.`
                : `## PLAN0\n[]\n### SEND0 (TERM)\nQuestion ${action} continuation finished.`;
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(`data: ${JSON.stringify({
                id: "question-fixture", object: "chat.completion.chunk", created: 1, model: "question-fixture",
                choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
            })}\n\n`);
            response.write(`data: ${JSON.stringify({
                id: "question-fixture", object: "chat.completion.chunk", created: 1, model: "question-fixture",
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            })}\n\n`);
            response.end("data: [DONE]\n\n");
        });
        await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
        t.after(() => new Promise<void>((resolve, reject) => endpoint.close((error) => error ? reject(error) : resolve())));
        const address = endpoint.address();
        assert.ok(address !== null && typeof address !== "string");
        const daemon = await bootDaemon(service, { readyTimeoutMs: 30_000, extraEnv: {
            PLURNK_MODEL: "questionfixture",
            PLURNK_MODEL_questionfixture: "openai/question-fixture",
            PLURNK_BASEURL_questionfixture: `http://127.0.0.1:${address.port}/v1`,
            OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
            OPENAI_API_KEY: "question-fixture",
            PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
            PLURNK_PROVIDERS_REASONING: "off",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
            PLURNK_EXECS_QUESTION: "1",
            PLURNK_SERVICE_OPTIMISTIC_WAIT_MS: "0",
        } });
        t.after(() => daemon.cleanup());
        const tui = spawnTui(daemon.url, ["--project-root", "", "--max-turns", "3"], {
            HOME: daemon.home, PLURNK_MODEL: "", XDG_CONFIG_HOME: `${daemon.home}/.config`,
        }, daemon.workspace);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write("Ask for branch details.\r");
            await tui.waitFor(/branch \(string; optional; Enter skips\)/, 30_000);
            if (action === "cancel") tui.write("/cancel\r");
            else {
                tui.write("\r");
                await tui.waitFor(/count \(integer; required\)/);
                tui.write("wrong-type\r");
                await tui.waitFor(/count requires a JSON integer value/);
                tui.write("0\r");
                await tui.waitFor(/notes \(string; optional; Enter skips\)/);
                tui.write("typed-through-the-tui\r");
            }
            await tui.waitFor(new RegExp(`Question ${action} continuation finished`), 30_000);
            assert.equal(requests.length, 2, "the answered WAIT resumes exactly once");
            const packet = JSON.parse(requests[1]!).messages.map((message: { content: unknown }) => JSON.stringify(message.content)).join("\n");
            assert.match(packet, new RegExp(action), "the continuation receives the elicitation result");
            if (action === "accept") {
                assert.match(packet, /typed-through-the-tui/);
                assert.match(packet, /count/);
            }
            tui.write("/quit\r");
            assert.equal(await tui.exited, 0);
        } finally { tui.kill(); }
    });
}
