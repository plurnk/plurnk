import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrompt } from "./policy.ts";

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
