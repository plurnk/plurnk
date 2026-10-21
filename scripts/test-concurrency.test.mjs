import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { testConcurrency } from "./test-concurrency.mjs";

const GiB = 2 ** 30;

test("the fixture tiers' concurrency is the host's cores, bounded by the fixture files its available memory holds", () => {
    assert.equal(testConcurrency(24, 64 * GiB), 24, "cores bound a host with memory to spare");
    assert.equal(testConcurrency(24, 5 * GiB), 8, "memory bounds a host with cores to spare");
    assert.equal(testConcurrency(8, 0), 1, "a host always runs one");
});

test("the integration and TUI tiers take the host's concurrency, never a fixed one", async () => {
    const { scripts } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    for (const tier of ["test:intg", "test:tui"]) {
        assert.match(scripts[tier], /--test-concurrency=\$\(node scripts\/test-concurrency\.mjs\)/u, tier);
        assert.doesNotMatch(scripts[tier], /--test-concurrency=\d/u, tier);
    }
});
