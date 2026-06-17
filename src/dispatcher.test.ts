// Unit tests for src/dispatcher.ts helpers.

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveProjectRoot, resolveLoopFlags, buildConstraints } from "./dispatcher.ts";

// ─── resolveLoopFlags ────────────────────────────────────────────────
// Mode is NOT a flag: ask/act ride the prompt prefix (`? `/`: `), the
// habit converged across nvim, TUI, and the one-shot CLI.

test("resolveLoopFlags: undefined → undefined", () => {
    assert.equal(resolveLoopFlags(undefined), undefined);
});

test("resolveLoopFlags: JSON passes through verbatim", () => {
    assert.deepEqual(resolveLoopFlags('{"yolo":true,"noWeb":true}'), { yolo: true, noWeb: true });
});

test("resolveLoopFlags: malformed JSON throws", () => {
    assert.throws(() => resolveLoopFlags("{nope"), /valid JSON/);
});

test("resolveLoopFlags: non-object JSON throws", () => {
    assert.throws(() => resolveLoopFlags('["yolo"]'), /JSON object/);
});

// ─── resolveProjectRoot ──────────────────────────────────────────────

test("resolveProjectRoot: undefined → process.cwd()", () => {
    assert.equal(resolveProjectRoot(undefined), process.cwd());
});

test("resolveProjectRoot: empty string → null (explicit headless)", () => {
    assert.equal(resolveProjectRoot(""), null);
});

test("resolveProjectRoot: absolute path → unchanged", () => {
    assert.equal(resolveProjectRoot("/tmp/work"), "/tmp/work");
});

test("resolveProjectRoot: relative path → throws", () => {
    assert.throws(
        () => resolveProjectRoot("./relative"),
        /must be an absolute path/,
    );
});

test("resolveProjectRoot: bare name → throws", () => {
    assert.throws(
        () => resolveProjectRoot("project"),
        /must be an absolute path/,
    );
});


// ─── buildConstraints (membership overlay, svc#200) ──────────────────

test("buildConstraints: maps --pick/--hide/--view to service effects in order", () => {
    const c = buildConstraints({ pick: ["docs/**"], hide: ["*.lock"], view: ["vendor/**", "gen/**"] });
    assert.deepEqual(c, [
        { effect: "pick", glob: "docs/**" },
        { effect: "hide", glob: "*.lock" },
        { effect: "view", glob: "vendor/**" },
        { effect: "view", glob: "gen/**" },
    ]);
});

test("buildConstraints: no flags → empty (no constraints param on session.create)", () => {
    assert.deepEqual(buildConstraints({}), []);
});
