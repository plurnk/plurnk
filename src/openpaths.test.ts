import { test } from "node:test";
import assert from "node:assert/strict";
import { extractOpenPaths } from "./openpaths.ts";

test("extractOpenPaths: a single @ref → the path", () => {
    assert.deepEqual(extractOpenPaths("explain @src/foo.ts please"), ["src/foo.ts"]);
});

test("extractOpenPaths: multiple refs, deduped, order preserved", () => {
    assert.deepEqual(extractOpenPaths("@a.ts and @b.ts and @a.ts again"), ["a.ts", "b.ts"]);
});

test("extractOpenPaths: @ at line start counts", () => {
    assert.deepEqual(extractOpenPaths("@README.md what is this"), ["README.md"]);
});

test("extractOpenPaths: trailing sentence punctuation is trimmed", () => {
    assert.deepEqual(extractOpenPaths("see @docs/x.md."), ["docs/x.md"]);
    assert.deepEqual(extractOpenPaths("compare @a.ts, @b.ts;"), ["a.ts", "b.ts"]);
});

test("extractOpenPaths: an email's @ is NOT a ref (must start a token)", () => {
    assert.deepEqual(extractOpenPaths("mail user@example.com about it"), []);
});

test("extractOpenPaths: no refs → empty", () => {
    assert.deepEqual(extractOpenPaths("just a plain prompt"), []);
});
