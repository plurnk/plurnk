import test from "node:test";
import assert from "node:assert/strict";
import { bootDiagnosis } from "./harness.ts";

// A source entrypoint loads its workspace siblings through their `dist`, so an unbuilt sibling
// boots a daemon made of two services — and it dies in the wrong vocabulary. The harness names
// the likely cause on the boot failure instead of refusing beforehand (plurnk/plurnk#92).
test("a boot failure that smells of a stale sibling build says so", () => {
    // The one that actually happened: a build from before the content store landed.
    const real = "start: open /tmp/x/plurnk.db failed\n  cause: cannot create AFTER trigger on view: entry_channels";
    assert.match(bootDiagnosis("", real), /stale sibling build/);
    assert.match(bootDiagnosis("", real), /npm run build/);
    // The two shapes an unbuilt or half-built package produces instead.
    assert.match(bootDiagnosis("", "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@plurnk/plurnk-parser'"), /stale sibling build/);
    assert.match(bootDiagnosis("", "SyntaxError: The requested module './types.js' does not provide an export named 'PLURNK_FENCE'"), /stale sibling build/);
    // Either stream carries it.
    assert.match(bootDiagnosis(real, ""), /stale sibling build/);
});

test("an ordinary boot failure gets no misleading hint", () => {
    assert.equal(bootDiagnosis("", "Error: listen EADDRINUSE: address already in use 127.0.0.1:7777"), "");
    assert.equal(bootDiagnosis("", "PLURNK_SERVICE_DB_PATH is not writable"), "");
    assert.equal(bootDiagnosis("", ""), "");
});
