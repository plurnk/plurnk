// Unit tests for src/dispatcher.ts helpers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveProjectRoot, resolvePersona, resolveLoopFlags } from "./dispatcher.ts";

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

// ─── resolvePersona ──────────────────────────────────────────────────

test("resolvePersona: undefined → undefined (no override)", async () => {
    assert.equal(await resolvePersona(undefined), undefined);
});

test("resolvePersona: absolute path → reads file contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-test-persona-"));
    try {
        const path = join(dir, "p.md");
        await writeFile(path, "# Persona\n\nBe terse.", "utf8");
        const result = await resolvePersona(path);
        assert.equal(result, "# Persona\n\nBe terse.");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("resolvePersona: relative path → resolved from cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-test-persona-"));
    const original = process.cwd();
    try {
        const name = "p.md";
        await writeFile(join(dir, name), "from relative", "utf8");
        process.chdir(dir);
        const result = await resolvePersona(name);
        assert.equal(result, "from relative");
    } finally {
        process.chdir(original);
        await rm(dir, { recursive: true, force: true });
    }
});

test("resolvePersona: missing file → throws (ENOENT propagates)", async () => {
    await assert.rejects(
        resolvePersona("/nonexistent/persona.md"),
        /ENOENT/,
    );
});
