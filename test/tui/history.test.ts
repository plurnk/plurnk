import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { bootDaemon, completionsEndpoint, locateDaemon } from "../intg/harness.ts";
import { openTransport } from "../transport.ts";
import { runViaAcp, runEnd } from "../../src/acp.ts";
import { spawnTui } from "./harness.ts";

const historyDaemon = async (t: TestContext, url: string, extraEnv: Record<string, string> = {}) => {
    const service = await locateDaemon();
    assert.ok(service, "the composed client test requires the sibling service");
    const daemon = await bootDaemon(service, { extraEnv: {
        PLURNK_MODEL: "historyfixture",
        PLURNK_MODEL_historyfixture: "openai/history-fixture",
        OPENAI_BASE_URL: url,
        OPENAI_API_KEY: "history-fixture",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
        PLURNK_PROVIDERS_EFFORT: "off",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
        ...extraEnv,
    } });
    t.after(() => daemon.cleanup());
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    return daemon;
};

test("{§cli-worker-history}: startup and attach restore the bound worker's history without inference", { timeout: 90_000 }, async (t) => {
    let requests = 0;
    const provider = await completionsEndpoint(() => {
        requests += 1;
        return `\`\`\`\`SEND [200]\nRESTORED_ANSWER_${requests}\n\`\`\`\``;
    });
    t.after(() => provider.close());
    const daemon = await historyDaemon(t, provider.url);
    for (const name of ["alpha", "beta"]) {
        // Seed the old name-addressed form, then reopen it through the terminal's qualified thread.
        let status: number | undefined;
        for await (const event of runViaAcp({ acpUrl: daemon.url }, { threadId: name, workspace: "history",
            prompt: `Remember the ${name} question.`, forwardedProps: { projectRoot: null } })) {
            const terminal = runEnd(event)?.terminal as { result: { status: number } } | undefined;
            if (terminal !== undefined) status = terminal.result.status;
        }
        assert.equal(status, 200);
    }

    const tui = spawnTui(daemon.url, ["--workspace", "history", "--worker", "alpha"], {
        HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "",
    }, daemon.workspace);
    t.after(() => tui.kill());
    await tui.waitFor(/RESTORED_ANSWER_1/);
    assert.match(tui.output(), /Remember the alpha question\./);
    assert.doesNotMatch(tui.output(), /RESTORED_ANSWER_2|Remember the beta question/);
    assert.equal(requests, 2, "restoring history does not infer or resubmit a prompt");
    assert.doesNotMatch(tui.output(), /completed · \d+ turns? ·/, "history is not a fresh loop summary");
    const before = tui.output().length;
    tui.write("/worker beta\r");
    await tui.waitFor(/RESTORED_ANSWER_2/, 10_000, before);
    await tui.waitFor(/worker: beta \(bound\)/, 10_000, before);
    assert.match(tui.output().slice(before), /Remember the beta question\./);
    assert.equal(requests, 2, "worker navigation is inference-free");
    tui.write("/fork leaf\r");
    await tui.waitFor(/worker: leaf \(new\)/);
    const beforeHop = tui.output().length;
    tui.write("/parent\r");
    await tui.waitFor(/RESTORED_ANSWER_2/, 10_000, beforeHop);
    assert.equal(requests, 2, "a topology hop uses the same inference-free attachment path");
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);

    const quiet = spawnTui(daemon.url, ["--workspace", "history", "--worker", "alpha"], {
        HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "", PLURNK_CLIENT_HISTORY_ENTRIES: "0",
    }, daemon.workspace);
    t.after(() => quiet.kill());
    await quiet.waitFor(/plurnk.*\/help/s);
    quiet.write("/model\r");
    await quiet.waitFor(/model: historyfixture/);
    assert.doesNotMatch(quiet.output(), /RESTORED_ANSWER|Remember the alpha question/);
    quiet.write("/quit\r");
    assert.equal(await quiet.exited, 0);
    assert.equal(requests, 2, "disabling backfill does not start work");
});

test("{§cli-worker-history}: quitting an attached live observer leaves the originating loop alive", { timeout: 90_000 }, async (t) => {
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let requests = 0;
    const provider = createServer(async (request, response) => {
        if (request.method !== "POST") { response.writeHead(200).end("{}"); return; }
        for await (const _chunk of request) { /* receive the request before holding inference */ }
        requests += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        const frame = (delta: object, finish_reason: string | null = null) => response.write(`data: ${JSON.stringify({
            id: "history-held", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`);
        frame({ role: "assistant", reasoning_content: "Reasoning before the observer attached." });
        waiting.resolve();
        await release.promise;
        frame({ content: "````SEND [200]\nINDEPENDENT_WORK_FINISHED\n````" });
        frame({}, "stop");
        response.end("data: [DONE]\n\n");
    });
    await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
    t.after(() => { release.resolve(); provider.closeAllConnections(); return new Promise<void>((resolve) => provider.close(() => resolve())); });
    const address = provider.address();
    assert.ok(address !== null && typeof address !== "string");
    const daemon = await historyDaemon(t, `http://127.0.0.1:${address.port}/v1`);
    const owner = await openTransport({ acpUrl: daemon.url }, "main", { workspace: "observed", projectRoot: null });
    t.after(() => owner.shutdown());
    const run = owner.run("Finish the independent work.", {});
    await waiting.promise;
    const tui = spawnTui(daemon.url, ["--workspace", "observed", "--worker", "main"], {
        HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "",
    }, daemon.workspace);
    t.after(() => tui.kill());
    await tui.waitFor(/Finish the independent work/);
    assert.doesNotMatch(tui.output(), /Reasoning before the observer/);
    tui.write("/workers\r");
    await tui.waitFor(/● main/);
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);
    release.resolve();
    assert.equal((await run.done).finalStatus, 200, "leaving the observer did not cancel the original run");
    assert.equal(requests, 1, "attaching and detaching requested no inference");
});

test("{§cli-worker-history}: reattachment presents a durable unanswered question and resumes it once", { timeout: 90_000 }, async (t) => {
    let requests = 0;
    const provider = await completionsEndpoint(() => {
        requests += 1;
        return requests === 1
            ? '````question (question)\n{"message":"Choose the retained value.","requestedSchema":{"type":"object","properties":{"value":{"type":"string"}},"required":["value"]}}\n````\n````WAIT\nWaiting for the retained value.\n````'
            : "````SEND [200]\nRESTORED_QUESTION_FINISHED\n````";
    });
    t.after(() => provider.close());
    const daemon = await historyDaemon(t, provider.url, { PLURNK_SERVICE_OPTIMISTIC_WAIT_MS: "0" });
    const owner = await openTransport({ acpUrl: daemon.url }, "main", { workspace: "question-history", projectRoot: null });
    t.after(() => owner.shutdown());
    const question = Promise.withResolvers<void>();
    owner.subscribe({
        onEntry: () => {}, onReasoning: () => {}, onProposal: () => {}, onStream: () => {}, onOutside: () => {},
        onNotice: () => {}, onTerminated: () => {}, onInteraction: () => { question.resolve(); },
    });
    const run = owner.run("Ask for a value.", {});
    await question.promise;
    owner.shutdown();
    assert.equal((await run.done).finalStatus, 499, "the old client released its local interrupt wait");
    const tui = spawnTui(daemon.url, ["--workspace", "question-history", "--worker", "main"], {
        HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "",
    }, daemon.workspace);
    t.after(() => tui.kill());
    await tui.waitFor(/value \(string; required\)/);
    assert.equal(requests, 1, "history and interrupt restoration did not infer");
    tui.write("retained answer\r");
    await tui.waitFor(/RESTORED_QUESTION_FINISHED/);
    assert.equal(requests, 2, "one answer caused one continuation");
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);
});
