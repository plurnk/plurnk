import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("release publication preserves canonical source, dependency order, and exact composition", async () => {
    const release = await readFile(new URL("../scripts/release-publish.mjs", import.meta.url), "utf8");
    const canonical = release.indexOf("await assertCanonicalSource()");
    const checkBoundary = release.indexOf("if (checkOnly)");
    const platformGate = release.indexOf("for (const name of [SERVICE_PACKAGE, CONTRACTS_PACKAGE])");
    const lock = release.indexOf('"install", "--package-lock-only"');
    const cleanInstall = release.indexOf('["ci", "--prefer-online"');
    const commit = release.indexOf('["commit", "-S"');
    const push = release.indexOf('["push", "origin", "main"]');
    const publish = release.indexOf('["publish", "--access", "public"]');

    assert.ok(canonical >= 0 && canonical < checkBoundary && checkBoundary < platformGate);
    assert.ok(platformGate < lock && lock < cleanInstall && cleanInstall < commit);
    assert.ok(commit < push && push < publish);
    assert.match(release, /PLURNK_COMPOSITION_SERVICE: `\$\{SERVICE_PACKAGE\}@\$\{platformVersion\}`/);
    assert.doesNotMatch(release, /@latest/);
});
