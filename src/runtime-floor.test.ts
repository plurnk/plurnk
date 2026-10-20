import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { floorOf, refusal } from "./runtime-floor.ts";

test("[§cli-runtime-floor] a runtime below the declared floor is refused, naming both versions", () => {
    for (const [range, version] of [[">=26", "24.22.0"], [">=26", "25.9.1"], [">=26.1", "26.0.5"], [">=26.1.2", "26.1.1"]]) {
        const message = refusal("plurnk", range, version);
        assert.ok(message !== null, `${version} under ${range} is refused`);
        assert.ok(message.includes(`Node.js ${range.slice(2)} or later`), `${version} under ${range} names the floor`);
        assert.ok(message.includes(`v${version}`), `${version} under ${range} names the runtime`);
    }
});

test("[§cli-runtime-floor] a runtime at or above the floor runs, prereleases included", () => {
    for (const [range, version] of [[">=26", "26.0.0"], [">=26", "26.12.0"], [">=26", "27.0.0-pre"], [">=26.1", "26.1.0"], [">=26.1.2", "26.2.0"]]) {
        assert.equal(refusal("plurnk", range, version), null, `${version} under ${range}`);
    }
});

test("[§cli-runtime-floor] the package declares a floor the check can read", () => {
    const { engines } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { engines: { node: string } };
    assert.doesNotThrow(() => floorOf(engines.node));
    assert.throws(() => floorOf("^26"), /engines\.node must be a ">=" floor/u);
});
