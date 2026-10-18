import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { bootDaemon, completionsEndpoint, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

test("[§cli-operation-glyphs] built TUI renders operations, note categories, tools and completed replies", { timeout: 60_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service);
    const program = [
        "```NOTE <!-- fact -->\nKnown fact.\n```",
        "```NOTE <!-- idea -->\nWorking idea.\n```",
        "```NOTE <!-- plan -->\nNext plan.\n```",
        "```NOTE <!-- bearings -->\nOther memory.\n```",
        "```EDIT (glyph-example.txt)\nexample\n```",
        "```READ (glyph-example.txt)\n```",
        "```FIND (glyph-example.txt)\n```",
        "```schedule (list)\n```",
        "```sh\nprintf glyph-tool-output\n```",
    ].join("\n\n");
    let calls = 0;
    const endpoint = await completionsEndpoint(() => ++calls === 1 ? program : "```SEND [200]\nglyph-finished\n```");
    t.after(endpoint.close);
    const daemon = await bootDaemon(service, { extraEnv: {
        PLURNK_MODEL: "glyphfixture", PLURNK_MODEL_glyphfixture: "openai/glyph-fixture",
        PLURNK_BASEURL_glyphfixture: endpoint.url, OPENAI_BASE_URL: endpoint.url, OPENAI_API_KEY: "fixture",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768", PLURNK_PROVIDERS_EFFORT: "off", PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(daemon.cleanup);
    const tui = spawnTui(daemon.url, ["--workspace", "glyphs", "--worker", "main", "--no-git", "--yolo", "--max-turns", "4"], {
        HOME: daemon.home, XDG_CONFIG_HOME: join(daemon.home, ".config"), PLURNK_MODEL: "",
    }, daemon.workspace);
    t.after(() => tui.kill());
    t.after(() => { if (!t.passed) t.diagnostic(`${daemon.output()}\n${stripVTControlCharacters(tui.output())}`); });
    await tui.waitFor(/plurnk.*\/help/s);
    tui.write("Show the presentation.\r");
    await tui.waitFor(/done · \d+ turns ·/, 30_000);
    const output = stripVTControlCharacters(tui.output());
    for (const pattern of [/📊 *\r*\nKnown fact\./u, /💡 *\r*\nWorking idea\./u, /🚧 *\r*\nNext plan\./u,
        /🗒️ bearings *\r*\nOther memory\./u, /📝 \(glyph-example\.txt\)/u,
        /📖 \(glyph-example\.txt\) \{1\}/u, /🔎 \(glyph-example\.txt\)/u,
        /⚙️ schedule \(list\)/u, /⚙️ sh/u, /glyph-tool-output/u]) assert.match(output, pattern);
    await tui.waitForScreen(/🐹 *\nglyph-finished/u);
    assert.doesNotMatch(output, /exceeds terminal width|runtime:error|📝.* — |📖.* — /u);
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0);
});
