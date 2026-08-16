// Built-client dogfood for workspace MCP management. A current SDK server is
// the positive peer; the pre-server/discover peer is expected to fail with the
// daemon's exact non-retryable protocol-revision diagnosis.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootDaemon, locateDaemon, type Daemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

let daemon: Daemon | null = null;
let definitions = "";
let currentDefinition = "";
let legacyDefinition = "";

before(async () => {
    const bin = await locateDaemon();
    if (bin === null) return;
    const serviceRoot = resolve(process.cwd(), "../plurnk-service");
    const currentFixture = join(serviceRoot, "plurnk-mcp/src/fixtures/echo-server.mjs");
    const legacyFixture = join(serviceRoot, "plurnk-mcp/src/fixtures/legacy-server.mjs");
    const deprecatedCommand = process.env.PLURNK_TEST_DEPRECATED_MCP_BIN;
    try {
        await Promise.all([
            access(currentFixture),
            access(deprecatedCommand ?? legacyFixture),
        ]);
    } catch {
        return;
    }
    definitions = await mkdtemp(join(tmpdir(), "plurnk-mcp-client-"));
    currentDefinition = join(definitions, "current server.json");
    legacyDefinition = join(definitions, "legacy server.json");
    await Promise.all([
        writeFile(currentDefinition, JSON.stringify({
            name: "current",
            transport: "stdio",
            command: process.execPath,
            args: [currentFixture],
            tools: ["echo"],
            read: ["echo"],
        })),
        writeFile(legacyDefinition, JSON.stringify({
            name: "legacy",
            transport: "stdio",
            command: deprecatedCommand ?? process.execPath,
            args: deprecatedCommand === undefined ? [legacyFixture] : [],
        })),
    ]);
    daemon = await bootDaemon(bin);
});

after(async () => {
    await daemon?.cleanup();
    if (definitions.length > 0) await rm(definitions, { recursive: true, force: true });
});

describe("TUI workspace MCP dogfood", () => {
    test("[§cli-workspace-mcp-controls] current lifecycle succeeds; deprecated endpoint is attributed exactly", { timeout: 60_000 }, async (t) => {
        if (daemon === null) { t.skip("service checkout with MCP fixtures is not reachable"); return; }
        const tui = spawnTui(daemon.url);
        try {
            await tui.waitFor(/plurnk.*\/help/);

            tui.write(`/mcp ${currentDefinition}\r`);
            await tui.waitFor(/attached: current \(connected\)/, 20_000);

            tui.write("/mcp\r");
            await tui.waitFor(/current\s+connected\s+stdio\s+1\/2 tools/, 20_000);

            tui.write("/mcp reconnect current\r");
            await tui.waitFor(/reconnected: current \(connected\)/, 20_000);

            tui.write(`/mcp replace ${currentDefinition}\r`);
            await tui.waitFor(/replaced: current \(connected\)/, 20_000);

            tui.write(`/mcp ${legacyDefinition}\r`);
            const rejected = await tui.waitFor(/Protocol revision unsupported[\s\S]*upgrade or replace the legacy endpoint/i, 20_000);
            assert.match(rejected, /required revision 2026-07-28 through server\/discover/);

            tui.write("/mcp detach current\r");
            await tui.waitFor(/detached: current/, 20_000);
            tui.write("/quit\r");
            assert.equal(await tui.exited, 0);
        } finally {
            tui.kill();
        }
    });
});
