import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSkills } from "./skills.ts";

const harness = () => {
    const out: string[] = [];
    return { write: (text: string) => out.push(text), out };
};

test("skills list reads the workspace skills directory", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await (await import("node:fs/promises")).mkdir(join(root, "skills", "grep"), { recursive: true });
    await writeFile(join(root, "skills", "grep", "SKILL.md"), "---\nname: grep\ndescription: Find text\n---\nbody");

    const h = harness();
    await handleSkills([], h.write, root);
    assert.match(h.out.join(""), /grep — Find text/);

    const empty = harness();
    await handleSkills([], empty.write, join(root, "absent"));
    assert.match(empty.out.join(""), /skills: none/);
});

test("skills add writes a complete SKILL.md folder and validates names", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = join(root, "skill.md");
    await writeFile(file, "---\nname: review\ndescription: Check diffs\n---\nReview diffs before committing.");

    const h = harness();
    await handleSkills(["add", "review", file], h.write, root);
    assert.match(h.out.join(""), /added: review/);
    assert.equal(await readFile(join(root, "skills", "review", "SKILL.md"), "utf8"), "---\nname: review\ndescription: Check diffs\n---\nReview diffs before committing.");

    const invalid = harness();
    await assert.rejects(
        () => handleSkills(["add", "../escape", file], invalid.write, root),
        /must match/,
    );
});

test("skills remove deletes one folder and reports missing skills", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await (await import("node:fs/promises")).mkdir(join(root, "skills", "gone"), { recursive: true });
    await writeFile(join(root, "skills", "gone", "SKILL.md"), "---\nname: gone\n---\nbody");

    const h = harness();
    await handleSkills(["remove", "gone"], h.write, root);
    assert.match(h.out.join(""), /removed: gone/);
    await assert.rejects(() => readFile(join(root, "skills", "gone", "SKILL.md")), /ENOENT/);

    const missing = harness();
    await handleSkills(["remove", "absent"], missing.write, root);
    assert.match(missing.out.join(""), /no skill named absent/);
});

test("skills requires a project root", async () => {
    const h = harness();
    await assert.rejects(() => handleSkills([], h.write, null), /project root/);
});

test("skills install copies local skill folders, optionally one named skill", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-skills-"));
    const source = await mkdtemp(join(tmpdir(), "plurnk-skill-source-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    t.after(() => rm(source, { recursive: true, force: true }));
    await (await import("node:fs/promises")).mkdir(join(source, "skills", "grep"), { recursive: true });
    await writeFile(join(source, "skills", "grep", "SKILL.md"), "---\nname: grep\ndescription: Find text\n---\nbody");
    await (await import("node:fs/promises")).mkdir(join(source, "skills", "review"), { recursive: true });
    await writeFile(join(source, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Check diffs\n---\nbody");

    const h = harness();
    await handleSkills(["install", source], h.write, root);
    assert.match(h.out.join(""), /installed: (grep|review), (grep|review)/);

    const one = harness();
    await handleSkills(["install", source, "--skill", "review"], one.write, root);
    assert.match(one.out.join(""), /installed: review/);

    const missing = harness();
    await handleSkills(["install", source, "--skill", "absent"], missing.write, root);
    assert.match(missing.out.join(""), /no skill named absent/);
});
