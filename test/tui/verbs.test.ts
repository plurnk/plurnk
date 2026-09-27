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
import { bootDaemon, completionsEndpoint, locateDaemon, type CompletionsEndpoint, type Daemon } from "../intg/harness.ts";
import { actionViaBridge } from "../../src/agui.ts";
import { spawnTui } from "./harness.ts";

let daemon: Daemon | null = null;
let endpoint: CompletionsEndpoint | null = null;   // a scripted model behind the `clientloop` alias: one KILL turn ends every loop
let members = false;   // the daemon serves the members Functionality family
let env = false;       // the daemon serves the env Functionality family

before(async () => {
    const bin = await locateDaemon();
    if (bin !== null) {
        endpoint = await completionsEndpoint(() => "````KILL\nloop gauge\n````");
        daemon = await bootDaemon(bin, {
            extraEnv: {
                PLURNK_MODEL_clientfirst: "openai/client-first",
                PLURNK_MODEL_clienttest: "openai/client-test",
                PLURNK_MODEL_clientloop: "openai/client-loop",
                PLURNK_BASEURL_clientloop: endpoint.url,
                PLURNK_PROVIDERS_CONTEXT_WINDOW_clientfirst: "32768",
                PLURNK_PROVIDERS_CONTEXT_WINDOW_clienttest: "32768",
                PLURNK_PROVIDERS_CONTEXT_WINDOW_clientloop: "32768",
                PLURNK_PROVIDERS_EFFORT_clientfirst: "adaptive",
                PLURNK_PROVIDERS_EFFORT_clienttest: "adaptive",
                PLURNK_PROVIDERS_EFFORT_clientloop: "adaptive",
                PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
                OPENAI_API_KEY: "client-control-plane-test",
            },
        });
        const discovery = await actionViaBridge<{ actions: Record<string, unknown> }>({ bridgeUrl: daemon.url }, { threadId: "verbs-discovery", kind: "discover" });
        members = "workspace.members.list" in discovery.actions;
        env = "worker.env.list" in discovery.actions;
    }
});
after(async () => { await daemon?.cleanup(); await endpoint?.close(); });

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

    test("[§cli-model-selection][§cli-effort] the model and its effort persist through the live TUI", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write("/model clientfirst\r"); await tui.waitFor(/model: clientfirst/);
            tui.write("/model clienttest\r"); await tui.waitFor(/model: clienttest/);
            tui.write("/model\r");            await tui.waitFor(/model: clienttest/); // sticky — the switch persisted
            tui.write("/effort adaptive\r");
            await tui.waitFor(/effort: adaptive[\s\S]*supported:/);
            tui.write("/effort\r");
            await tui.waitFor(/supported:[\s\S]*supported:/);
        } finally { tui.kill(); }
    });

    // {§cli-identity-effort} — the status row's identity is the daemon's re-read route after every
    // durable-policy change; the setter's own action run carries a pre-mutation gauge, which must
    // not be what the operator sees. Each witness is matched only in output after the command.
    const status = async (tui: ReturnType<typeof spawnTui>, command: string, witness: RegExp, timeoutMs = 10_000): Promise<string> => {
        const since = tui.output().length;
        tui.write(`${command}\r`);
        const output = await tui.waitFor(witness, timeoutMs, since);
        return output.slice(since);
    };

    test("[§cli-identity-effort] /effort repaints the identity from the readback while idle, before any loop", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url, ["--model", "clienttest"]);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            await tui.waitFor(/🎲 clienttest\(adaptive\)/);
            await status(tui, "/effort high", /🎲 clienttest\[high\]/);
        } finally { tui.kill(); }
    });

    test("[§cli-identity-effort] /effort repaints the identity after a gauge has already been received", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            await status(tui, "/model clienttest", /🎲 clienttest\(adaptive\)/);
            await status(tui, "/effort high", /🎲 clienttest\[high\]/);
        } finally { tui.kill(); }
    });

    test("[§cli-identity-effort] /effort repaints the identity after a loop's gauge, keeping the loop's lifecycle", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url, ["--model", "clientloop"]);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write("run one turn\r");
            await tui.waitFor(/⏹️ {2}· 🎲 clientloop\(adaptive\)/, 30_000);
            // A base-URL-routed alias is an OpenAI-compatible provider admitting only off and adaptive.
            const row = await status(tui, "/effort off", /🎲 clientloop\[off\]/);
            assert.match(row, /⏹️ {2}· 🎲 clientloop\[off\] · /, "the completed loop's glyph and tallies stay; only the identity changed");
        } finally { tui.kill(); }
    });

    test("[§cli-identity-effort] a chosen effort follows the worker across /model, and the readback paints it", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url, ["--model", "clienttest", "--effort", "high"]);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            await tui.waitFor(/🎲 clienttest\[high\]/);
            await status(tui, "/model clientfirst", /🎲 clientfirst\[high\]/);
        } finally { tui.kill(); }
    });

    // {§cli-status-children} — the gauge's known zero hides the ant, so the child route's readback is
    // witnessed through the bare inspection, which prints the client's last server-read route.
    test("[§cli-identity-effort] /child override and inherit are read back with the parent, and /effort re-reads the child too", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url, ["--model", "clienttest"]);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            await status(tui, "/child clientfirst", /child: clientfirst/);
            await status(tui, "/child", /child: clientfirst\(adaptive\)/);
            await status(tui, "/effort high", /🎲 clienttest\[high\]/);
            await status(tui, "/child", /child: clientfirst\[high\]/);
            await status(tui, "/child inherit", /child: inherit/);
            await status(tui, "/child", /child: inherit/);
        } finally { tui.kill(); }
    });

    test("[§cli-identity-effort] a rejected /effort keeps the daemon Problem visible and the identity unchanged", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url, ["--model", "clienttest"]);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            await tui.waitFor(/🎲 clienttest\(adaptive\)/);
            const since = tui.output().length;
            tui.write("/effort bogus\r");
            await tui.waitFor(/does not match any of/, 10_000, since);
            await tui.waitFor(/🎲 clienttest\(adaptive\)/, 10_000, since);
            assert.doesNotMatch(tui.output().slice(since), /clienttest\[bogus\]|effort: bogus/);
        } finally { tui.kill(); }
    });

    test("[§cli-identity-effort] brackets mark a chosen effort, parentheses a provider default, from admission on", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const given = spawnTui(daemon.url, ["--model", "clientfirst"]);
        try {
            await given.waitFor(/plurnk.*\/help/);
            await given.waitFor(/🎲 clientfirst\(adaptive\)/);
            await status(given, "/effort adaptive", /🎲 clientfirst\[adaptive\]/);
        } finally { given.kill(); }
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
