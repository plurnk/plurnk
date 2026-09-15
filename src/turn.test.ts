import { test } from "node:test";
import assert from "node:assert/strict";
import TurnBuffer from "./turn.ts";
import type { LogEntryWire } from "./render.ts";

const row = (loop: number, turn: number, op = "READ"): LogEntryWire => ({
    id: 1, loop_seq: loop, turn_seq: turn, sequence: 1, op, origin: "model", signal: null, scheme: null, pathname: null,
    hostname: null, fragment: null, lineMarker: null, tx: {}, rx: { status: 200 }, status_rx: 200, tags: [],
});

test("[§cli-plan-rendering] a turn's rows wait for its TASK, which then stands before them", () => {
    const turns = new TurnBuffer();
    assert.deepEqual(turns.admit(row(1, 1), "READ (a)", false), []);
    assert.deepEqual(turns.admit(row(1, 1), "EDIT (a)", false), []);
    assert.deepEqual(turns.admit(row(1, 1, "SEND"), "\nDone.", false), []);
    assert.deepEqual(turns.admit(row(1, 1, "TASK"), "<table>", true), ["<table>", "READ (a)", "EDIT (a)", "\nDone."], "the table, then the rows in authored order: the response ends the turn");
});

test("[§cli-plan-rendering] a turn without a TASK releases its rows when the next turn begins or the loop concludes", () => {
    const turns = new TurnBuffer();
    turns.admit(row(1, 1), "READ (a)", false);
    assert.equal(turns.begins(row(1, 2)), true);
    assert.equal(turns.begins(row(1, 1)), false);
    assert.deepEqual(turns.admit(row(1, 2), "FIND (b)", false), ["READ (a)"], "the previous turn's rows come out first");
    assert.deepEqual(turns.flush(), ["FIND (b)"], "the loop's end releases what is held");
    assert.deepEqual(turns.flush(), []);
});
