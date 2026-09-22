// {§cli-palette} — one module names every colour and emphasis by role (plurnk#97).

import { test } from "node:test";
import assert from "node:assert/strict";
import { glob, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { paint } from "./color.ts";

// An SGR writer in source text: an escape spelled any common way, then `[`, then either literal
// parameters closed by `m` or an interpolated parameter list.
const SGR_WRITER = /(?:\\x1b|\\u001b|\\u\{1b\}|\\033|\x1b)\[(?:[\d;]*m|\$\{)/iu;
const SRC = fileURLToPath(new URL(".", import.meta.url));

const withColor = <T>(noColor: string | undefined, render: () => T): T => {
    const saved = process.env.NO_COLOR;
    if (noColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = noColor;
    try { return render(); } finally {
        if (saved === undefined) delete process.env.NO_COLOR;
        else process.env.NO_COLOR = saved;
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

test("[§cli-palette] the alert accents are the scheme, and roles combine into one sequence", () => {
    withColor(undefined, () => {
        assert.deepEqual(
            (["note", "tip", "important", "warning", "caution"] as const).map((role) => paint("x", role)),
            ["\x1b[94mx\x1b[0m", "\x1b[32mx\x1b[0m", "\x1b[38;5;141mx\x1b[0m", "\x1b[38;5;172mx\x1b[0m", "\x1b[31mx\x1b[0m"],
        );
        assert.equal(paint("x", "bold", "failure"), "\x1b[1;31mx\x1b[0m");
        assert.equal(paint("x"), "x", "no role, no sequence");
    });
});

test("[§cli-palette] any non-empty NO_COLOR removes colour and emphasis; an empty one does not", () => {
    assert.equal(withColor("1", () => paint("x", "bold", "caution")), "x");
    assert.equal(withColor("", () => paint("x", "bold", "caution")), "\x1b[1;31mx\x1b[0m");
});
