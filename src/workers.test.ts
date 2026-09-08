import test from "node:test";
import assert from "node:assert/strict";
import { renderWorkerTopology, siblingPosition, traverse, workerNameFromTarget, workerPath, type WorkerRow } from "./workers.ts";

test("[§cli-workers-topology] worker:// references name workers; worker file paths name none", () => {
    assert.equal(workerNameFromTarget("worker://recheck"), "recheck");
    assert.equal(workerNameFromTarget("worker://guesser1"), "guesser1");
    assert.equal(workerNameFromTarget("worker://~/plan.md"), null);
    assert.equal(workerNameFromTarget("worker:///notes.md"), null);
    assert.equal(workerNameFromTarget("worker://recheck/report.md"), null);
    assert.equal(workerNameFromTarget("file:///src/a.ts"), null);
});

const at = (n: number): string => `2026-09-04T10:0${n}:00Z`;
const at2 = at;
const forest: WorkerRow[] = [
    { id: 5, name: "plurnk", created_at: at(0), origin: "_plurnk", parentWorkerId: null },
    { id: 6, name: "client-1", created_at: at(0), origin: "client", parentWorkerId: null },
    { id: 1, name: "main", created_at: at(1), origin: "model", parentWorkerId: null },
    { id: 2, name: "main-fork", created_at: at(2), origin: "model", parentWorkerId: 1 },
    { id: 4, name: "guesser1", created_at: at(3), origin: "model", parentWorkerId: 1 },
    { id: 3, name: "recheck", created_at: at(4), origin: "model", parentWorkerId: 2 },
];

test("[§cli-workers-topology] the bound worker's tree renders first, marked, with its descendants as a tree, siblings newest first", () => {
    const lines = renderWorkerTopology(forest, "main").trimEnd().split("\n");
    assert.match(lines[0], /^ {2}● main +model +2026-09-04T10:01:00Z {2}← bound$/u);
    assert.match(lines[1], /^ {2}├─ ○ guesser1 +model/u, "the newest child heads its siblings — the one `l` enters");
    assert.match(lines[2], /^ {2}└─ ○ main-fork +model/u);
    assert.match(lines[3], /^ {2} {3}└─ ○ recheck +model/u);
    assert.match(lines[4], /^ {2}○ client-1 +client/u);
    assert.match(lines[5], /^ {2}○ plurnk +_plurnk/u);
    assert.equal(lines.length, 6);
});

// {§cli-workers-topology} — one hop is a full attach; the map's order is the hop order.
test("[§cli-workers-topology] traversal: h climbs, l enters the newest child, j/k walk siblings and wrap, edges say why", () => {
    const at = (name: string, hop: "parent" | "enter" | "older" | "newer") => traverse(forest, name, hop);
    assert.equal(at("main", "enter").target?.name, "guesser1", "the newest child");
    assert.equal(at("guesser1", "parent").target?.name, "main");
    assert.equal(at("guesser1", "older").target?.name, "main-fork", "j walks to the older sibling");
    assert.equal(at("main-fork", "older").target?.name, "guesser1", "and wraps");
    assert.equal(at("guesser1", "newer").target?.name, "main-fork", "k wraps the other way");
    assert.equal(at("main-fork", "enter").target?.name, "recheck");
    assert.deepEqual(at("recheck", "enter"), { target: null, notice: "no children" });
    assert.deepEqual(at("recheck", "older"), { target: null, notice: "no siblings" });
    assert.deepEqual(at("main", "parent"), { target: null, notice: "at the root: no parent" });
    assert.deepEqual(at("main", "older"), { target: null, notice: "no siblings" }, "scratch workers are not places: a lone conversation has no siblings");
    assert.equal(traverse(forest, null, "enter").target, null, "nothing bound, nowhere to hop");
    const two = [...forest, { id: 7, name: "second", created_at: at2(6), origin: "model" as const, parentWorkerId: null }];
    assert.equal(traverse(two, "main", "older").target?.name, "second", "root conversations are siblings of each other");
    assert.deepEqual(siblingPosition(two, "second"), { index: 1, count: 2 }, "newest first");
    assert.deepEqual(siblingPosition(two, "main"), { index: 2, count: 2 });
    assert.equal(siblingPosition(forest, "recheck"), null, "an only child has no position");
});

test("[§cli-workers-topology] the lineage path marks the bound worker with ~, the prompt prefix's truth", () => {
    assert.equal(workerPath(forest, "main"), "/~main", "a root is still named; ~ marks where the session is");
    assert.equal(workerPath(forest, "main-fork"), "/main/~main-fork");
    assert.equal(workerPath(forest, "recheck"), "/main/main-fork/~recheck", "a child always shows that it is a child");
    assert.equal(workerPath(forest, null), "/~", "unbound: here, unnamed");
    assert.equal(workerPath(forest, "stranger"), "/~stranger", "a name the directory has not learned yet is still where the session is");
});

test("[§cli-workers-topology] a bound descendant still puts its whole tree first and marks only itself", () => {
    const out = renderWorkerTopology(forest, "recheck");
    assert.match(out, /^ {2}○ main /u, "the tree root stays a root");
    assert.match(out, / {3}└─ ● recheck .*← bound/u);
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
