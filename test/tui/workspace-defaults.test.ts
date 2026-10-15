import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { actionViaAgui } from "../../src/agui.ts";
import { bootDaemon, locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

test("[§cli-workspaces-and-workers] built TUIs share directory workspaces and independently select roots and workers", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service, "the composed test requires the sibling service");
    const daemon = await bootDaemon(service);
    t.after(() => daemon.cleanup());
    const folder = join(daemon.home, "projects", "example");
    const elsewhere = join(daemon.home, "other");
    await Promise.all([mkdir(folder, { recursive: true }), mkdir(elsewhere)]);
    const workspace = "~/projects/example";
    const target = { aguiUrl: daemon.url };
    const env = {
        ...Object.fromEntries(Object.keys(process.env).filter((key) => key.startsWith("PLURNK_")).map((key) => [key, undefined])),
        HOME: daemon.home, XDG_CONFIG_HOME: join(daemon.home, ".config"), PLURNK_CLIENT_AUTOSTART: "0", PLURNK_AGUI_URL: daemon.url,
    };
    const rows = async () => (await actionViaAgui<{ workspaces: { name: string; project_root: string | null }[] }>(
        target, { threadId: "inspect", kind: "workspace.list" },
    )).workspaces;
    const workers = async (name: string, worker = "user") => (await actionViaAgui<{ workers: { id: number; name: string }[] }>(
        target, { threadId: worker, workspace: name, kind: "workspace.workers" },
    )).workers;

    await t.test("simultaneous launches reuse both the workspace and user worker", async () => {
        const first = spawnTui(daemon.url, [], env, folder);
        const second = spawnTui(daemon.url, [], env, folder);
        try {
            for (const tui of [first, second]) {
                await tui.waitFor(/workspace: ~\/projects\/example · worker: user/);
                // The owner's session creates its worker as it attaches: the place reports its first loop count.
                await tui.waitFor(/\[~\/projects\/example\/~user\(0\)/);
                const status = stripVTControlCharacters(tui.output()).split(/[\r\n]/).filter((line) => line.includes("[~/projects/example/~user"));
                assert.ok(status.length > 0);
                assert.ok(status.every((line) => line.startsWith("[~/projects/example/")), "no duplicate folder before the place");
            }
            assert.deepEqual((await rows()).map(({ name, project_root }) => ({ name, project_root })),
                [{ name: workspace, project_root: folder }]);
            assert.equal((await workers(workspace)).filter(({ name }) => name === "user").length, 1);
            for (const tui of [first, second]) tui.write("/quit\r");
            assert.deepEqual(await Promise.all([first.exited, second.exited]), [0, 0]);
        } finally { first.kill(); second.kill(); }
    });

    for (const [name, args, extra, expectedWorkspace, worker, root] of [
        ["worker flag needs no workspace flag", ["--worker", "reviewer"], {}, workspace, "reviewer", folder],
        ["worker environment overrides TUI default", [], { PLURNK_CLIENT_WORKER: "envworker", PLURNK_CLIENT_TUI_WORKER: "fallback" }, workspace, "envworker", folder],
        ["TUI default follows the environment cascade", [], { PLURNK_CLIENT_TUI_WORKER: "fallback" }, workspace, "fallback", folder],
        ["TUI default flag overrides its environment setting", ["--tui-worker", "localdefault"], { PLURNK_CLIENT_TUI_WORKER: "fallback" }, workspace, "localdefault", folder],
        ["workspace environment and explicit headless root", ["--project-root="], { PLURNK_CLIENT_WORKSPACE: "folderless" }, "folderless", "user", null],
        ["flags override both identity environment settings", ["--workspace", "chosen", "--worker", "flagworker", "--project-root", elsewhere], { PLURNK_CLIENT_WORKSPACE: "ignored", PLURNK_CLIENT_WORKER: "ignored" }, "chosen", "flagworker", elsewhere],
    ] as const) {
        await t.test(name, async () => {
            const tui = spawnTui(daemon.url, [...args], { ...env, ...extra }, folder);
            try {
                await tui.waitFor(new RegExp(`workspace: ${RegExp.escape(expectedWorkspace)} · worker: ${worker}`));
                await tui.waitFor(new RegExp(`\\[${RegExp.escape(expectedWorkspace)}/~${worker}\\(0\\)`));
                assert.equal((await rows()).find(({ name }) => name === expectedWorkspace)?.project_root, root);
                assert.ok((await workers(expectedWorkspace, worker)).some(({ name }) => name === worker));
                if (root === elsewhere) await tui.waitFor(/~\/other \[chosen\//);
                tui.write("/quit\r");
                assert.equal(await tui.exited, 0, tui.output());
            } finally { tui.kill(); }
        });
    }

    // {§workspace-name} — the folder names the world: a redirected root names its own folder, not
    // the launch directory, and a world without a folder has nothing to be named after.
    await t.test("a redirected creation root names the world after that folder", async () => {
        const cwd = join(folder, "redirected");
        await mkdir(cwd);
        const tui = spawnTui(daemon.url, ["--project-root", elsewhere], env, cwd);
        try {
            await tui.waitFor(/\[~\/other\/~user/);
            const named = await rows();
            assert.equal(named.find((row) => row.name === "~/other")?.project_root, elsewhere);
            assert.ok(!named.some((row) => row.name === `${workspace}/redirected`), "the launch directory names nothing");
            tui.write("/quit\r");
            assert.equal(await tui.exited, 0, tui.output());
        } finally { tui.kill(); }
    });

    await t.test("a headless creation root without a name is refused before any binding", async () => {
        const cwd = join(folder, "folderless");
        await mkdir(cwd);
        const before = (await rows()).length;
        const tui = spawnTui(daemon.url, ["--project-root", ""], env, cwd);
        try {
            assert.equal(await tui.exited, 64, tui.output());
            assert.match(stripVTControlCharacters(tui.output()), /--project-root= requires --workspace \(or PLURNK_CLIENT_WORKSPACE\)/);
            assert.equal((await rows()).length, before, "no world was created");
        } finally { tui.kill(); }
    });
});
