import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkPosix } from "./check-posix.mjs";

const root = resolve(import.meta.dirname, "..");
const bash = resolve(root, "completions/plurnk.bash");
const checks = checkPosix();

for (const result of checks) {
    test(`[§cli-posix-artifacts] generated artifacts pass ${result.command}`, {
        skip: result.missing ? `${result.command} is not installed; npm run test:posix requires every checker` : false,
    }, () => {
        assert.equal(result.status, 0, result.output);
    });
}

test("[§cli-posix-artifacts] the explicit native check fails if checkers are unavailable", () => {
    const result = spawnSync(process.execPath, [resolve(root, "scripts/check-posix.mjs")], {
        env: { ...process.env, PATH: "" }, encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    for (const { command } of checks) assert.ok(result.stdout.includes(`${command}: missing executable`));
});

test("[§cli-posix-artifacts] bash completion preserves spaces and glob characters in filenames", {
    skip: checks.find(({ command }) => command === "bash").missing ? "bash is not installed" : false,
}, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "plurnk-completion-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const files = ["alpha beta", "alpha[x]", "alpha*star", "alpha\\slash"];
    await Promise.all(files.map((file) => writeFile(join(directory, file), "")));
    const complete = (words) => {
        const program = [
            'source "$1"',
            "shift",
            'COMP_WORDS=("$@")',
            "COMP_CWORD=$(($# - 1))",
            "_plurnk",
            'if (( ${#COMPREPLY[@]} )); then printf "%s\\0" "${COMPREPLY[@]}"; fi',
        ].join("\n");
        const result = execFileSync("bash", ["--noprofile", "--norc", "-c", program, "completion-test", bash, ...words], { cwd: directory, encoding: "utf8" });
        return result.split("\0").filter(Boolean).sort();
    };
    assert.deepEqual(complete(["plurnk", "script", "alpha"]), [...files].sort());
    assert.deepEqual(complete(["plurnk", "alpha"]), [...files].sort());
    assert.deepEqual(complete(["plurnk", "script", "alpha b"]), ["alpha beta"]);
    assert.deepEqual(complete(["plurnk", "script", "absent"]), []);
    assert.deepEqual(complete(["plurnk", "--work"]), ["--worker", "--workspace"]);
    assert.deepEqual(complete(["plurnk", "mod"]), ["models"]);
});
