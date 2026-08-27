import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
    COMMANDS,
    commandSpec,
    completeCommandSyntax,
    isCommandName,
    renderCommandHelp,
} from "./commands.ts";

test("[§cli-interactive-command-discovery] the registry is unique and every command is recognized", () => {
    const names = COMMANDS.map(({ name }) => name);
    assert.equal(new Set(names).size, names.length);
    assert.equal(names.every(isCommandName), true);
    assert.equal(names.includes("skills"), true);
    assert.equal(names.includes("agents"), true);
    assert.equal(names.includes("members"), true);
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

test("Functionality completion identifies only alias-taking positions", () => {
    assert.deepEqual(completeCommandSyntax("/agents en"), {
        kind: "syntax",
        prefix: "en",
        suggestions: [{ value: "enable", description: "Enable a current alias." }],
    });
    assert.deepEqual(completeCommandSyntax("/agents enable res"), {
        kind: "aliases",
        family: "agents",
        prefix: "res",
    });
    assert.equal(completeCommandSyntax("/agents add res"), null);
});

test("public command inventories contain every interactive verb", async () => {
    const [readme, spec, generator] = await Promise.all([
        readFile(new URL("../README.md", import.meta.url), "utf8"),
        readFile(new URL("../SPEC.md", import.meta.url), "utf8"),
        readFile(new URL("../scripts/generate-posix.mjs", import.meta.url), "utf8"),
    ]);
    for (const { name } of COMMANDS) {
        assert.match(readme, new RegExp(`/${name}\\b`, "u"), `README omits /${name}`);
        assert.match(spec, new RegExp(`/${name}\\b`, "u"), `SPEC omits /${name}`);
    }
    assert.match(generator, /renderCommandReference\(\)/u, "the generated man page does not derive interactive commands from the registry");
});
