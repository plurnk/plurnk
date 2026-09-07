import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { COMMANDS } from "./commands.ts";
import { USAGE } from "./dispatcher.ts";

test("[§cli-subcommands] generated POSIX surfaces share the positional command inventory", async () => {
    const [man, bash, zsh, fish] = await Promise.all([
        readFile(new URL("../man/plurnk.1", import.meta.url), "utf8"),
        readFile(new URL("../completions/plurnk.bash", import.meta.url), "utf8"),
        readFile(new URL("../completions/_plurnk", import.meta.url), "utf8"),
        readFile(new URL("../completions/plurnk.fish", import.meta.url), "utf8"),
    ]);
    const subcommands = USAGE.slice(USAGE.indexOf("\nsubcommands:") + 1)
        .split("\n")
        .slice(1)
        .flatMap((line) => /^  ([a-z]+)\b/u.exec(line)?.[1] ?? [])
        .filter((name, index, all) => all.indexOf(name) === index);
    assert.ok(subcommands.length > 0);
    for (const name of subcommands) {
        assert.match(man, new RegExp(`^  ${name}\\b`, "mu"));
        assert.match(bash, new RegExp(`\\b${name}\\b`, "u"));
        assert.match(zsh, new RegExp(`\\b${name}\\b`, "u"));
        assert.match(fish, new RegExp(`-a ${name}\\b`, "u"));
    }
});

test("[§cli-interactive-command-discovery] the generated man page retains the complete command inventory", async () => {
    const man = await readFile(new URL("../man/plurnk.1", import.meta.url), "utf8");
    assert.match(man, /\.SH INTERACTIVE COMMANDS/u);
    for (const { name } of COMMANDS) {
        assert.match(man, new RegExp(`/${name}\\b`, "u"));
    }
});
