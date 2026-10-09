import { test } from "node:test";
import assert from "node:assert/strict";
import { execCommand, parsePrompt } from "./policy.ts";

test("[§cli-prompt-prefixes] only '?' requests local review; prompts carry no authority", () => {
    for (const [input, prompt, reviewRequested] of [
        ["? explain this", "explain this", true],
        [": change this", "change this", false],
        ["change this", "change this", false],
        ["... additional context", "additional context", false],
        ["?what is truth", "what is truth", true],
    ] as const) {
        assert.deepEqual(parsePrompt(input), { prompt, reviewRequested });
    }
});

test("[§cli-prompt-prefixes] a '!' prompt is the shell command after its leading '!'s and whitespace", () => {
    for (const [input, command] of [
        ["! echo hi", "echo hi"],
        ["!ls -la", "ls -la"],
        ["!! make test", "make test"],
        ["  ! echo indented", "echo indented"],
        ["! printf 'a\\n'\n\nmore", "printf 'a\\n'\n\nmore"],
        ["!", ""],
        ["!!  ", ""],
        ["echo !", null],
        ["? ! not a command", null],
        [": ! not a command", null],
        ["", null],
    ] as const) {
        assert.equal(execCommand(input), command, JSON.stringify(input));
    }
});
