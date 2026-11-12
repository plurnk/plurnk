import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CONVENTIONAL_TYPES, validateBranchName, validateCommitMessage } from "./conventional.mjs";

const HOOK_PATH = fileURLToPath(new URL("../.githooks/pre-push", import.meta.url));

test("{§cli-conformance} the push gate does not leak its Git repository into test-created repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-push-gate-"));
    const keys = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR"];
    try {
        await writeFile(join(root, "npm"), `#!${process.execPath}
console.log(JSON.stringify({ args: process.argv.slice(2), inherited: ${JSON.stringify(keys)}.filter((key) => process.env[key] !== undefined) }));
`, { mode: 0o755 });
        const { stdout } = await promisify(execFile)("/bin/sh", [HOOK_PATH], {
            env: { ...process.env, PATH: `${root}:${process.env.PATH}`, ...Object.fromEntries(keys.map((key) => [key, "foreign-repository"])) },
        });
        assert.deepEqual(stdout.trim().split("\n").map((line) => JSON.parse(line)), [
            { args: ["run", "build", "--silent"], inherited: [] },
            { args: ["test"], inherited: [] },
            { args: ["run", "deps:drift", "--silent"], inherited: [] },
        ]);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test("{§cli-conformance} conventional branch and commit-message rules forbid direct commits on main (#235)", () => {
    for (const type of CONVENTIONAL_TYPES) {
        assert.deepEqual(validateBranchName(`${type}/client-hygiene`), [], type);
        assert.deepEqual(validateCommitMessage(`${type}(term): normalize lifecycle (#235)\n`, { branch: `${type}/client-hygiene` }), [], type);
    }
    assert.deepEqual(validateBranchName("main"), []);
    assert.match(validateBranchName("feature/client-hygiene")[0], /main or type\/kebab-slug/);
    assert.match(validateCommitMessage("fix(term): normalize lifecycle (#235)\n", { branch: "main", merging: false })[0], /direct commits on 'main' are forbidden/);
    assert.deepEqual(validateCommitMessage("Merge branch 'fix/client-hygiene' (#235)\n", { branch: "main", merging: true }), []);
    assert.match(validateCommitMessage("fix(term): normalize lifecycle (#235)\n", { branch: "feature/bad-branch" })[0], /main or type\/kebab-slug/);
    assert.match(validateCommitMessage("Update lifecycle\n", { branch: "fix/client-hygiene" })[0], /type\(scope\): summary/);
    assert.match(validateCommitMessage(`fix: ${"x".repeat(100)}\n`, { branch: "fix/client-hygiene" })[0], /exceeds 100 characters/);
    assert.match(validateCommitMessage("fix: lifecycle\n\nExplanation.\n", { branch: "fix/client-hygiene" })[0], /one-liner doctrine/);
});
