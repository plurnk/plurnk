// The lockstep, ported from plurnk-agui (itself from plurnk-service): every SPEC
// promise is cited by a test, every citation resolves to a SPEC anchor, and every
// §cli-* ref in a code comment resolves to a live anchor. Namespaced {§cli-...} so
// the client's legitimate references to the SERVICE spec's anchors (§machine-processes,
// §13.x, ...) are out of scope — this gate polices OUR contract only.
// Doctrine that CI enforces survives any steward.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const walk = async (dir: string, out: string[] = []): Promise<string[]> => {
    for (const f of await readdir(dir)) {
        const p = join(dir, f);
        if ((await stat(p)).isDirectory()) { if (!/node_modules|\.git/.test(p)) await walk(p, out); }
        else if (/\.ts$/.test(f)) out.push(p);
    }
    return out;
};

test("lockstep: every SPEC promise is cited, every citation resolves, comment refs never rot", async () => {
    const spec = await readFile(join(ROOT, "SPEC.md"), "utf8");
    const anchors = new Set([...spec.matchAll(/\{§(cli-[a-z0-9-]+)\}/g)].map((m) => m[1]!));
    assert.ok(anchors.size > 0, "SPEC carries {§cli-*} anchors");

    const files = [...await walk(join(ROOT, "src")), ...await walk(join(ROOT, "test"))];
    const cited = new Set<string>();
    const commentRefs: Array<{ file: string; ref: string }> = [];
    for (const file of files) {
        const text = await readFile(file, "utf8");
        for (const m of text.matchAll(/\[§(cli-[a-z0-9-]+)\]/g)) cited.add(m[1]!);
        for (const m of text.matchAll(/§(cli-[a-z0-9-]+)/g)) commentRefs.push({ file: file.replace(ROOT + "/", ""), ref: m[1]! });
    }
    const uncited = [...anchors].filter((a) => !cited.has(a)).toSorted();
    assert.deepEqual(uncited, [], `SPEC promises cited by NO test: ${uncited.join(", ")}`);
    const orphanCitations = [...cited].filter((c) => !anchors.has(c)).toSorted();
    assert.deepEqual(orphanCitations, [], `test citations resolving to NO anchor: ${orphanCitations.join(", ")}`);
    const rotted = commentRefs.filter((r) => !anchors.has(r.ref)).map((r) => `${r.file} §${r.ref}`);
    assert.deepEqual(rotted, [], `comment §cli refs resolving to NO anchor:\n${rotted.join("\n")}`);
});
