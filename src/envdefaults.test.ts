// [§cli-env-defaults] The client's self-serve floor (plurnk#141, ecosystem standard):
// the packaged .env.defaults loads SET-IF-UNSET beneath the operator's env — the file
// IS the documentation, one owner per key (PLURNK_CLIENT_*), and a knob the operator
// set is NEVER overridden. The client is the one member the daemon cannot assemble.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDefaults, applyFloor, DEFAULTS_PATH } from "./envdefaults.ts";
import { readFile } from "node:fs/promises";

test("parseDefaults: KEY=VALUE lines parse; comments and blanks skip; commented knobs are DOCS, not values", () => {
    const out = parseDefaults("# doc line\nPLURNK_CLIENT_YOLO=0\n\n# PLURNK_CLIENT_WORKER=\nPLURNK_CLIENT_JSON=0\n");
    assert.deepEqual(out, { PLURNK_CLIENT_YOLO: "0", PLURNK_CLIENT_JSON: "0" });
});

test("applyFloor: sets only UNSET keys — the operator's env always wins", () => {
    const env: Record<string, string | undefined> = { PLURNK_CLIENT_YOLO: "1" };
    applyFloor({ PLURNK_CLIENT_YOLO: "0", PLURNK_CLIENT_JSON: "0" }, env);
    assert.equal(env.PLURNK_CLIENT_YOLO, "1", "set key untouched");
    assert.equal(env.PLURNK_CLIENT_JSON, "0", "unset key floored");
});

test("the shipped file exists, declares ONLY the PLURNK_CLIENT_* prefix, and every uncommented key is ours", async () => {
    const text = await readFile(DEFAULTS_PATH, "utf8");
    for (const [key] of Object.entries(parseDefaults(text))) {
        assert.match(key, /^PLURNK_CLIENT_/, `one owner per key — '${key}' is not ours to default`);
    }
});

test("[§cli-yolo-plurnkyolo] the packaged default enables YOLO without overriding explicit review", async () => {
    const defaults = parseDefaults(await readFile(DEFAULTS_PATH, "utf8"));
    const fresh: Record<string, string> = {};
    applyFloor(defaults, fresh);
    assert.equal(fresh.PLURNK_CLIENT_YOLO, "1");
    const review = { PLURNK_CLIENT_YOLO: "0" };
    applyFloor(defaults, review);
    assert.equal(review.PLURNK_CLIENT_YOLO, "0");
    for (const file of ["README.md", "SPEC.md"]) {
        const doc = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
        assert.match(doc, new RegExp(`default[^\\n]*PLURNK_CLIENT_YOLO=${defaults.PLURNK_CLIENT_YOLO}`), file);
    }
});
