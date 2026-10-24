import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { bootDaemon, completionsEndpoint, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

// plurnk-service {§acp-worker-loops}: the loops a worker's conversation is made of, listed and read whole.
test("[§cli-loops] /loops lists the worker's loops by their opening lines, and /loop prints one whole, the current one without a number", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service, "the composed client test requires the sibling service");
    let requests = 0;
    const provider = await completionsEndpoint(() => {
        requests += 1;
        return `\`\`\`\`SEND [200]\nANSWER_${requests}\n\`\`\`\``;
    });
    t.after(() => provider.close());
    const daemon = await bootDaemon(service, { readyTimeoutMs: 30_000, extraEnv: {
        PLURNK_MODEL: "loopsfixture",
        PLURNK_MODEL_loopsfixture: "openai/loops-fixture",
        OPENAI_BASE_URL: provider.url,
        OPENAI_API_KEY: "loops-fixture",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768",
        PLURNK_PROVIDERS_EFFORT: "off",
        PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(() => daemon.cleanup());
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    const tui = spawnTui(daemon.url, ["--workspace", "loops", "--worker", "main", "--project-root", ""], {
        HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "",
    }, daemon.workspace);
    t.after(() => tui.kill());
    await tui.waitFor(/plurnk[\s\S]*\/help/);
    tui.write("Let's build an app! Make no mistakes.\r");
    await tui.waitFor(/ANSWER_1/);
    tui.write("No, you did it wrong!\r");
    await tui.waitFor(/ANSWER_2/);
    // plurnk-service {§acp-status-loop-number}: the place names the loop by the number /loops lists.
    await tui.waitForScreen(/\[loops\/~main\(2\/1\)\]/u);

    const plain = (since: number): string => stripVTControlCharacters(tui.output().slice(since));
    const listed = tui.output().length;
    tui.write("/loops\r");
    await tui.waitFor(/2: No, you did it wrong!/u, 10_000, listed);
    assert.match(plain(listed), /1: Let's build an app! Make no mistakes\.\s[\s\S]*2: No, you did it wrong!/u, "oldest first, by their opening lines");

    const first = tui.output().length;
    tui.write("/loop 1\r");
    await tui.waitFor(/── loop 1 ──[\s\S]*ANSWER_1/u, 10_000, first);
    const loop = plain(first).slice(plain(first).indexOf("── loop 1 ──"));
    assert.match(loop, /Let's build an app! Make no mistakes\.[\s\S]*ANSWER_1/u, "the loop whole: its prompt, then its reply");
    assert.doesNotMatch(loop, /ANSWER_2/u, "and nothing of another loop");

    const current = tui.output().length;
    tui.write("/loop\r");
    await tui.waitFor(/── loop 2 ──[\s\S]*ANSWER_2/u, 10_000, current);
    assert.equal(requests, 2, "reading loops starts no work");
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);
});
