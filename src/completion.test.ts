// Unit tests for client-local path completion.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pathPartial, completePath, dslOpPartial, completeOps, dslStatement } from "./completion.ts";

test("pathPartial: members and compose verbs expose their path arg", () => {
    assert.equal(pathPartial("/members discover src/comp"), "src/comp");
    assert.equal(pathPartial("/members add docs docs/"), "docs/");
    assert.equal(pathPartial("/members add vendor packages/ap"), "packages/ap");
    assert.equal(pathPartial("/import src/fo"), "src/fo");
    assert.equal(pathPartial("/script flows/build.pl"), "flows/build.pl");
    assert.equal(pathPartial("/mcp add gitea gitea-mcp config/git"), "config/git");
});

test("pathPartial: non-path contexts → null", () => {
    assert.equal(pathPartial("/mo"), null);          // verb completion, not a path
    assert.equal(pathPartial("/model gemma"), null); // alias, not a path
    assert.equal(pathPartial("explain this"), null); // a prompt
    assert.equal(pathPartial("/members"), null);     // no space yet → still verb completion
    assert.equal(pathPartial("/members enable docs"), null); // an alias, not a path
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

test("dslOpPartial: retains the opening fence width without delimiter suffixes", () => {
    assert.deepEqual(dslOpPartial("```PL"), { fence: "```", typed: "PL" });
    assert.deepEqual(dslOpPartial("````RE"), { fence: "````", typed: "RE" });
    assert.deepEqual(dslOpPartial("```"), { fence: "```", typed: "" });
    assert.equal(dslOpPartial("explain this"), null);
    assert.equal(dslOpPartial("```READ (x)"), null);
    assert.equal(dslOpPartial("## PL"), null);
});

test("completeOps: completes native names and retains a longer opening fence", () => {
    assert.deepEqual(completeOps({ fence: "```", typed: "ta" }), [["```TASK"], "```ta"]);
    assert.deepEqual(completeOps({ fence: "```", typed: "pl" }), [[], "```pl"]);
    assert.deepEqual(completeOps({ fence: "````", typed: "re" }), [["````READ"], "````re"]);
    assert.deepEqual(completeOps({ fence: "```", typed: "ba" })[0], ["```BARE"]);
    assert.deepEqual(completeOps({ fence: "```", typed: "" })[0], ["FIND", "READ", "EDIT", "COPY", "MOVE", "SEND", "EXEC", "BARE", "WORK", "FORK", "KILL", "TASK", "LOOK"].map((op) => `\`\`\`${op}`));
});

test("completeOps: LOOK completes alongside daemon operations", () => {
    assert.deepEqual(completeOps({ fence: "```", typed: "lo" })[0], ["```LOOK"]);
});

test("pathPartial: native and executor fence targets, scheme stripped", () => {
    assert.equal(pathPartial("```READ (src/fo"), "src/fo");
    assert.equal(pathPartial("````READ(file://src/fo"), "src/fo");
    assert.equal(pathPartial("```node (docs/re"), "docs/re");
    assert.equal(pathPartial("```READ (src/foo.ts)"), null);
});

test("dslStatement: sends named fences verbatim; the daemon owns registration and syntax validation", () => {
    for (const text of ["```TASK\n[]\n```", "```EDIT (a.md)\nbody\n```", "```BARE\nWhat is the capital of Germany?\n```", "````LOOK (a.md)````", "```sh\necho hi\n```", "```gitea (issue_list)\n{}\n```", "```unregistered (bad"])
        assert.equal(dslStatement(text), text);
    for (const text of ["## PLAN_", "### Results", "plain prompt", "```\nquoted code\n```", ": ```sh\necho hi\n```", "``READ (a)"])
        assert.equal(dslStatement(text), null);
});
