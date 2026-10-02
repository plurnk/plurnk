import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { actionViaBridge } from "../../src/agui.ts";
import { bootDaemon, locateDaemon } from "../intg/harness.ts";
import { BIN, spawnTui } from "./harness.ts";

test("[§cli-project-root] home launch requires a choice before workspace creation", { timeout: 90_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service, "the composed test requires the sibling service");
    const daemon = await bootDaemon(service);
    t.after(() => daemon.cleanup());
    const env = {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PLURNK_"))),
        HOME: daemon.home, XDG_CONFIG_HOME: join(daemon.home, ".config"), NO_COLOR: "1",
        PLURNK_AGUI_URL: daemon.url, PLURNK_CLIENT_AUTOSTART: "0", PLURNK_MODEL: "",
        PLURNK_CLIENT_WORKSPACE: undefined, PLURNK_CLIENT_WORKER: undefined,
        PLURNK_CLIENT_PROJECT_ROOT: undefined,
    };
    const rows = async () => (await actionViaBridge<{ workspaces: { name: string; project_root: string | null }[] }>(
        { bridgeUrl: daemon.url }, { threadId: "bootstrap", kind: "workspace.list" },
    )).workspaces;
    const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [BIN, ...args], { cwd: daemon.home, env, timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end();
    });

    await t.test("pipes require an explicit root without creating a workspace", async () => {
        for (const args of [["hello"], ["--workspace", "new-from-pipe", "hello"], ["--json", "hello"]]) {
            const result = await run(args);
            assert.equal(result.code, 64, result.stderr);
            if (args.includes("--json")) {
                assert.equal(JSON.parse(result.stdout).problem.type, "https://problems.plurnk.xyz/client/project-root/required");
            } else assert.match(result.stderr, /Choose a project folder.*--project-root/s);
            assert.deepEqual(await rows(), [], "no workspace may be created before root selection");
        }
        const result = await run(["workspace", "list", "--json"]);
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), []);
    });

    await t.test("cancel leaves no workspace", async () => {
        const tui = spawnTui(daemon.url, [], env, daemon.home);
        try {
            await tui.waitFor(/Choose a project folder/);
            assert.deepEqual(await rows(), []);
            tui.write("\x1b");
            assert.equal(await tui.exited, 130, tui.output());
            assert.deepEqual(await rows(), []);
        } finally { tui.kill(); }
    });

    const project = join(daemon.home, "my project");
    await mkdir(project);
    await writeFile(join(project, "chosen-file.txt"), "chosen project");
    await writeFile(join(daemon.home, "not-a-folder"), "file");
    await t.test("folder validation and completion precede creation; later new workspaces reuse the choice", async () => {
        const tui = spawnTui(daemon.url, ["--workspace", "chosen"], env, daemon.home);
        try {
            await tui.waitFor(/Choose a project folder/);
            tui.write("\r");
            await tui.waitFor(/Project folder.*Tab/);
            tui.write("not-a-folder\r");
            await tui.waitFor(/not a directory/);
            assert.deepEqual(await rows(), []);
            tui.write("\x01\x0bmy pro\t");
            await tui.waitFor(/my project\//);
            tui.write("\r");
            await tui.waitFor(/workspace: chosen/);
            assert.equal((await rows()).find(({ name }) => name === "chosen")?.project_root, project);
            await tui.waitFor(/~\/my project \[chosen\//);
            const completingAt = tui.output().length;
            tui.write("@chosen-f\t");
            await tui.waitFor(/@chosen-file\.txt/, 10_000, completingAt);
            tui.write("\x01\x0b/workspace another\r");
            await tui.waitFor(/workspace: another/);
            assert.equal((await rows()).find(({ name }) => name === "another")?.project_root, project);
            tui.write("/quit\r");
            assert.equal(await tui.exited, 0, tui.output());
        } finally { tui.kill(); }
    });

    await t.test("resuming skips the picker; creating after resume does not silently inherit that root", async () => {
        const tui = spawnTui(daemon.url, ["--workspace", "chosen"], env, daemon.home);
        try {
            await tui.waitFor(/workspace: chosen/);
            assert.doesNotMatch(tui.output(), /Choose a project folder/);
            tui.write("/workspace cancelled-switch\r");
            await tui.waitFor(/Choose a project folder/);
            const cancelledAt = tui.output().length;
            tui.write("\x1b");
            await tui.waitFor(/─{8,}/, 10_000, cancelledAt);
            assert.ok(!(await rows()).some(({ name }) => name === "cancelled-switch"));
            const choosingAt = tui.output().length;
            tui.write("/workspace headless-choice\r");
            await tui.waitFor(/Choose a project folder/, 10_000, choosingAt);
            tui.write("\x1b[B\r");
            await tui.waitFor(/workspace: headless-choice/);
            assert.equal((await rows()).find(({ name }) => name === "headless-choice")?.project_root, null);
            tui.write("/quit\r");
            assert.equal(await tui.exited, 0, tui.output());
        } finally { tui.kill(); }
    });

    await t.test("home can be chosen explicitly", async () => {
        const tui = spawnTui(daemon.url, ["--workspace", "home-choice"], env, daemon.home);
        try {
            await tui.waitFor(/Choose a project folder/);
            tui.write("\x1b[B\x1b[B\r");
            await tui.waitFor(/workspace: home-choice/);
            assert.equal((await rows()).find(({ name }) => name === "home-choice")?.project_root, daemon.home);
            tui.write("/quit\r");
            assert.equal(await tui.exited, 0, tui.output());
        } finally { tui.kill(); }
    });

    for (const [name, args, extra, cwd, expected] of [
        ["explicit-home", [`--project-root=${daemon.home}`], {}, daemon.home, daemon.home],
        ["explicit-headless", ["--project-root="], {}, daemon.home, null],
        ["env-headless", [], { PLURNK_CLIENT_PROJECT_ROOT: "" }, daemon.home, null],
        ["env-project", [], { PLURNK_CLIENT_PROJECT_ROOT: project }, daemon.home, project],
        ["ordinary-cwd", [], {}, project, project],
    ] as const) {
        await t.test(name, async () => {
            const tui = spawnTui(daemon.url, ["--workspace", name, ...args], { ...env, ...extra }, cwd);
            try {
                await tui.waitFor(new RegExp(`workspace: ${name}`));
                assert.doesNotMatch(tui.output(), /Choose a project folder/);
                assert.equal((await rows()).find((row) => row.name === name)?.project_root, expected);
                tui.write("/quit\r");
                assert.equal(await tui.exited, 0, tui.output());
            } finally { tui.kill(); }
        });
    }
});
