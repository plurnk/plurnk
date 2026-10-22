import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { locateDaemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

// A loopback port nothing listens on yet, for the one service these sessions start.
const freePort = async (): Promise<number> => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return address.port;
};

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Everything the service writes lands under `root`; its pid is read from the lock on its one database.
const session = async (resources: AsyncDisposableStack, prefix: string) => {
    const service = await locateDaemon();
    assert.ok(service, "the composed test needs an installed service or sibling checkout");
    const root = await mkdtemp(join(tmpdir(), prefix));
    resources.defer(() => rm(root, { recursive: true, force: true }));
    const project = join(root, "project");
    await mkdir(project);
    const port = await freePort();
    const env = {
        ...Object.fromEntries(Object.keys(process.env).filter((key) => /^PLURNK_|_(API_KEY|BASE_URL)$/u.test(key)).map((key) => [key, undefined])),
        HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_STATE_HOME: join(root, "state"),
        PLURNK_HOST: "127.0.0.1", PLURNK_PORT: String(port), PLURNK_AGUI_URL: "",
        PLURNK_CLIENT_SERVICE_BIN: service, PLURNK_MODEL: "", PLURNK_CLIENT_DAEMON_TIMEOUT_MS: "15000",
    };
    const database = join(root, "data", "plurnk", "plurnk.db");
    const servicePid = async (): Promise<number> => (JSON.parse(await readFile(`${database}.lock`, "utf8")) as { pid: number }).pid;
    resources.defer(async () => {
        const pid = await servicePid().catch(() => null);
        if (pid === null || !alive(pid)) return;
        process.kill(pid, "SIGTERM");
        for (let waited = 0; alive(pid) && waited < 30_000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    });
    return { root, project, port, env, servicePid };
};

for (const [ending, code] of [["quit", 0], ["cancel folder", 130], ["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    test(`[§cli-daemon-autostart] the service a TUI started keeps running after the TUI's ${ending}`, { timeout: 60_000 }, async () => {
        await using resources = new AsyncDisposableStack();
        const { root, project, port, env, servicePid } = await session(resources, "plurnk-tui-autostart-");
        const tui = spawnTui(`http://127.0.0.1:${port}`, ["--workspace", "shared-workspace", "--worker", "primary"], env, ending === "cancel folder" ? root : project);
        resources.defer(async () => { tui.kill(); await tui.exited; });
        if (ending === "cancel folder") await tui.waitFor(/Choose a project folder/, 25_000);
        else {
            await tui.waitFor(/plurnk.*\/help/s, 25_000);
            // The notice wraps at the terminal's width: wait for it whole, the listing command it names included.
            await tui.waitFor(/No model selected\.[\s\S]*?\/models\b/u);
        }
        const pid = await servicePid();
        assert.match(tui.output(), new RegExp(`Started plurnk-service \\(pid ${pid}\\) at http://127\\.0\\.0\\.1:${port}/agui`, "u"));
        if (ending === "quit") tui.write("/quit\r");
        else if (ending === "cancel folder") tui.write("\x1b");
        else tui.kill(ending);
        assert.equal(await tui.exited, code, tui.output());
        assert.ok(alive(pid), "the client never stops the service");
        if (ending === "quit") assert.match(tui.output(), /resume this workspace:\s+plurnk --workspace shared-workspace --worker primary/u);
    });
}

test("{§cli-daemon-autostart} a later TUI attaches to the service the first one started and returns to its worker", { timeout: 90_000 }, async () => {
    await using resources = new AsyncDisposableStack();
    const { project, port, env, servicePid } = await session(resources, "plurnk-tui-shared-");
    const first = spawnTui(`http://127.0.0.1:${port}`, [], env, project);
    resources.defer(async () => { first.kill(); await first.exited; });
    await first.waitFor(/No model selected\./, 25_000);
    assert.match(first.output(), /plurnk-service stop/u, "the start says how to stop what it started");
    assert.match(first.output(), /service\.log/u, "and where its log is");
    const pid = await servicePid();
    first.write("/quit\r");
    assert.equal(await first.exited, 0, first.output());
    assert.match(first.output(), /--worker user/u, "with no worker selected, the TUI binds PLURNK_CLIENT_TUI_WORKER");

    const second = spawnTui(`http://127.0.0.1:${port}`, [], env, project);
    resources.defer(async () => { second.kill(); await second.exited; });
    await second.waitFor(/No model selected\./, 25_000);
    assert.doesNotMatch(second.output(), /Started plurnk-service/u, "a running service is attached, not started again");
    assert.equal(await servicePid(), pid);
    second.write("/quit\r");
    assert.equal(await second.exited, 0, second.output());
    assert.match(second.output(), /--worker user/u);
});
