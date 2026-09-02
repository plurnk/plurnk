import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PlurnkParser } from "@plurnk/plurnk-contracts";
import { COMMANDS } from "./commands.ts";
import { USAGE } from "./dispatcher.ts";

test("[§cli-tui-mode] the public README's model-turn specimens parse under the installed contract", async () => {
    const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
    const specimens = [...readme.matchAll(/```\n(# PLAN0[\s\S]*?)\n```/gu)].map((match) => match[1]);
    assert.equal(specimens.length, 2, "README must show the action and completion turns separately");
    for (const specimen of specimens) {
        assert.doesNotMatch(specimen, /"entries"\s*:/u, "README teaches the retired PLAN wrapper");
    }
    assert.deepEqual(
        specimens.map((specimen) => PlurnkParser.parse(specimen).items
            .map((item) => item.kind === "statement" ? item.statement.op : item.kind)),
        [["PLAN", "EDIT", "SEND"], ["PLAN", "SEND"]],
    );
});

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

test("[§cli-interactive-command-discovery] generated and public surfaces retain the complete command inventory", async () => {
    const [readme, man] = await Promise.all([
        readFile(new URL("../README.md", import.meta.url), "utf8"),
        readFile(new URL("../man/plurnk.1", import.meta.url), "utf8"),
    ]);
    assert.match(readme, /scrollback-native interactive terminal/u);
    assert.match(man, /\.SH INTERACTIVE COMMANDS/u);
    for (const { name } of COMMANDS) {
        assert.match(readme, new RegExp(`/${name}\\b`, "u"));
        assert.match(man, new RegExp(`/${name}\\b`, "u"));
    }
});
