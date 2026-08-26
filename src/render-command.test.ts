import test from "node:test";
import assert from "node:assert/strict";

import { renderDocument, resolveRenderWidth } from "./render-command.ts";

test("[§cli-render-filter] renderDocument projects width-bounded plain Unicode", () => {
    const output = renderDocument([
        "| Surface | Use |",
        "| --- | --- |",
        "| Neovim | A deliberately long explanation that must wrap. |",
    ].join("\n"), 42);

    assert.match(output, /┌/);
    assert.match(output, /├/);
    assert.doesNotMatch(output, /\x1b\[/, "the filter never emits terminal control sequences");
    assert.ok(output.split("\n").every((line) => line.length <= 42));
});

test("[§cli-render-filter] render width defaults sanely and rejects invalid coordinates", () => {
    assert.equal(resolveRenderWidth(undefined, 97), 97);
    assert.equal(resolveRenderWidth("41", 97), 41);
    assert.throws(() => resolveRenderWidth("0", 97), /positive integer/);
    assert.throws(() => resolveRenderWidth("wide", 97), /positive integer/);
});
