// {§cli-palette} — one module names every colour and emphasis by role (plurnk#97).

import { test } from "node:test";
import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { backgroundScheme, colorEnabled, colorFgBgScheme, learnScheme, paint, withColorOutput } from "./color.ts";
import { renderMarkdownDocument } from "./markdown.ts";
import { renderSummary } from "./render.ts";

// A developer's terminal may export COLORFGBG; the accents pinned here are the dark ground's.
delete process.env.COLORFGBG;

test("[§cli-color-policy] output destination and preferences determine whether styling is enabled", () => {
    const cases: [string, boolean, NodeJS.ProcessEnv, boolean][] = [
        ["terminal", true, {}, true],
        ["pipe", false, {}, false],
        ["dumb terminal", true, { TERM: "dumb" }, false],
        ["empty NO_COLOR", true, { NO_COLOR: "" }, true],
        ["nonempty NO_COLOR including zero", true, { NO_COLOR: "0" }, false],
        ["NO_COLOR beats force", true, { NO_COLOR: "1", FORCE_COLOR: "1", CLICOLOR_FORCE: "1" }, false],
        ["force into pipe", false, { FORCE_COLOR: "1" }, true],
        ["force into dumb terminal", true, { TERM: "dumb", CLICOLOR_FORCE: "1" }, true],
        ["empty force is unset", false, { FORCE_COLOR: "", CLICOLOR_FORCE: "" }, false],
        ["nonempty force has no numeric semantics", false, { FORCE_COLOR: "0" }, true],
        ["CLICOLOR disables", true, { CLICOLOR: "0" }, false],
        ["CLICOLOR does not force a pipe", false, { CLICOLOR: "1" }, false],
        ["force beats CLICOLOR", false, { CLICOLOR: "0", FORCE_COLOR: "1" }, true],
        ["always beats NO_COLOR and dumb pipe", false, { PLURNK_CLIENT_COLOR: "always", NO_COLOR: "1", TERM: "dumb" }, true],
        ["never beats force", true, { PLURNK_CLIENT_COLOR: "never", FORCE_COLOR: "1" }, false],
        ["auto honors NO_COLOR", true, { PLURNK_CLIENT_COLOR: "auto", NO_COLOR: "1" }, false],
    ];
    for (const [name, isTTY, env, expected] of cases) {
        assert.equal(colorEnabled({ isTTY }, { PLURNK_CLIENT_COLOR: "auto", ...env }), expected, name);
    }
});

// An SGR writer in source text: an escape spelled any common way, then `[`, then either literal
// parameters closed by `m` or an interpolated parameter list.
const SGR_WRITER = /(?:\\x1b|\\u001b|\\u\{1b\}|\\033|\x1b)\[(?:[\d;]*m|\$\{)/iu;
const SRC = fileURLToPath(new URL(".", import.meta.url));

const withColor = <T>(noColor: string | undefined, render: () => T): T => {
    const saved = process.env.NO_COLOR;
    const mode = process.env.PLURNK_CLIENT_COLOR;
    process.env.PLURNK_CLIENT_COLOR = "always";
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
    if (noColor) process.env.PLURNK_CLIENT_COLOR = "auto";
    try { return render(); } finally {
        if (saved === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = saved;
        if (mode === undefined) delete process.env.PLURNK_CLIENT_COLOR;
        else process.env.PLURNK_CLIENT_COLOR = mode;
    }
};

test("[§cli-palette] no module but the palette writes a colour or emphasis code", async () => {
    assert.match(await readFile(new URL("./color.ts", import.meta.url), "utf8"), SGR_WRITER, "the palette is the one writer");
    const writers: string[] = [];
    for await (const file of glob("**/*.ts", { cwd: SRC })) {
        if (file.endsWith(".test.ts") || file === "color.ts") continue;
        if (SGR_WRITER.test(await readFile(`${SRC}${file}`, "utf8"))) writers.push(file);
    }
    assert.deepEqual(writers, []);
});

const ALERTS = ["note", "tip", "important", "warning", "caution"] as const;
const DARK_ALERTS = ["\x1b[94mx\x1b[0m", "\x1b[32mx\x1b[0m", "\x1b[38;5;141mx\x1b[0m", "\x1b[38;5;172mx\x1b[0m", "\x1b[31mx\x1b[0m"];
const LIGHT_ALERTS = ["\x1b[94mx\x1b[0m", "\x1b[32mx\x1b[0m", "\x1b[38;5;97mx\x1b[0m", "\x1b[38;5;130mx\x1b[0m", "\x1b[31mx\x1b[0m"];

test("[§cli-palette] the alert accents are the scheme, and roles combine into one sequence", () => {
    withColor(undefined, () => {
        assert.deepEqual(ALERTS.map((role) => paint("x", role)), DARK_ALERTS);
        assert.equal(paint("x", "bold", "failure"), "\x1b[1;31mx\x1b[0m");
        assert.equal(paint("x"), "x", "no role, no sequence");
    });
});

test("[§cli-color-scheme] COLORFGBG's background index decides as Vim does, and anything else is unknown", () => {
    const cases: [string | undefined, "dark" | "light" | undefined][] = [
        ["15;0", "dark"], ["0;15", "light"], ["15;8", "dark"], ["0;7", "light"], ["0;default;15", "light"],
        [" 0 ; 6 ", "dark"], ["0;default", undefined], ["0;16", undefined], ["", undefined], [undefined, undefined],
    ];
    for (const [value, expected] of cases) {
        assert.equal(colorFgBgScheme(value === undefined ? {} : { COLORFGBG: value }), expected, JSON.stringify(value));
    }
});

test("[§cli-color-scheme] a background is dark when white text contrasts with it more than black text", () => {
    const [black, solarizedDark, white, solarizedLight] = [[0, 0, 0], [0, 43, 54], [255, 255, 255], [253, 246, 227]]
        .map(([r, g, b]) => backgroundScheme({ r, g, b }));
    assert.deepEqual([black, solarizedDark, white, solarizedLight], ["dark", "dark", "light", "light"]);
});

test("[§cli-color-scheme] a light ground darkens the fixed accents, and the terminal's answer outranks COLORFGBG", (t) => {
    t.after(() => { learnScheme(undefined); delete process.env.COLORFGBG; });
    const alerts = () => withColor(undefined, () => ALERTS.map((role) => paint("x", role)));
    process.env.COLORFGBG = "0;15";
    assert.deepEqual(alerts(), LIGHT_ALERTS, "the one-shot CLI has only COLORFGBG");
    learnScheme("dark");
    assert.deepEqual(alerts(), DARK_ALERTS, "the TUI's answer from the terminal wins");
    learnScheme("light");
    delete process.env.COLORFGBG;
    assert.deepEqual(alerts(), LIGHT_ALERTS);
});

test("[§cli-color-scheme] muted UI and inline code use a ground-aware foreground, not terminal faint intensity", (t) => {
    t.after(() => { learnScheme(undefined); });
    for (const [scheme, index] of [["dark", 145], ["light", 60]] as const) {
        learnScheme(scheme);
        withColor(undefined, () => {
            const foreground = `\x1b[38;5;${index}m`;
            assert.equal(paint("muted", "dim"), `${foreground}muted\x1b[0m`);
            assert.equal(paint("aside", "dim", "italic"), `\x1b[38;5;${index};3maside\x1b[0m`);
            assert.equal(renderMarkdownDocument("Plain `inline` text.", 80).trimEnd(), `Plain ${foreground}inline\x1b[0m text.`);
            assert.equal(renderSummary(1, 500, { status: 200 }, false), `${foreground}  done · 1 turn · 500ms\x1b[0m`);
        });
        assert.equal(withColor("1", () => paint("muted", "dim")), "muted");
    }
});

test("[§cli-palette] any non-empty NO_COLOR removes colour and emphasis; an empty one does not", () => {
    assert.equal(withColor("1", () => paint("x", "bold", "caution")), "x");
    assert.equal(withColor("", () => paint("x", "bold", "caution")), "\x1b[1;31mx\x1b[0m");
});

test("[§cli-color-policy] concurrent renderers retain their own destination across asynchronous work", async (t) => {
    const keys = ["PLURNK_CLIENT_COLOR", "NO_COLOR", "FORCE_COLOR", "CLICOLOR_FORCE", "CLICOLOR", "TERM"];
    const saved = keys.map((key) => [key, process.env[key]] as const);
    for (const key of keys) delete process.env[key];
    t.after(() => {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    });
    const render = async (isTTY: boolean) => await withColorOutput({ isTTY }, async () => {
        await Promise.resolve();
        const result = paint("x", "bold");
        assert.equal(withColorOutput({ isTTY: !isTTY }, () => colorEnabled()), !isTTY);
        assert.equal(colorEnabled(), isTTY, "nested rendering restores the outer destination");
        return result;
    });
    assert.deepEqual(await Promise.all([render(true), render(false)]), ["\x1b[1mx\x1b[0m", "x"]);
    const heading = "# Hello";
    assert.match(withColorOutput({ isTTY: true }, () => renderMarkdownDocument(heading, 40)), /\x1b\[1m/);
    assert.doesNotMatch(withColorOutput({ isTTY: false }, () => renderMarkdownDocument(heading, 40)), /\x1b\[/);
});
