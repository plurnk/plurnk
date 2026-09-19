// PTY coverage for inspection ({§cli-inspection}) — `/look`, the human's READ that is never a
// run: no lifecycle, no summary, no log entry — and its Alt-p/Alt-n cycler. This is the
// interactive surface unit tests can't reach: the Alt-p byte interception, the composer
// prefill, the submit→op.look path, and the readout printed above the composer.
//
// Daemon-gated, NOT model-gated: we seed content with a raw EDIT (op.parse,
// --yolo auto-accepts the proposal) — no loop.run, no provider needed.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { bootDaemon, locateDaemon, type Daemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

let daemon: Daemon | null = null;

before(async () => {
    const bin = await locateDaemon();
    if (bin === null) return;            // no service checkout → suite skips per-test
    daemon = await bootDaemon(bin);
});

after(async () => { await daemon?.cleanup(); });

describe("TUI inspection (/look)", () => {
    test("Alt-p prefills /look with the prior op's real target into an empty composer, and leaves a draft alone", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url, ["--yolo"]);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            // Seed an op whose target the cycler can surface (--yolo accepts the EDIT proposal).
            tui.write("\x1b[200~````EDIT (worker:///plan.md)\nlook-probe-42\n````\x1b[201~\r");
            await tui.waitFor(/final 2\d\d/, 45_000);  // cold-boot embedding derivation (svc: first op warms ~70 entries)
            // Alt-p (ESC p) → the newest prior op's REAL uri, as an editable /look line.
            tui.write("\x1bp");
            await tui.waitFor(/\/look worker:\/\/\/plan\.md/);
            const prefills = (): number => tui.output().split("/look worker:///plan.md").length - 1;
            const seen = prefills();
            // A draft is the user's: Alt-p never replaces it.
            tui.write("\x15");
            tui.write("a draft of my own");
            await tui.waitFor(/a draft of my own/);
            tui.write("\x1bp");
            await delay(300);
            assert.equal(prefills(), seen, "Alt-p left the draft alone");
            assert.match(tui.output().slice(-400), /a draft of my own/, "the draft is still the composer's value");
            tui.write("\x15");
            tui.write("/quit\r");
            assert.equal(await tui.exited, 0);
        } finally {
            tui.kill();
        }
    });

    // The client composes the LOOK fence and sends it to op.look. AG-UI admits and
    // rewrites it once for a non-logging read, so no corresponding entry reaches the model,
    // and the client runs no loop for it: no lifecycle, no summary line.
    test("/look reads the resource for the human: the readout, no run summary", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url, ["--yolo"]);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write("\x1b[200~````EDIT (worker:///note.md)\nlook-harvest-99\n````\x1b[201~\r");
            await tui.waitFor(/final 2\d\d/, 45_000);  // cold-boot embedding derivation (svc: first op warms ~70 entries)
            const before = tui.output().length;
            tui.write("/look worker:///note.md\r");
            await tui.waitFor(/LOOK \(worker:\/\/\/note\.md\)[\s\S]*look-harvest-99/);
            await delay(300);
            const since = tui.output().slice(before);
            assert.ok(!/\d+ turns? · /.test(since), `inspection printed no run summary:\n${since}`);
            // A typed LOOK fence takes the same path.
            tui.write("````LOOK (worker:///note.md)````\r");
            // The /look readout, the fence's echo, and the fence's readout each carry the heading; the
            // content follows the third.
            await tui.waitFor(/(?:LOOK \(worker:\/\/\/note\.md\)[\s\S]*){3}look-harvest-99/);
            tui.write("/quit\r");
            assert.equal(await tui.exited, 0);
        } finally {
            tui.kill();
        }
    });

    test("/look on a missing resource names the daemon's Problem, not a bare status", async (t) => {
        if (daemon === null) { t.skip("no plurnk-service binary reachable"); return; }
        const tui = spawnTui(daemon.url, ["--yolo"]);
        try {
            await tui.waitFor(/plurnk.*\/help/);
            tui.write("/look worker:///missing.md\r");
            await tui.waitFor(/LOOK \(worker:\/\/\/missing\.md\) — \S/, 45_000);
            assert.doesNotMatch(tui.output(), /no content\)/, "the old status-only readout is gone");
            tui.write("/quit\r");
            assert.equal(await tui.exited, 0);
        } finally {
            tui.kill();
        }
    });
});
