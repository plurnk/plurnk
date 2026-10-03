import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

test("the push gate does not leak its Git repository into test-created repositories", async () => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-push-gate-"));
    const keys = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR"];
    try {
        await writeFile(join(root, "npm"), `#!${process.execPath}
console.log(JSON.stringify({ args: process.argv.slice(2), inherited: ${JSON.stringify(keys)}.filter((key) => process.env[key] !== undefined) }));
`, { mode: 0o755 });
        const { stdout } = await promisify(execFile)("/bin/sh", [resolve(".githooks/pre-push")], {
            env: { ...process.env, PATH: `${root}:${process.env.PATH}`, ...Object.fromEntries(keys.map((key) => [key, "foreign-repository"])) },
        });
        assert.deepEqual(stdout.trim().split("\n").map((line) => JSON.parse(line)), [
            { args: ["run", "build", "--silent"], inherited: [] },
            { args: ["test"], inherited: [] },
        ]);
    } finally { await rm(root, { recursive: true, force: true }); }
});
