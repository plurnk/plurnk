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
let env = false;       // the daemon serves the env Functionality family

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
        members = "workspace.members.list" in discovery.actions;
        env = "worker.env.list" in discovery.actions;
    }
});
after(async () => { await daemon?.cleanup(); });

describe("TUI verbs + input (model-independent; was HITL-only)", () => {
    test("/yolo and Shift-Tab both toggle local auto-accept on then off (review ships)", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write("/yolo\r"); await tui.waitFor(/yolo: ON/);
            tui.write("/yolo\r"); await tui.waitFor(/yolo: OFF/);
            // The gesture an operator actually reaches for, proved against the real terminal:
            // `ESC [ Z` is the xterm back-tab, and it drives the same verb.
            tui.write("\x1b[Z"); await tui.waitFor(/yolo: ON/);
            tui.write("\x1b[Z"); await tui.waitFor(/yolo: OFF/);
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
            tui.write("\x1b[200~````EDIT (worker:///pasted.md)\nline one\nline two\n````\x1b[201~\r");
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
            await tui.waitFor(/note\s+workspace\s+active\s+include note\.md → 1 file/, 20_000);
            tui.write("/members discover note.md\r");
            await tui.waitFor(/note-md\s+member\s+note\.md\s+member — /, 20_000);
            tui.write("/members add no-txt !*.txt\r");
            await tui.waitFor(/added: no-txt \(active\)/, 20_000);
            tui.write("/members\r");
            await tui.waitFor(/no-txt\s+workspace\s+active\s+exclude \*\.txt → 0 members/, 20_000);
            tui.write("/members disable note\r");
            await tui.waitFor(/disabled: note \(disabled\)/, 20_000);
            tui.write("/members remove note\r");
            await tui.waitFor(/removed: note/, 20_000);
        } finally { tui.kill(); await rm(project, { recursive: true, force: true }); }
    });

    test("[§cli-environment] /env shares the Functionality lifecycle grammar against the built daemon, for this tab's worker", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        if (!env) { t.skip("the daemon does not serve the env family"); return; }
        const tui = spawnTui(daemon.url);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write("/env add CARGO_TARGET_DIR /tmp/plurnk-verbs\r");
            await tui.waitFor(/added: CARGO_TARGET_DIR \(active\)/, 20_000);
            tui.write("/env\r");
            await tui.waitFor(/CARGO_TARGET_DIR\s+worker\s+active\s+\/tmp\/plurnk-verbs/, 20_000);
            tui.write("/env discover PAGER\r");
            await tui.waitFor(/PAGER\s+@plurnk\/plurnk-execs/, 20_000);
            tui.write("/env disable CARGO_TARGET_DIR\r");
            await tui.waitFor(/disabled: CARGO_TARGET_DIR \(disabled\)/, 20_000);
            tui.write("/env remove CARGO_TARGET_DIR\r");
            await tui.waitFor(/removed: CARGO_TARGET_DIR/, 20_000);
            const step = async (command: string, result: RegExp) => {
                const since = tui.output().length;
                tui.write(`${command}\r`);
                await tui.waitFor(result, 10000, since);
            };
            await step("/env --scope workspace add SHARED_NAME shared-value", /added: SHARED_NAME \(active\)/);
            await step("/env", /SHARED_NAME\s+workspace\s+active\s+shared-value/);
            await step("/env add SHARED_NAME worker-value", /added: SHARED_NAME \(active\)/);
            await step("/env --scope=workspace", /SHARED_NAME\s+workspace\s+active\s+shared-value/);
            await step("/env --scope workspace disable SHARED_NAME", /disabled: SHARED_NAME \(disabled\)/);
            await step("/env --scope workspace enable SHARED_NAME", /enabled: SHARED_NAME \(active\)/);
            await step("/env --scope workspace discover PAGER", /PAGER\s+@plurnk\/plurnk-execs/);
            await step("/env --scope workspace remove SHARED_NAME", /removed: SHARED_NAME/);
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

    test("a concluded client execution reads inline output from the notified entry owner", async (t) => {
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
