// PTY coverage for <<LOOK — the off-run "READ, but for me, not the model"
// operator and its Alt-p/Alt-n cycler. This is the interactive surface unit
// tests can't reach: the Alt-p byte interception, setLine's buffer replacement,
// the submit→runLook path, and the harvested content rendering.
//
// Daemon-gated, NOT model-gated: we seed content with a raw `<<EDIT` (op.parse,
// --yolo auto-accepts the proposal) — no loop.run, no provider needed.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { bootDaemon, locateDaemon, type Daemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

let daemon: Daemon | null = null;

before(async () => {
    const bin = await locateDaemon();
    if (bin === null) return;            // no service checkout → suite skips per-test
    daemon = await bootDaemon(bin);
});

after(async () => { await daemon?.cleanup(); });

describe("TUI <<LOOK (off-run inspection)", () => {
    test("Alt-p templates a <<LOOK at the prior op's real target", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url, ["--yolo"]);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            // Seed an op whose target the cycler can surface (--yolo accepts the EDIT proposal).
            tui.write("<<EDIT(known:///plan.md):look-probe-42:EDIT\r");
            await tui.waitFor(/final 2\d\d/);   // op COMPLETED → priorTargets populated (not just the echo)
            // Alt-p (ESC p) → the newest prior op's REAL uri, templated as a LOOK line.
            tui.write("\x1bp");
            await tui.waitFor(/<<LOOK\(known:\/\/\/plan\.md\)::LOOK/);
            // Alt-p left the templated LOOK line in the buffer — clear it (Ctrl-U)
            // so /quit is a clean verb, not appended to the template.
            tui.write("\x15");
            tui.write("/quit\r");
            assert.equal(await tui.exited, 0);
        } finally {
            tui.kill();
        }
    });

    // The client rewrites <<LOOK→<<READ and calls op.look (plurnk-service#283,
    // shipped v0.57.0) on the main connection — a non-logging read, so the body
    // renders for the human with no log entry the model would see.
    test("submitting <<LOOK harvests and renders the entry content off-run", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url, ["--yolo"]);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write("<<EDIT(known:///note.md):look-harvest-99:EDIT\r");
            await tui.waitFor(/final 2\d\d/);
            // op.look resolves the target and returns content with NO log entry.
            // Anchor past the LOOK echo (::LOOK) so we match the HARVEST, not the typed line.
            tui.write("<<LOOK(known:///note.md)::LOOK\r");
            await tui.waitFor(/::LOOK[\s\S]*look-harvest-99/);
            tui.write("/quit\r");
            assert.equal(await tui.exited, 0);
        } finally {
            tui.kill();
        }
    });
});
