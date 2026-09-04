import test from "node:test";
import assert from "node:assert/strict";
import { unreachable } from "./audit-gate.mjs";

test("audit-gate: npm's actual dropped-request text classifies as unreachable (#144)", () => {
    assert.ok(unreachable("npm warn audit network timeout at: https://registry.npmjs.org/-/npm/v1/security/advisories/bulk\nnpm error audit endpoint returned an error"));
});

test("audit-gate: a genuine finding never classifies as unreachable (#144)", () => {
    assert.ok(!unreachable("found 3 vulnerabilities (1 moderate, 2 high)\n  run `npm audit fix` to fix them"));
});
