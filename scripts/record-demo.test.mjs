import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import xtermHeadless from "@xterm/headless";
import { cellColorCss, renderXtermRowsHtml, seedDemoProject } from "./record-demo.mjs";

const Terminal = xtermHeadless.Terminal ?? xtermHeadless.default?.Terminal;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("{§cli-rendering} record-demo renders ANSI color, wide glyphs, and cursor cells from @xterm/headless (#261)", async () => {
    const term = new Terminal({ cols: 24, rows: 2, allowProposedApi: true });
    await new Promise((r) => term.write("\x1b[1;32m🔎\x1b[0m \x1b[2mfind\x1b[0m 漢", r));
    const htmlWithCursor = renderXtermRowsHtml(term, true);
    assert.match(htmlWithCursor, /font-weight:700/u);
    assert.match(htmlWithCursor, /display:inline-block;width:2ch/u);
    assert.match(htmlWithCursor, /🔎/u);
    assert.match(htmlWithCursor, /rgba\(230,237,243,0\.62\)/u);
    assert.match(htmlWithCursor, /background:#58a6ff/u);

    const htmlNoCursor = renderXtermRowsHtml(term, false);
    assert.doesNotMatch(htmlNoCursor, /background:#58a6ff/u);
    assert.equal(cellColorCss(0x03000000, 0x148800, true, false), "#148800");
});

test("{§cli-conformance} record-demo seeds an isolated retry-budget repository with an unstaged jitter bug (#261)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-record-demo-test-"));
    try {
        await seedDemoProject(dir);
        const diff = execFileSync("git", ["diff"], { cwd: dir, encoding: "utf8" });
        assert.match(diff, /- {4}const jitter = 0\.5 \+ Math\.random\(\) \* 0\.5;/u);
        assert.match(diff, /\+ {4}const jitter = 0;/u);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("{§cli-conformance} README embeds docs/media/session.webp and --help exits cleanly (#261)", async () => {
    const out = execFileSync(process.execPath, [join(ROOT, "scripts", "record-demo.mjs"), "--help"], {
        encoding: "utf8",
    });
    assert.match(out, /Usage: node scripts\/record-demo\.mjs/u);

    const readme = await readFile(join(ROOT, "README.md"), "utf8");
    assert.match(readme, /docs\/media\/session\.webp/u);
    assert.doesNotMatch(readme, /session\.gif/u);

    const webpPath = join(ROOT, "docs", "media", "session.webp");
    const info = await stat(webpPath);
    assert.ok(info.size > 100_000, "session.webp should be non-trivial");
    const header = await readFile(webpPath);
    assert.equal(header.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(header.subarray(8, 12).toString("ascii"), "WEBP");
});