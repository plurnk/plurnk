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
import { actionViaBridge } from "../../src/agui.ts";
import { spawnTui } from "./harness.ts";

let daemon: Daemon | null = null;
let members = false;   // the daemon serves the members Functionality family

before(async () => {
    const bin = await locateDaemon();
    if (bin !== null) {
        daemon = await bootDaemon(bin, {
            extraEnv: {
                PLURNK_MODEL_clientfirst: "openai/client-first",
                PLURNK_MODEL_clienttest: "openai/client-test",
                PLURNK_PROVIDERS_CONTEXT_WINDOW_clientfirst: "32768",
                PLURNK_PROVIDERS_CONTEXT_WINDOW_clienttest: "32768",
                PLURNK_PROVIDERS_REASONING_clientfirst: "adaptive",
                PLURNK_PROVIDERS_REASONING_clienttest: "adaptive",
                OPENAI_API_KEY: "client-control-plane-test",
            },
        });
        const discovery = await actionViaBridge<{ actions: Record<string, unknown> }>({ bridgeUrl: daemon.url }, { threadId: "verbs-discovery", kind: "discover" });
        members = "worker.members.list" in discovery.actions;
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
            tui.write("/model clientfirst\r"); await tui.waitFor(/model: clientfirst/);
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

    test("[§cli-import-and-bracketed-paste] a small multiline paste remains one editable submission", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url, ["--yolo"]);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write("\x1b[200~### EDIT0 (worker:///pasted.md)\nline one\nline two\x1b[201~\r");
            const output = await tui.waitFor(/final 2\d\d/, 15_000);
            assert.equal(output.match(/worker:\/\/\/pasted\.md/g)?.length, 2, "one submitted prompt echo and one operation receipt");
        } finally { tui.kill(); }
    });

    test("[§cli-file-members] /members shares the Functionality lifecycle grammar against the built daemon", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        if (!members) { t.skip("the daemon does not serve the members family"); return; }
        const project = await mkdtemp(join(tmpdir(), "plurnk-members-"));
        await writeFile(join(project, "note.md"), "# note\n");
        await writeFile(join(project, "other.txt"), "x\n");
        const tui = spawnTui(daemon.url, [], {}, project);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write("/members add note note.md\r");
            await tui.waitFor(/added: note \(active\)/, 20_000);
            tui.write("/members\r");
            await tui.waitFor(/note\s+worker\s+active\s+include note\.md → 1 file/, 20_000);
            tui.write("/members discover note.md\r");
            await tui.waitFor(/note-md\s+member\s+note\.md\s+member — /, 20_000);
            tui.write("/members add no-txt !*.txt\r");
            await tui.waitFor(/added: no-txt \(active\)/, 20_000);
            tui.write("/members\r");
            await tui.waitFor(/no-txt\s+worker\s+active\s+exclude \*\.txt → 0 members/, 20_000);
            tui.write("/members disable note\r");
            await tui.waitFor(/disabled: note \(disabled\)/, 20_000);
            tui.write("/members remove note\r");
            await tui.waitFor(/removed: note/, 20_000);
        } finally { tui.kill(); await rm(project, { recursive: true, force: true }); }
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

    test("/import <file> inserts native multiline content into the composer", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const dir = await mkdtemp(join(tmpdir(), "plurnk-import-"));
        const file = join(dir, "note.md");
        await writeFile(file, "first line\nsecond line\nthird line\n");
        const tui = spawnTui(daemon.url);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write(`/import ${file}\r`);
            await tui.waitFor(/first line[\s\S]*second line[\s\S]*third line/);
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
