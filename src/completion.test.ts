// Unit tests for client-local path completion.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pathPartial, completePath, dslOpPartial, completeOps } from "./completion.ts";

test("pathPartial: membership verbs expose their glob arg", () => {
    assert.equal(pathPartial("/pick src/comp"), "src/comp");
    assert.equal(pathPartial("/hide *.lock"), "*.lock");
    assert.equal(pathPartial("/view vendor/"), "vendor/");
    assert.equal(pathPartial("/repo packages/ap"), "packages/ap");
    assert.equal(pathPartial("/drop docs"), "docs");
    assert.equal(pathPartial("/import src/fo"), "src/fo");
});

test("pathPartial: non-path contexts → null", () => {
    assert.equal(pathPartial("/mo"), null);          // verb completion, not a path
    assert.equal(pathPartial("/model gemma"), null); // alias, not a path
    assert.equal(pathPartial("explain this"), null); // a prompt
    assert.equal(pathPartial("/pick"), null);        // no space yet → still verb completion
});

const withTree = async (build: (dir: string) => Promise<void>, run: (dir: string) => Promise<void>) => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-comp-"));
    try { await build(dir); await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
};

test("completePath: prefix in cwd, dirs suffixed with /", async () => {
    await withTree(
        async (dir) => {
            await mkdir(join(dir, "components"));
            await writeFile(join(dir, "compat.ts"), "");
            await writeFile(join(dir, "other.ts"), "");
        },
        async (dir) => {
            const [hits, partial] = await completePath("comp", dir);
            assert.equal(partial, "comp");
            assert.deepEqual(hits, ["compat.ts", "components/"]);
        },
    );
});

test("completePath: nested dir partial keeps the dir prefix on completions", async () => {
    await withTree(
        async (dir) => {
            await mkdir(join(dir, "src"));
            await writeFile(join(dir, "src", "alpha.ts"), "");
            await writeFile(join(dir, "src", "beta.ts"), "");
        },
        async (dir) => {
            const [hits] = await completePath("src/al", dir);
            assert.deepEqual(hits, ["src/alpha.ts"]);
        },
    );
});

test("completePath: dotfiles hidden unless prefix starts with '.'", async () => {
    await withTree(
        async (dir) => {
            await writeFile(join(dir, ".env"), "");
            await writeFile(join(dir, "readme.md"), "");
        },
        async (dir) => {
            assert.deepEqual((await completePath("", dir))[0], ["readme.md"]);
            assert.deepEqual((await completePath(".", dir))[0], [".env"]);
        },
    );
});

test("completePath: unreadable directory → no hits, partial echoed", async () => {
    const [hits, partial] = await completePath("no/such/dir/x", "/nonexistent-root");
    assert.deepEqual(hits, []);
    assert.equal(partial, "no/such/dir/x");
});

test("pathPartial: @file completes after a word-boundary @, ignores emails", () => {
    assert.equal(pathPartial("explain @src/fo"), "src/fo");
    assert.equal(pathPartial("@README"), "README");
    assert.equal(pathPartial("mail me@example.com"), null);
});

test("dslOpPartial: only matches a << line still typing an op name", () => {
    assert.equal(dslOpPartial("<<RE"), "RE");
    assert.equal(dslOpPartial("<<"), "");
    assert.equal(dslOpPartial("explain this"), null);
    assert.equal(dslOpPartial("<<READ(x):y:READ"), null);
});

test("completeOps: case-insensitive, returns <<OP tokens", () => {
    const [hits, partial] = completeOps("re");
    assert.deepEqual(hits, ["<<READ"]);
    assert.equal(partial, "<<re");
    assert.equal(completeOps("")[0].length, 11);
});

test("pathPartial: DSL target path inside <<OP(...), scheme stripped", () => {
    assert.equal(pathPartial("<<READ(src/fo"), "src/fo");
    assert.equal(pathPartial("<<READ(file://src/fo"), "src/fo");
    assert.equal(pathPartial("<<EDIT[tag](docs/re"), "docs/re");
    assert.equal(pathPartial("<<READ(src/foo.ts):x:READ"), null);
});
