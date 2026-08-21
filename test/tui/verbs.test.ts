// Model-INDEPENDENT TUI behaviors driven through the pty — verbs that hit the
// daemon but never run a loop, and pure-client input handling. These were
// HITL-only ("verify by hand") until the harness existed; now they're real.
// Daemon-gated (bootDaemon), never model-gated. Each test asserts the behavior
// and kills — the clean /quit→exit-0 path is covered by smoke.test.ts.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootDaemon, locateDaemon, type Daemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

let daemon: Daemon | null = null;

before(async () => {
    const bin = await locateDaemon();
    if (bin !== null) {
        daemon = await bootDaemon(bin, {
            extraEnv: { PLURNK_MODEL_clienttest: "openai/turboderp" },
        });
    }
});
after(async () => { await daemon?.cleanup(); });

describe("TUI verbs + input (model-independent; was HITL-only)", () => {
    test("/yolo toggles local auto-accept on then off", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write("/yolo\r"); await tui.waitFor(/yolo: ON/);
            tui.write("/yolo\r"); await tui.waitFor(/yolo: OFF/);
        } finally { tui.kill(); }
    });

    test("[§cli-model-selection][§cli-reasoning-policy] generation policy persists through the live TUI", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write("/model turboderp\r"); await tui.waitFor(/model: turboderp/);
            tui.write("/model clienttest\r"); await tui.waitFor(/model: clienttest/);
            tui.write("/model\r");            await tui.waitFor(/model: clienttest/); // sticky — the switch persisted
            tui.write("/reasoning adaptive\r");
            await tui.waitFor(/reasoning: adaptive[\s\S]*supported:/);
            tui.write("/reasoning\r");
            await tui.waitFor(/supported:[\s\S]*supported:/);
        } finally { tui.kill(); }
    });

    test("/workspace [name] opens a new named workspace", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write("/workspace ptytest\r");
            await tui.waitFor(/workspace: ptytest \(new\)/);
        } finally { tui.kill(); }
    });

    test("[§cli-import-and-bracketed-paste] bracketed paste folds to one [paste #N] marker (no per-line submit)", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write("\x1b[200~line one\nline two\nline three\x1b[201~");
            await tui.waitFor(/\[paste #\d+ \+\d+ lines\]/);
        } finally { tui.kill(); }
    });

    test("/pick → /members reflects the rule; /drop removes it", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write("/pick *.xyz\r"); await tui.waitFor(/pick: \*\.xyz/);
            tui.write("/members\r");    await tui.waitFor(/rules:.*pick \*\.xyz/);
            tui.write("/drop *.xyz\r");  await tui.waitFor(/dropped 1 constraint/);
            tui.write("/members\r");    await tui.waitFor(/rules: none/);
        } finally { tui.kill(); }
    });

    test("Tab completes a verb prefix (/mo → /model)", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write("/mo\t");           // Tab → common prefix of /models, /model
            await tui.waitFor(/\/model\b/);
        } finally { tui.kill(); }
    });

    test("/import <file> stashes the content behind a paste marker", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const dir = await mkdtemp(join(tmpdir(), "plurnk-import-"));
        const file = join(dir, "note.md");
        await writeFile(file, "first line\nsecond line\nthird line\n");
        const tui = spawnTui(daemon.url);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write(`/import ${file}\r`);
            await tui.waitFor(/\[paste #\d+ \+\d+ lines\]/);
        } finally { tui.kill(); await rm(dir, { recursive: true, force: true }); }
    });

    test("a concluded client EXEC reads inline output from the notified entry owner", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url, ["--yolo"]);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write("! printf '\\157\\167\\156\\145\\162\\055\\162\\145\\141\\144\\055\\064\\062'\r");
            await tui.waitFor(/owner-read-42/, 15_000);
            tui.write("/quit\r");
            assert.equal(await tui.exited, 0);
        } finally { tui.kill(); }
    });
});
