import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { bootDaemon, completionsEndpoint, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

// plurnk-service {§acp-history-window} {§acp-status-descendants}: the window holds the delegation's messages, and the
// gauge names each descendant and its generation.
test("[§cli-worker-history] a session attached after a delegation draws the child's rows marked and stepped in, in history and in /loop", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service, "the composed client test requires the sibling service");
    let calls = 0;
    // The parent delegates and waits; the child answers; the woken parent concludes.
    const provider = await completionsEndpoint(() => [
        "````WORK (worker://scout)\nLook for the CHILD_FINDING.\n````\n\n````WAIT\n````",
        "````SEND [200]\nCHILD_FINDING\n````",
        "````SEND [200]\nPARENT_DONE\n````",
    ][calls++] ?? "````SEND [200]\nUNEXPECTED_TURN\n````");
    t.after(() => provider.close());
    const daemon = await bootDaemon(service, { readyTimeoutMs: 30_000, extraEnv: {
        PLURNK_MODEL: "delegationfixture",
        PLURNK_MODEL_delegationfixture: "openai/delegation-fixture",
        OPENAI_BASE_URL: provider.url,
        OPENAI_API_KEY: "delegation-fixture",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
        PLURNK_PROVIDERS_EFFORT: "off",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(() => daemon.cleanup());
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    const args = ["--workspace", "delegation", "--worker", "main", "--project-root", ""];
    const env = { HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "" };

    const first = spawnTui(daemon.url, args, env, daemon.workspace);
    t.after(() => first.kill());
    await first.waitFor(/plurnk[\s\S]*\/help/);
    first.write("Delegate the search to a scout.\r");
    await first.waitFor(/PARENT_DONE/, 30_000);
    first.write("/quit\r");
    assert.equal(await first.exited, 0);
    assert.equal(calls, 3, "one parent turn, one child turn, one resumed parent turn");

    const attached = spawnTui(daemon.url, args, env, daemon.workspace);
    t.after(() => attached.kill());
    await attached.waitFor(/PARENT_DONE/, 15_000);
    const history = stripVTControlCharacters(attached.output());
    assert.match(history, /^ {2}🐜 scout [^\n]*\(worker:\/\/main\)\s*\n {2}Look for the CHILD_FINDING\./mu, "the child's arrival, one step in under its name");
    assert.match(history, /^ {2}🐜 scout [^\n]*\n {2}CHILD_FINDING\b/mu, "and its reply, with its words");
    assert.ok(history.indexOf("🐜 scout") < history.indexOf("PARENT_DONE"), "in log order among the parent's rows");

    const listed = attached.output().length;
    attached.write("/loop 1\r");
    await attached.waitFor(/── loop 1 ──[\s\S]*PARENT_DONE/u, 10_000, listed);
    const loop = stripVTControlCharacters(attached.output().slice(listed));
    assert.match(loop, /^ {2}🐜 scout /mu, "the loop holds its delegation, marked as history marks it");
    assert.equal(calls, 3, "attaching and reading the loop start no work");
    attached.write("/quit\r");
    assert.equal(await attached.exited, 0);
});
