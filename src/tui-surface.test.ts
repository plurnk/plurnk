// [§cli-color-scheme] — the TUI learns the terminal's ground from the terminal itself.
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import type { Terminal } from "@earendil-works/pi-tui";
import { learnScheme, paint } from "./color.ts";
import TuiSurface from "./tui-surface.ts";

const WARNING = { dark: "\x1b[38;5;172mx\x1b[0m", light: "\x1b[38;5;130mx\x1b[0m" };
const BACKGROUND_QUERY = "\x1b]11;?";
const SCHEME_NOTIFICATIONS = "\x1b[?2031h";
const DA1 = "\x1b[?62;22c";
const ORIGINAL = { color: process.env.PLURNK_CLIENT_COLOR, colorFgBg: process.env.COLORFGBG };

const fixture = (t: TestContext, color: "always" | "never", onWrite?: (text: string) => void) => {
    process.env.PLURNK_CLIENT_COLOR = color;
    delete process.env.COLORFGBG;
    let input: (data: string) => void = () => {};
    const output: string[] = [];
    const terminal: Terminal = {
        columns: 100, rows: 30, kittyProtocolActive: false,
        start: (handler) => { input = handler; }, stop() {}, drainInput: async () => {},
        write: (text) => { output.push(text); onWrite?.(text); }, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
        clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
    };
    const surface = new TuiSurface(terminal);
    t.after(() => {
        surface.stop();
        learnScheme(undefined);
        if (ORIGINAL.color === undefined) delete process.env.PLURNK_CLIENT_COLOR;
        else process.env.PLURNK_CLIENT_COLOR = ORIGINAL.color;
        if (ORIGINAL.colorFgBg !== undefined) process.env.COLORFGBG = ORIGINAL.colorFgBg;
    });
    const reply = async (...data: string[]) => {
        for (const sequence of data) input(sequence);
        await setImmediate();
    };
    return { surface, output, reply };
};

for (const [scheme, index] of [["dark", 145], ["light", 60]] as const) for (const color of ["always", "never"] as const) {
    test(`[§cli-status-project-root] the statusline and prompt borders are muted on ${scheme} with color ${color}`, { timeout: 3_000 }, async (t) => {
        const text = "[~/project/~user] idle";
        const rendered = Promise.withResolvers<void>();
        const { surface, output } = fixture(t, color, (value) => {
            if (value.includes(text)) rendered.resolve();
        });
        learnScheme(scheme);
        surface.setStatus(text);
        surface.start();
        await rendered.promise;
        const renderedOutput = output.join("");
        const foreground = `\x1b[38;5;${index}m`;
        if (color === "always") {
            assert.match(renderedOutput, new RegExp(`${RegExp.escape(foreground + text)} *${RegExp.escape("\x1b[0m")}`));
            assert.ok(renderedOutput.includes(`${foreground}─`), "the prompt borders share the muted foreground");
        }
        else assert.doesNotMatch(renderedOutput, /\x1b\[38;/);
        assert.ok(renderedOutput.includes(text));
        assert.doesNotMatch(renderedOutput, /\x1b\[2m/, "muted must not depend on terminal faint rendering");
    });
}

test("[§cli-color-scheme] the background the terminal reports decides before anything is painted, and an announced switch asks again", async (t) => {
    const { surface, output, reply } = fixture(t, "always");
    const learning = surface.learnGround();
    assert.ok(output.some((text) => text.includes(BACKGROUND_QUERY)), "the TUI asks for the background");
    await reply("\x1b]11;rgb:ffff/ffff/ffff\x07", DA1);
    await learning;
    assert.equal(paint("x", "warning"), WARNING.light);
    surface.start();
    assert.ok(output.includes(SCHEME_NOTIFICATIONS), "the running TUI listens for the terminal's light/dark announcements");
    const asked = output.filter((text) => text.includes(BACKGROUND_QUERY)).length;
    await reply("\x1b[?997;1n", "\x1b]11;rgb:0000/0000/0000\x07", DA1);
    assert.equal(output.filter((text) => text.includes(BACKGROUND_QUERY)).length, asked + 1, "the switch asks again");
    assert.equal(paint("x", "warning"), WARNING.dark);
});

test("[§cli-color-scheme] without a background the terminal's light/dark report decides", async (t) => {
    const { surface, reply } = fixture(t, "always");
    const learning = surface.learnGround();
    await reply(DA1);
    await learning;
    assert.equal(paint("x", "warning"), WARNING.dark, "no answer keeps the dark ground's palette");
    surface.start();
    await reply("\x1b[?997;2n", DA1);
    assert.equal(paint("x", "warning"), WARNING.light);
});

test("[§cli-color-scheme] a terminal appearance change repaints unchanged footer, prompt and pending-review text", { timeout: 3_000 }, async (t) => {
    const text = "[~/project/~user] idle";
    const dark = Promise.withResolvers<void>();
    const light = Promise.withResolvers<void>();
    const { surface, reply, output } = fixture(t, "always", (value) => {
        if (value.includes(`\x1b[38;5;145m${text}`)) dark.resolve();
        if (value.includes(`\x1b[38;5;60m${text}`)) light.resolve();
    });
    learnScheme("dark");
    surface.setInput("Unchanged draft");
    surface.setReview({ render: () => [], invalidate() {} }, 1);
    surface.setStatus(text);
    surface.start();
    await dark.promise;
    await reply("\x1b[?997;2n", "\x1b]11;rgb:fdfd/f6f6/e3e3\x07", DA1);
    await light.promise;
    assert.ok(output.join("").includes("\x1b[38;5;60m1 pending review · /review · /cancel"));
    assert.ok(output.join("").includes("\x1b[38;5;60m─"));
    assert.equal(surface.editor.getText(), "Unchanged draft");
});

test("[§cli-color-scheme] with colour off the TUI asks the terminal nothing", async (t) => {
    const asks = (output: string[]) => [BACKGROUND_QUERY, SCHEME_NOTIFICATIONS].map((ask) => output.some((text) => text.includes(ask)));
    const off = fixture(t, "never");
    await off.surface.learnGround();
    off.surface.start();
    const on = fixture(t, "always");
    const learning = on.surface.learnGround();
    await on.reply(DA1);
    await learning;
    on.surface.start();
    assert.deepEqual([asks(off.output), asks(on.output)], [[false, false], [true, true]]);
});
