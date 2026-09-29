// Unit tests for client-local path completion.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pathPartial, completePath, dslOpPartial, completeOps, dslStatement } from "./completion.ts";
import { PLURNK_FENCE } from "@plurnk/plurnk-contracts";

test("pathPartial: members and compose verbs retain their path owners", () => {
    assert.deepEqual(pathPartial("/members discover src/comp"), { kind: "member", partial: "src/comp" });
    assert.deepEqual(pathPartial("/members add docs docs/"), { kind: "member", partial: "docs/" });
    assert.deepEqual(pathPartial("/members add vendor packages/ap"), { kind: "member", partial: "packages/ap" });
    assert.deepEqual(pathPartial("/import src/fo"), { kind: "local", partial: "src/fo" });
    assert.deepEqual(pathPartial("/script flows/build.pl"), { kind: "local", partial: "flows/build.pl" });
    assert.deepEqual(pathPartial("/mcp add gitea gitea-mcp config/git"), { kind: "local", partial: "config/git" });
    assert.deepEqual(pathPartial("/env import ../.env.pl"), { kind: "local", partial: "../.env.pl" });
    assert.deepEqual(pathPartial("/env --scope workspace import ../.env.pl"), { kind: "local", partial: "../.env.pl" });
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
    assert.deepEqual(pathPartial("explain @src/fo"), { kind: "reference", partial: "src/fo" });
    assert.deepEqual(pathPartial("@README"), { kind: "reference", partial: "README" });
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

// {§operation-fences}: completion uses the canonical width even when the typed width is accepted.
test("completeOps: completes native names and widens a narrow opening fence", () => {
    const F = PLURNK_FENCE;
    assert.deepEqual(completeOps({ fence: "```", typed: "no" }), [[`${F}NOTE`], `${F}no`]);
    assert.deepEqual(completeOps({ fence: "```", typed: "pl" }), [[], `${F}pl`]);
    assert.deepEqual(completeOps({ fence: "````", typed: "re" }), [["````READ"], "````re"], "a fence at least the taught width is kept as typed");
    assert.deepEqual(completeOps({ fence: "`````", typed: "re" }), [["`````READ"], "`````re"], "a deliberately wider fence is kept");
    assert.deepEqual(completeOps({ fence: "```", typed: "ba" })[0], [`${F}BARE`]);
    assert.deepEqual(completeOps({ fence: "```", typed: "" })[0], ["FIND", "READ", "EDIT", "COPY", "MOVE", "SEND", "BARE", "WORK", "FORK", "KILL", "NOTE", "WAIT", "LOOK"].map((op) => `${F}${op}`));
});

test("completeOps: LOOK completes alongside daemon operations", () => {
    assert.deepEqual(completeOps({ fence: "```", typed: "lo" })[0], [`${PLURNK_FENCE}LOOK`]);
});

test("pathPartial: native and executor fence targets preserve their URI", () => {
    assert.deepEqual(pathPartial("```READ (src/fo"), { kind: "target", partial: "src/fo" });
    assert.deepEqual(pathPartial("````READ(file:///src/fo"), { kind: "target", partial: "file:///src/fo" });
    assert.deepEqual(pathPartial("```node (docs/re"), { kind: "target", partial: "docs/re" });
    assert.equal(pathPartial("```READ (src/foo.ts)"), null);
});

test("dslStatement: sends named fences verbatim; the daemon owns registration and syntax validation", () => {
    for (const text of ["```NOTE\n```", "```EDIT (a.md)\nbody\n```", "```BARE\nWhat is the capital of Germany?\n```", "````LOOK (a.md)````", "```sh\necho hi\n```", "```gitea (issue_list)\n{}\n```", "```unregistered (bad"])
        assert.equal(dslStatement(text), text);
    for (const text of ["## PLAN_", "### Results", "plain prompt", "```\nquoted code\n```", ": ```sh\necho hi\n```", "``READ (a)"])
        assert.equal(dslStatement(text), null);
});
