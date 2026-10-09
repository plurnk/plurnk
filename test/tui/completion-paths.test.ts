import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { actionViaAgui } from "../../src/agui.ts";
import { bootDaemon, completionsEndpoint, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

test("[§cli-path-completion] the built editor completes and opens files from the current workspace", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service, "the composed test requires the sibling service");
    const packets: string[] = [];
    const endpoint = await completionsEndpoint(({ messages }) => {
        packets.push(JSON.stringify(messages));
        return "````SEND [200]\nReference received.\n````";
    });
    t.after(() => endpoint.close());
    const daemon = await bootDaemon(service, { extraEnv: {
        PLURNK_MODEL: "pathfixture", PLURNK_MODEL_pathfixture: "openai/path-fixture",
        OPENAI_BASE_URL: endpoint.url, OPENAI_API_KEY: "path-fixture", PLURNK_PROVIDERS_EFFORT: "off",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768", PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(() => daemon.cleanup());
    const first = join(daemon.workspace, "first");
    const second = join(daemon.workspace, "second");
    await Promise.all([mkdir(first), mkdir(second)]);
    await Promise.all([
        writeFile(join(daemon.home, "pick-launch.txt"), "LAUNCH_FOLDER_NOT_SELECTED"),
        writeFile(join(first, "pick-first.txt"), "FIRST_WORKSPACE_SELECTED"),
        writeFile(join(second, "pick-second.txt"), "SECOND_WORKSPACE_SELECTED"),
    ]);
    for (const [name, projectRoot] of [["first", first], ["second", second], ["headless", null]] as const) {
        await actionViaAgui({ aguiUrl: daemon.url }, { threadId: name, kind: "workspace.create", params: { name, projectRoot } });
        if (projectRoot !== null) await actionViaAgui({ aguiUrl: daemon.url }, {
            threadId: name, workspace: name, kind: "workspace.members.add", params: { alias: "fixture", definition: { glob: "*.txt" } },
        });
    }
    const tui = spawnTui(daemon.url, ["--workspace", "first", "--project-root", daemon.home, "--max-turns", "2"], {
        HOME: daemon.home, XDG_CONFIG_HOME: join(daemon.home, ".config"), PLURNK_MODEL: "",
    }, daemon.home);
    t.after(() => tui.kill());
    t.after(() => { if (!t.passed) t.diagnostic(tui.output().slice(-4_000)); });
    await tui.waitFor(new RegExp(`${RegExp.escape(first)} \\[first/`));
    for (const [name, contents] of [["first", "FIRST_WORKSPACE_SELECTED"], ["second", "SECOND_WORKSPACE_SELECTED"]]) {
        if (name === "second") {
            const start = tui.output().length;
            tui.write("/workspace second\r");
            await tui.waitFor(new RegExp(`${RegExp.escape(second)} \\[second/`), 10_000, start);
            await tui.waitFor(/workspace: second/, 10_000, start);
        }
        const start = tui.output().length;
        tui.write("Inspect @pick\t");
        await tui.waitFor(new RegExp(`@pick-${name}\\.txt`), 10_000, start);
        tui.write("\r");
        await tui.waitFor(/Reference received\./, 15_000, start);
        // The status snapshot can be terminal before the run observation settles.
        await tui.waitFor(/done · \d+ turns? ·/, 10_000, tui.output().lastIndexOf("Reference received."));
        assert.match(packets.at(-1)!, new RegExp(contents), "the selected file reaches the model as a real READ");
        assert.doesNotMatch(packets.at(-1)!, /LAUNCH_FOLDER_NOT_SELECTED/);
    }
    const switched = tui.output().length;
    tui.write("/workspace headless\r");
    await tui.waitFor(/\[headless\//, 10_000, switched);
    await tui.waitFor(/workspace: headless/, 10_000, switched);
    const imported = tui.output().length;
    tui.write("/import pick\t");
    await tui.waitFor(/\/import pick-launch\.txt/, 10_000, imported);
    tui.write("\r");
    await tui.waitFor(/LAUNCH_FOLDER_NOT_SELECTED/, 10_000, imported);
    tui.write("\x01\x0b/quit\r");
    assert.equal(await tui.exited, 0, tui.output());

    const beforeCli = packets.length;
    const cli = spawnTui(daemon.url, ["--workspace", "first", "--worker", "cli-reader", "--project-root", daemon.home, "--max-turns", "2", `Inspect @${first}/pick-first.txt`], {
        HOME: daemon.home, XDG_CONFIG_HOME: join(daemon.home, ".config"), PLURNK_MODEL: "",
    }, daemon.home);
    t.after(() => cli.kill());
    assert.equal(await cli.exited, 0, cli.output());
    assert.match(cli.output(), /Reference received\./);
    assert.ok(packets.length > beforeCli, "the CLI made its own model request");
    assert.match(packets.at(-1)!, /FIRST_WORKSPACE_SELECTED/, "CLI resumption reads from the stored root too");
});
