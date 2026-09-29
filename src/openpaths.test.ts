import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractOpenPaths } from "./openpaths.ts";

// {§cli-prompt-open-paths}
let root: string;

before(async () => {
    root = await mkdtemp(join(tmpdir(), "plurnk-openpaths-"));
    await mkdir(join(root, "src"));
    await mkdir(join(root, "docs"));
    await Promise.all(["src/x.ts", "src/foo.ts", "a.ts", "b.ts", "README.md", "docs/x.md"]
        .map((path) => writeFile(join(root, path), "")));
});

after(async () => { await rm(root, { recursive: true }); });

test("[§cli-prompt-open-paths] an existing @src/x.ts opens", () => {
    assert.deepEqual(extractOpenPaths("explain @src/x.ts please", root), ["src/x.ts"]);
});

test("[§cli-prompt-open-paths] absolute local references become workspace-relative READ targets", () => {
    assert.deepEqual(extractOpenPaths(`@${root}/src/x.ts and @src/x.ts`, root), ["src/x.ts"]);
});

test("[§cli-prompt-open-paths] @someone with no such file opens nothing", () => {
    assert.deepEqual(extractOpenPaths("thanks to @czgdp1807 for the report", root), []);
});

test("[§cli-prompt-open-paths] an email-like a@b.com opens nothing", () => {
    assert.deepEqual(extractOpenPaths("mail a@b.com about it", root), []);
});

test("[§cli-prompt-open-paths] a directory opens nothing", () => {
    assert.deepEqual(extractOpenPaths("look in @src", root), []);
});

test("[§cli-prompt-open-paths] a path through a file opens nothing", () => {
    assert.deepEqual(extractOpenPaths("see @a.ts/inner", root), []);
});

test("[§cli-prompt-open-paths] an existing file outside the project root opens nothing", async () => {
    const outside = join(root, "..", `${root.split("/").at(-1)}-outside.ts`);
    await writeFile(outside, "");
    try {
        assert.deepEqual(extractOpenPaths(`see @${outside} and @../${root.split("/").at(-1)}-outside.ts`, root), []);
    } finally { await rm(outside); }
});

test("[§cli-prompt-open-paths] a headless workspace opens nothing", () => {
    assert.deepEqual(extractOpenPaths("explain @src/x.ts", null), []);
});

test("[§cli-prompt-open-paths] existing and absent refs mix: only files open", () => {
    assert.deepEqual(extractOpenPaths("@a.ts cc @someone and @src/foo.ts", root), ["a.ts", "src/foo.ts"]);
});

test("extractOpenPaths: multiple refs, deduped, order preserved", () => {
    assert.deepEqual(extractOpenPaths("@a.ts and @b.ts and @a.ts again", root), ["a.ts", "b.ts"]);
});

test("extractOpenPaths: @ at line start counts", () => {
    assert.deepEqual(extractOpenPaths("@README.md what is this", root), ["README.md"]);
});

test("extractOpenPaths: trailing sentence punctuation is trimmed", () => {
    assert.deepEqual(extractOpenPaths("see @docs/x.md.", root), ["docs/x.md"]);
    assert.deepEqual(extractOpenPaths("compare @a.ts, @b.ts;", root), ["a.ts", "b.ts"]);
});

test("extractOpenPaths: no refs → empty", () => {
    assert.deepEqual(extractOpenPaths("just a plain prompt", root), []);
});
