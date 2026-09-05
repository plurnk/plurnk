import test from "node:test";
import assert from "node:assert/strict";
import { renderWorkerTopology, workerNameFromTarget, type WorkerRow } from "./workers.ts";

test("[§cli-workers-topology] worker:// references name workers; worker file paths name none", () => {
    assert.equal(workerNameFromTarget("worker://recheck"), "recheck");
    assert.equal(workerNameFromTarget("worker://guesser1"), "guesser1");
    assert.equal(workerNameFromTarget("worker://~/plan.md"), null);
    assert.equal(workerNameFromTarget("worker:///notes.md"), null);
    assert.equal(workerNameFromTarget("worker://recheck/report.md"), null);
    assert.equal(workerNameFromTarget("file:///src/a.ts"), null);
});

const at = (n: number): string => `2026-09-04T10:0${n}:00Z`;
const forest: WorkerRow[] = [
    { id: 5, name: "plurnk", created_at: at(0), origin: "_plurnk", parentWorkerId: null },
    { id: 6, name: "client-1", created_at: at(0), origin: "client", parentWorkerId: null },
    { id: 1, name: "main", created_at: at(1), origin: "model", parentWorkerId: null },
    { id: 2, name: "main-fork", created_at: at(2), origin: "model", parentWorkerId: 1 },
    { id: 4, name: "guesser1", created_at: at(3), origin: "model", parentWorkerId: 1 },
    { id: 3, name: "recheck", created_at: at(4), origin: "model", parentWorkerId: 2 },
];

test("[§cli-workers-topology] the bound worker's tree renders first, marked, with its descendants as a tree", () => {
    const lines = renderWorkerTopology(forest, "main").trimEnd().split("\n");
    assert.match(lines[0], /^ {2}● main +model +2026-09-04T10:01:00Z {2}← bound$/u);
    assert.match(lines[1], /^ {2}├─ ○ main-fork +model/u);
    assert.match(lines[2], /^ {2}│ {2}└─ ○ recheck +model/u);
    assert.match(lines[3], /^ {2}└─ ○ guesser1 +model/u);
    assert.match(lines[4], /^ {2}○ plurnk +_plurnk/u);
    assert.match(lines[5], /^ {2}○ client-1 +client/u);
    assert.equal(lines.length, 6);
});

test("[§cli-workers-topology] a bound descendant still puts its whole tree first and marks only itself", () => {
    const out = renderWorkerTopology(forest, "recheck");
    assert.match(out, /^ {2}○ main /u, "the tree root stays a root");
    assert.match(out, /│ {2}└─ ● recheck .*← bound/u);
    assert.equal(out.match(/●/gu)?.length, 1);
});

test("[§cli-workers-topology] an unknown parent makes the worker a root; an unknown bound name marks nothing", () => {
    const orphan: WorkerRow[] = [{ id: 9, name: "stray", created_at: at(5), origin: "model", parentWorkerId: 404 }];
    const out = renderWorkerTopology(orphan, "elsewhere");
    assert.equal(out, `  ○ stray  model    ${at(5)}\n`);
});

test("[§cli-workers-topology] no workers renders one honest line", () => {
    assert.equal(renderWorkerTopology([], "main"), "  (no workers)\n");
});
