import test from "node:test";
import assert from "node:assert/strict";
import headless from "@xterm/headless";
import { screenText } from "./harness.ts";

test("{§cli-identity-effort}: terminal observation retains unchanged rows across a wrapped status repaint", async (t) => {
    const terminal = new headless.Terminal({ cols: 40, rows: 5, allowProposedApi: true });
    t.after(() => terminal.dispose());
    const write = (text: string) => new Promise<void>((resolve) => terminal.write(text, resolve));
    await write("workspace/~user 🔥 ⏹️  · 🎲\r\nclientloop(adaptive) · 1s");
    assert.match(screenText(terminal), /⏹️\s+· 🎲\s+clientloop\(adaptive\)/u);
    await write("\r\x1b[2Kclientloop[off] · 1s");
    assert.match(screenText(terminal), /⏹️\s+· 🎲\s+clientloop\[off\] · 1s/u);
    assert.doesNotMatch(screenText(terminal), /adaptive/u, "replaced text is not current terminal state");
});

test("{§cli-identity-effort}: terminal observation excludes scrolled-out identities", async (t) => {
    const terminal = new headless.Terminal({ cols: 40, rows: 3, allowProposedApi: true });
    t.after(() => terminal.dispose());
    await new Promise<void>((resolve) => terminal.write("old[high]\r\none\r\ntwo\r\ncurrent[off]", resolve));
    assert.doesNotMatch(screenText(terminal), /old\[high\]/u);
    assert.match(screenText(terminal), /current\[off\]/u);
});
