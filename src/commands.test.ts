import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PLURNK_FENCE } from "@plurnk/plurnk-contracts";
import {
    COMMANDS,
    commandSpec,
    completeCommandSyntax,
    isCommandName,
    renderCommandHelp,
} from "./commands.ts";

test("{§operation-fences} language help uses the published contract's delimiter", () => {
    const language = renderCommandHelp().split("\n").find((line) => line.startsWith("  language"));
    assert.ok(language);
    const fences = [...language.matchAll(/(`+)[A-Z]+/gu)].map((match) => match[1]);
    assert.ok(fences.length > 0, "language help presents executable fence examples");
    assert.deepEqual([...new Set(fences)], [PLURNK_FENCE]);
});

test("[§cli-interactive-command-discovery] the registry is unique and every command is recognized", () => {
    const names = COMMANDS.map(({ name }) => name);
    assert.equal(new Set(names).size, names.length);
    assert.equal(names.every(isCommandName), true);
    assert.equal(names.includes("skills"), true);
    assert.equal(names.includes("a2a"), true);
    assert.equal(names.includes("members"), true);
    assert.equal(names.includes("env"), true);
    assert.equal(names.includes("schedule"), true);
});

test("root, contextual help, and Functionality syntax share the registry", () => {
    const root = completeCommandSyntax("/");
    assert.equal(root?.kind, "syntax");
    if (root?.kind !== "syntax") return;
    assert.deepEqual(root.suggestions.map(({ value }) => value), COMMANDS.map(({ name }) => `/${name}`));

    const help = renderCommandHelp("mcp");
    assert.match(help, /^  \/mcp \[subcommand\]/u);
    for (const subcommand of commandSpec("mcp")?.subcommands ?? []) {
        assert.match(help, new RegExp(`/mcp ${subcommand.name}\\b`, "u"));
    }
});

test("{§cli-reasoning-policy} /effort is the reasoning-selection command in help and completion", () => {
    assert.equal(isCommandName("effort"), true);
    assert.equal(isCommandName("reasoning"), false);
    assert.match(renderCommandHelp("effort"), /\/effort \[policy\]/u);
    assert.doesNotMatch(renderCommandHelp(), /\/reasoning\b/u);
    const completion = completeCommandSyntax("/ef");
    assert.equal(completion?.kind, "syntax");
    if (completion?.kind !== "syntax") return;
    assert.deepEqual(completion.suggestions.map(({ value }) => value), ["/effort"]);
});

test("Functionality completion identifies only alias-taking positions", () => {
    assert.deepEqual(completeCommandSyntax("/a2a en"), {
        kind: "syntax",
        prefix: "en",
        suggestions: [{ value: "enable", description: "Enable a current alias." }],
    });
    assert.deepEqual(completeCommandSyntax("/a2a enable res"), {
        kind: "aliases",
        family: "a2a",
        prefix: "res",
    });
    assert.equal(completeCommandSyntax("/a2a add res"), null);
});

test("[§cli-interactive-command-discovery] help and reference inventories contain every interactive verb", async () => {
    const [spec, generator] = await Promise.all([
        readFile(new URL("../SPEC.md", import.meta.url), "utf8"),
        readFile(new URL("../scripts/generate-posix.mjs", import.meta.url), "utf8"),
    ]);
    const help = renderCommandHelp();
    for (const { name } of COMMANDS) {
        assert.match(help, new RegExp(`/${name}\\b`, "u"), `/help omits /${name}`);
        assert.match(spec, new RegExp(`/${name}\\b`, "u"), `SPEC omits /${name}`);
    }
    assert.match(generator, /renderCommandReference\(\)/u, "the generated man page does not derive interactive commands from the registry");
});
