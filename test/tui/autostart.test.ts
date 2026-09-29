import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

for (const [ending, code] of [["quit", 0], ["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    test(`[§cli-daemon-autostart] private TUI backend is stopped on ${ending} while its state survives`, { timeout: 45_000 }, async () => {
        const service = await locateDaemon();
        assert.ok(service, "the composed test needs an installed service or sibling checkout");
        await using resources = new AsyncDisposableStack();
        const root = await mkdtemp(join(tmpdir(), "plurnk-tui-autostart-"));
        resources.defer(() => rm(root, { recursive: true, force: true }));
        const project = join(root, "project");
        await mkdir(project);
        const stateRoot = join(root, "backend");
        const database = join(stateRoot, "data", "plurnk", "plurnk.db");
        const env = {
            ...Object.fromEntries(Object.keys(process.env).filter((key) => /^PLURNK_|_(API_KEY|BASE_URL)$/u.test(key)).map((key) => [key, undefined])),
            HOME: root, XDG_CONFIG_HOME: join(root, "config"), PLURNK_SERVICE_STATE_ROOT: stateRoot,
            PLURNK_HOST: "127.0.0.1", PLURNK_PORT: "0", PLURNK_AGUI_URL: "",
            PLURNK_CLIENT_SERVICE_BIN: service, PLURNK_MODEL: "", PLURNK_MCP_ENABLED: "[]",
            PLURNK_CLIENT_DAEMON_TIMEOUT_MS: "15000", PLURNK_CLIENT_DAEMON_STOP_TIMEOUT_MS: "2000",
        };
        const tui = spawnTui("http://127.0.0.1:0", ["--workspace", "private-world", "--worker", "primary"], env, project);
        resources.defer(async () => { tui.kill(); await tui.exited; });
        await tui.waitFor(/plurnk.*\/help/, 25_000);
        await tui.waitFor(/No model selected\./);
        assert.match(tui.output(), /Use \/models/);
        assert.doesNotMatch(tui.output(), /Use the resume command printed on exit/, "explicit storage needs no first-use hint");
        const lock = JSON.parse(await readFile(`${database}.lock`, "utf8")) as { pid: number };
        assert.doesNotThrow(() => process.kill(lock.pid, 0), "the private backend is running during the session");
        if (ending === "quit") tui.write("/quit\r");
        else tui.kill(ending);
        assert.equal(await tui.exited, code, tui.output());
        assert.throws(() => process.kill(lock.pid, 0), { code: "ESRCH" }, "the daemon has exited, not merely disconnected");
        await assert.rejects(readFile(`${database}.lock`), { code: "ENOENT" });
        assert.ok((await readFile(database)).length > 0, "the private database was not deleted");
        if (ending === "quit") {
            assert.match(tui.output(), /resume this workspace:/);
            assert.match(tui.output(), /PLURNK_SERVICE_DB_PATH=/);
            assert.match(tui.output(), /PLURNK_PORT=0/);
            assert.doesNotMatch(tui.output(), /PLURNK_AGUI_TOKEN=/, "the temporary bearer is not a resume setting");
        }
    });
}

test("{§cli-daemon-autostart} automatically allocated TUI storage explains how to resume", { timeout: 45_000 }, async () => {
    const service = await locateDaemon();
    assert.ok(service);
    await using resources = new AsyncDisposableStack();
    const root = await mkdtemp(join(tmpdir(), "plurnk-tui-new-session-"));
    resources.defer(() => rm(root, { recursive: true, force: true }));
    const tui = spawnTui("http://127.0.0.1:0", [], {
        ...Object.fromEntries(Object.keys(process.env).filter((key) => /^PLURNK_|_(API_KEY|BASE_URL)$/u.test(key)).map((key) => [key, undefined])),
        HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
        PLURNK_HOST: "127.0.0.1", PLURNK_PORT: "0", PLURNK_AGUI_URL: "",
        PLURNK_CLIENT_SERVICE_BIN: service, PLURNK_MODEL: "", PLURNK_MCP_ENABLED: "[]",
    }, root);
    resources.defer(async () => { tui.kill(); await tui.exited; });
    await tui.waitFor(/No model selected\./, 25_000);
    assert.match(tui.output(), /Use the resume command printed on exit/);
    assert.match(tui.output(), /plurnk#service/);
    tui.write("/quit\r");
    assert.equal(await tui.exited, 0, tui.output());
    assert.match(tui.output(), /PLURNK_SERVICE_DB_PATH=/);
});
