// Proves the PTY harness actually drives keystrokes and captures output —
// the prerequisite for any TUI coverage claim (live e2e checklist item #1).
// Daemon-gated, NOT model-gated: /help and /quit never call loop.run, so this
// runs reliably wherever the service binary is reachable.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootDaemon, locateDaemon, type Daemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

let daemon: Daemon | null = null;

before(async () => {
    const bin = await locateDaemon();
    if (bin === null) return;            // no service checkout → suite skips per-test
    daemon = await bootDaemon(bin);
});

after(async () => { await daemon?.cleanup(); });

describe("TUI pty harness", () => {
    test("[§cli-tui-flow] input prompt carries compact client-owned status", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url, ["--yolo"]);
        try {
            const output = await tui.waitFor(/🔥/);
            assert.match(output, /🔥(?: · 🤖 [^\r\n]+)?/, "idle status carries lifecycle and the model when resolved");
            assert.doesNotMatch(output, /🐹|🧮/, "the prompt has no identity or embedder glyph");
            tui.write("/quit\r");
            assert.equal(await tui.exited, 0);
        } finally {
            tui.kill();
        }
    });

    test("[§cli-tui-mode] banner renders, a verb dispatches, /quit exits clean", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url);
        try {
            // 1. The startup header proves the TUI connected and is at the prompt.
            await tui.waitFor(/plurnk.*\/help/);
            // 2. A verb keystroke round-trips: /help prints the verb table.
            tui.write("/help\r");
            const afterHelp = await tui.waitFor(/\/yolo/);
            assert.match(afterHelp, /\/models .*\/workspaces/, "help lists inspection verbs");
            assert.match(afterHelp, /\/yolo/, "help lists the verb surface");
            // 3. /quit closes the REPL with a clean exit code + the resume hint.
            tui.write("/quit\r");
            await tui.waitFor(/resume this workspace:\s+plurnk --workspace /);
            assert.equal(await tui.exited, 0, "/quit exits 0");
            assert.match(tui.output(), /resume this workspace:\s+plurnk --workspace /, "quit prints the resume one-liner");
        } finally {
            tui.kill();
        }
    });

    test("an Alt-shortcut dispatches a verb (Alt-m → /models)", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write("\x1bm");                 // ESC m = Alt-m → /models
            await tui.waitFor(/selector\s+name\s+context|no models match/, 8_000);
            tui.write("/quit\r");
            assert.equal(await tui.exited, 0);
        } finally {
            tui.kill();
        }
    });

    test("bare Esc clears the composed line while idle (plurnk#25)", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            // Real keypresses arrive as separate chunks; over a pipe the
            // writes would coalesce and hide the lone-ESC chunk. Space them.
            const key = async (bytes: string): Promise<void> => {
                tui.write(bytes);
                await setTimeout(80);
            };
            await key("/helx");                 // a mistyped verb on the line
            await key("\x1b");                  // bare Esc — clears it, no submit
            await key("/help\r");
            // The mistyped line echoes while composed but never executes: the
            // submit after Esc runs /help, and no unknown-verb Problem fires.
            const out = await tui.waitFor(/session\s+\/stop \/quit/, 8_000);
            assert.doesNotMatch(out, /unknown subcommand/, "the escaped line never executed");
            tui.write("/quit\r");
            assert.equal(await tui.exited, 0);
        } finally {
            tui.kill();
        }
    });

    test("/editor (Alt-e) composes the line in $VISUAL and places it back (plurnk#26)", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        // A deterministic "editor": overwrite the buffer with /help.
        const dir = await mkdtemp(join(tmpdir(), "plurnk-editor-e2e-"));
        const editor = join(dir, "editor.sh");
        await writeFile(editor, "#!/bin/sh\nprintf '/help\\n' > \"$1\"\n", { mode: 0o755 });
        const tui = spawnTui(daemon.url, [], { VISUAL: editor });
        try {
            await tui.waitFor(/plurnk.*\/help/);
            const key = async (bytes: string): Promise<void> => {
                tui.write(bytes);
                await setTimeout(80);
            };
            await key("/helx");                 // a seed the editor replaces
            await key("\x1be");                 // Alt-e → $VISUAL
            await key("\r");                    // Enter submits the edited line
            const out = await tui.waitFor(/session\s+\/stop \/quit/, 8_000);
            assert.doesNotMatch(out, /unknown subcommand/, "the edited line ran, not the seed");
            tui.write("/quit\r");
            assert.equal(await tui.exited, 0);
        } finally {
            tui.kill();
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("an invalid explicit --model fails before the TUI accepts input", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url, ["--model", "missing-provider/missing-model"]);
        try {
            const output = await tui.waitFor(/unknown provider|not configured|cannot construct|unavailable/i, 8_000);
            assert.doesNotMatch(output, /resume this workspace:/, "selection failure is not an ordinary interactive exit");
            assert.notEqual(await tui.exited, 0, "the rejected selection fails the invocation");
        } finally {
            tui.kill();
        }
    });
});
