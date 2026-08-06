import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("release publication preserves canonical source, dependency order, and exact composition", async () => {
    const release = await readFile(new URL("../scripts/release-publish.mjs", import.meta.url), "utf8");
    const canonical = release.indexOf("await assertCanonicalSource({ allowPrepared: !targetServed })");
    const checkBoundary = release.indexOf("if (checkOnly)");
    const platformGate = release.indexOf("for (const name of [SERVICE_PACKAGE, CONTRACTS_PACKAGE])");
    const lock = release.indexOf('"update", "--package-lock-only"');
    const cleanInstall = release.indexOf('["ci", "--prefer-online"');
    const freshness = release.indexOf('["run", "deps:fresh"]');
    const porcelain = release.indexOf('stdout.split(/\\r?\\n/).filter(Boolean)');
    const commit = release.indexOf('["commit", "-S"');
    const push = release.indexOf('["push", "origin", "main"]');
    const publish = release.indexOf('["publish", "--access", "public"]');

    assert.ok(canonical >= 0 && canonical < checkBoundary && checkBoundary < platformGate);
    assert.ok(platformGate < lock && lock < cleanInstall && cleanInstall < freshness && freshness < commit);
    assert.ok(porcelain < commit);
    assert.ok(commit < push && push < publish);
    assert.match(release, /assertCanonicalSource\(\{ allowPrepared: !targetServed \}\)/);
    assert.match(release, /if \(dirty\.length > 0\)/);
    assert.doesNotMatch(release, /status", "--porcelain"\]\)\)\.stdout\.trim/);
    assert.match(release, /PLURNK_COMPOSITION_SERVICE: `\$\{SERVICE_PACKAGE\}@\$\{platformVersion\}`/);
    assert.doesNotMatch(release, /@latest/);
});
