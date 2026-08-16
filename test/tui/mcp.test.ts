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
let currentCall = "";
let legacyTarget = "";

before(async () => {
    const bin = await locateDaemon();
    if (bin === null) return;
    const serviceRoot = resolve(process.cwd(), "../plurnk-service");
    const currentFixture = join(serviceRoot, "plurnk-mcp/src/fixtures/echo-server.mjs");
    const legacyFixture = join(serviceRoot, "plurnk-mcp/src/fixtures/legacy-server.mjs");
    const deprecatedCommand = process.env.PLURNK_TEST_DEPRECATED_MCP_BIN;
    legacyTarget = deprecatedCommand ?? process.execPath;
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
    currentCall = join(definitions, "call-current.plk");
    await Promise.all([
        writeFile(currentDefinition, JSON.stringify({
            args: [currentFixture],
            tools: ["echo"],
            read: ["echo"],
        })),
        writeFile(legacyDefinition, JSON.stringify({
            args: deprecatedCommand === undefined ? [legacyFixture] : [],
        })),
        writeFile(currentCall, [
            "# PLAN0",
            "Call the attached current MCP tool through the installed daemon.",
            "",
            "## EXEC0 [current] (echo)",
            '{"message":"installed daemon current peer"}',
            "",
        ].join("\n")),
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

            tui.write(`/mcp add current ${process.execPath} "${currentDefinition}"\r`);
            await tui.waitFor(/added: current \(connected\)/, 20_000);

            tui.write(`/script ${currentCall}\r`);
            const used = await tui.waitFor(/script: 2 ops ok/, 20_000);
            assert.match(used, /200 echo/);

            tui.write("/mcp\r");
            await tui.waitFor(/current\s+connected\s+stdio[\s\S]*1\/2 tools/, 20_000);

            tui.write("/mcp disable current\r");
            await tui.waitFor(/disabled: current \(disabled\)/, 20_000);

            tui.write("/mcp enable current\r");
            await tui.waitFor(/enabled: current \(connected\)/, 20_000);

            tui.write(`/mcp add legacy ${legacyTarget} "${legacyDefinition}"\r`);
            const rejected = await tui.waitFor(/Protocol revision unsupported[\s\S]*upgrade or replace the legacy endpoint/i, 20_000);
            assert.match(rejected, /required revision 2026-07-28 through server\/discover/);

            tui.write("/mcp remove current\r");
            await tui.waitFor(/removed: current/, 20_000);
            tui.write("/quit\r");
            assert.equal(await tui.exited, 0);
        } finally {
            tui.kill();
        }
    });
});
