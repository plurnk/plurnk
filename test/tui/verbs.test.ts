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
    if (bin !== null) daemon = await bootDaemon(bin);
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

    test("[§cli-model-selection] /model <alias> switches the model through the live TUI", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write("/model turboderp\r"); await tui.waitFor(/model: turboderp/);
            tui.write("/model fireslow\r");  await tui.waitFor(/model: fireslow/);
            tui.write("/model\r");            await tui.waitFor(/model: fireslow/);   // sticky — the switch persisted
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
        // --no-agents-md: the daemon auto-picks AGENTS.md (svc#268, PLURNK_AGENTS_AUTO=1
        // in the service .env), which would seed a standing `pick AGENTS.md` rule and
        // pollute the assertions below. Opt out so this test owns the full rule set.
        const tui = spawnTui(daemon.url, ["--no-agents-md"]);
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
});
