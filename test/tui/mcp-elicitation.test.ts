import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { bootDaemon, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

const fixture = fileURLToPath(new URL("../../../plurnk-service/plurnk-mcp/src/fixtures/interaction-server.mjs", import.meta.url));
const cases = [
    {
        name: "batch accept/decline with correction", tool: "batch",
        steps: [
            { prompt: /Who is making this request/, answer: "{" },
            { prompt: /requires valid JSON/, answer: '{"profile":{"action":"accept","content":{"name":42}},"approval":{"action":"decline"}}' },
            { prompt: /Response does not satisfy/, answer: '{"profile":{"action":"accept","content":{"name":"Ada"}},"approval":{"action":"decline"}}' },
        ],
        expected: [/Ada/, /"action":\s*"decline"/],
    },
    {
        name: "batch cancellation", tool: "batch",
        steps: [{ prompt: /Who is making this request/, answer: "/cancel" }],
        expected: [/"action":\s*"cancel"/],
    },
    {
        name: "URL accept", tool: "url",
        steps: [{ prompt: /https:\/\/example\.test\/authorize/, answer: '{"authorize":{"action":"accept"}}' }],
        expected: [/accept/],
    },
    {
        name: "URL decline", tool: "url",
        steps: [{ prompt: /https:\/\/example\.test\/authorize/, answer: '{"authorize":{"action":"decline"}}' }],
        expected: [/decline/],
    },
    {
        name: "successive MRTR forms", tool: "round-trip",
        steps: [
            { prompt: /Name the operator/, answer: '{"name":{"action":"accept","content":{"name":"Ada"}}}' },
            { prompt: /Confirm Ada as the operator/, answer: '{"confirm":{"action":"accept","content":{"confirm":true}}}' },
        ],
        expected: [/Ada confirmed/],
    },
] as const;

for (const specimen of cases) {
    test(`[§cli-question-forms]: real MCP ${specimen.name} through the built TUI`, { timeout: 90_000 }, async (t) => {
        const service = await locateDaemon();
        if (service === null) { t.skip("no plurnk-service binary reachable"); return; }
        const requests: string[] = [];
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
                ? `\`\`\`fixture (${specimen.tool})\n{}\n\`\`\`\n\n\`\`\`TASK\n[{"content":"Await the MCP result.","status":"waiting"}]\n\`\`\``
                : '```SEND\nMCP interaction finished.\n```\n\n```TASK\n[{"content":"MCP result received.","status":"completed"}]\n```';
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(`data: ${JSON.stringify({
                id: "elicitation-fixture", object: "chat.completion.chunk", created: 1, model: "elicitation-fixture",
                choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
            })}\n\n`);
            response.write(`data: ${JSON.stringify({
                id: "elicitation-fixture", object: "chat.completion.chunk", created: 1, model: "elicitation-fixture",
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
            PLURNK_MODEL: "elicitationfixture",
            PLURNK_MODEL_elicitationfixture: "openai/elicitation-fixture",
            PLURNK_BASEURL_elicitationfixture: `http://127.0.0.1:${address.port}/v1`,
            OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
            OPENAI_API_KEY: "elicitation-fixture",
            PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
            PLURNK_PROVIDERS_REASONING: "off",
            PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
            PLURNK_MCP_ENABLED: '["fixture"]',
            PLURNK_MCP_FIXTURE: process.execPath,
            PLURNK_MCP_FIXTURE_ARGS: JSON.stringify([fixture]),
            PLURNK_MCP_FIXTURE_READ: '["batch","round-trip","url"]',
            PLURNK_MCP_REQUEST_TIMEOUT: "60000",
            PLURNK_SERVICE_OPTIMISTIC_WAIT_MS: "0",
        } });
        t.after(() => daemon.cleanup());
        const tui = spawnTui(daemon.url, ["--project-root", "", "--max-turns", "3"], {
            HOME: daemon.home, PLURNK_MODEL: "", XDG_CONFIG_HOME: `${daemon.home}/.config`,
        }, daemon.workspace);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write("Perform the MCP operation.\r");
            let since = tui.output().length;
            for (const { prompt, answer } of specimen.steps) {
                await tui.waitFor(prompt, 15_000, since);
                assert.equal(requests.length, 1, "input and intermediate MRTR rounds do not start another model turn");
                since = tui.output().length;
                tui.write(`${answer}\r`);
            }
            await tui.waitFor(/MCP interaction finished/, 30_000, since);
            assert.equal(requests.length, 2, "the original MCP operation resumes exactly once after settlement");
            const packet = JSON.parse(requests[1]!).messages.map((message: { content: unknown }) =>
                typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
            for (const expected of specimen.expected) assert.match(packet, expected, "the actual server result reaches the model");
            assert.doesNotMatch(packet, /tool-call-failed|interaction-response-invalid/);
            tui.write("/quit\r");
            assert.equal(await tui.exited, 0);
        } finally { tui.kill(); }
    });
}
