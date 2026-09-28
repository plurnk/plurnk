import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { bootDaemon, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

test("[§cli-status-descendants] child settlements update the parked footer and enter the session total once", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service, "the composed test requires the sibling service");
    const arrived = Array.from({ length: 8 }, () => Promise.withResolvers<void>());
    const release = Array.from({ length: 8 }, () => Promise.withResolvers<void>());
    const failures: unknown[] = [];
    const packets: string[] = [];
    let calls = 0;
    const provider = createServer((request, response) => {
        void (async () => {
            if (request.method !== "POST") { response.writeHead(200).end("{}"); return; }
            let body = "";
            for await (const chunk of request) body += chunk;
            const input = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
            packets.push(input.messages.filter(({ role }) => role === "user").map(({ content }) => content).join("\n"));
            const index = calls++;
            assert.ok(index < arrived.length, "only the scripted parent and child turns run");
            response.writeHead(200, { "content-type": "text/event-stream" });
            const frame = (delta: object, finish_reason: string | null = null): void => {
                response.write(`data: ${JSON.stringify({
                    id: `descendant-status-${index}`, object: "chat.completion.chunk",
                    choices: [{ index: 0, delta, finish_reason }],
                })}\n\n`);
            };
            frame({ role: "assistant", reasoning_content: `ACCOUNTING_REASONING_${index}` });
            arrived[index].resolve();
            await release[index].promise;
            const content = index === 0
                ? "````WORK (worker://first_child)\nDo two turns.\n````\n\n````WORK (worker://second_child)\nDo two turns.\n````\n\n````WAIT\n````"
                : index === 1 || index === 2 ? "````NOTE\nContinuing child work.\n````"
                    : `\`\`\`\`KILL\nACCOUNTING_RESULT_${index}\n\`\`\`\``;
            frame({ content });
            frame({}, "stop");
            const factor = 2 ** index;
            response.write(`data: ${JSON.stringify({ choices: [], usage: {
                prompt_tokens: factor * 100, completion_tokens: factor * 10, total_tokens: factor * 110,
                cost: factor / 100, is_byok: false,
            } })}\n\n`);
            response.end("data: [DONE]\n\n");
        })().catch((error: Error) => {
            failures.push(error);
            arrived.forEach((gate) => gate.reject(error));
            response.destroy(error);
        });
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
        release.forEach((gate) => gate.resolve());
        provider.closeAllConnections();
        await new Promise<void>((resolve) => provider.close(() => resolve()));
        assert.deepEqual(failures, [], "provider failures must not be hidden");
    });
    const address = provider.address();
    assert.ok(address !== null && typeof address === "object");
    const daemon = await bootDaemon(service, { extraEnv: {
        PLURNK_MODEL: "treefixture", PLURNK_MODEL_treefixture: "openrouter/tree-fixture",
        PLURNK_BASEURL_treefixture: `http://127.0.0.1:${address.port}/v1`,
        OPENROUTER_API_KEY: "tree-fixture", PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
        PLURNK_PROVIDERS_EFFORT: "off", PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
        PLURNK_PROVIDERS_DROPPED_OUTPUT_TOKENS: "0", PLURNK_SERVICE_OPTIMISTIC_WAIT_MS: "0",
    } });
    t.after(() => daemon.cleanup());
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    t.after(() => { if (!t.passed) t.diagnostic(`Last provider packet:\n${packets.at(-1)?.slice(-6500)}`); });
    const tui = spawnTui(daemon.url, ["--workspace", "tree-status", "--worker", "main", "--project-root", ""], {
        HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "",
    }, daemon.workspace);
    t.after(() => tui.kill());
    await tui.waitFor(/plurnk.*\/help/);
    tui.write("Delegate to two workers and finish together.\r");
    release[0].resolve();
    await Promise.all([arrived[1].promise, arrived[2].promise]);
    await tui.waitFor(/💤[^\r\n]*↓100 ↑10[^\r\n]*\$0\.0100[^\r\n]*🐜 2/);
    release[1].resolve();
    await arrived[3].promise;
    await tui.waitFor(/💤[^\r\n]*↓300 ↑30[^\r\n]*\$0\.0300[^\r\n]*🐜 2/);
    release[2].resolve();
    await arrived[4].promise;
    await tui.waitFor(/💤[^\r\n]*↓700 ↑70[^\r\n]*\$0\.0700[^\r\n]*🐜 2/);
    const inspect = tui.output().length;
    tui.write("/model\r");
    await tui.waitFor(/model: treefixture/, 10_000, inspect);
    await tui.waitFor(/💤[^\r\n]*↓700 ↑70[^\r\n]*\$0\.0700/, 10_000, inspect);
    release[3].resolve();
    await arrived[5].promise;
    await tui.waitFor(/⌛︎[^\r\n]*↓2k ↑150[^\r\n]*\$0\.1500/);
    release[4].resolve();
    await tui.waitFor(/⌛︎[^\r\n]*↓3k ↑310[^\r\n]*\$0\.3100/);
    release[5].resolve();
    await tui.waitFor(/ACCOUNTING_RESULT_5/);
    // The second child settled after the parent's packet was assembled. The normal
    // completion guard requires that result to be observed in a subsequent turn.
    await arrived[6].promise;
    assert.match(packets[6], /Results await review before completion/);
    await tui.waitFor(/⌛︎[^\r\n]*↓6k ↑630[^\r\n]*\$0\.6300/);
    release[6].resolve();
    await tui.waitFor(/⏹️[^\r\n]*↓13k ↑1k[^\r\n]*\$1\.2700/);
    assert.match(tui.output(), /loop \$0\.9700/, "the own-loop summary remains parent-only");
    assert.match(tui.output(), /🐜 first_child/);
    assert.match(tui.output(), /🐜 second_child/);
    const next = tui.output().length;
    tui.write("A separate task without children.\r");
    await arrived[7].promise;
    await tui.waitFor(/⌛︎[^\r\n]*↓13k ↑1k[^\r\n]*\$1\.2700/, 10_000, next);
    release[7].resolve();
    await tui.waitFor(/⏹️[^\r\n]*↓26k ↑3k[^\r\n]*\$2\.5500/);
    assert.equal(calls, 8);
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);
});
