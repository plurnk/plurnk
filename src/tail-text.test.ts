import assert from "node:assert/strict";
import test from "node:test";
import TailText from "./tail-text.ts";

test("TailText renders nothing when empty and everything under its cap", () => {
    const tail = new TailText(() => 4);
    assert.deepEqual(tail.render(40), []);
    tail.setText("one\ntwo\nthree");
    assert.deepEqual(tail.render(40), ["one", "two", "three"]);
});

test("TailText keeps only the newest lines once the text outgrows the cap", () => {
    const tail = new TailText(() => 3);
    tail.setText(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));
    assert.deepEqual(tail.render(40), ["line 8", "line 9", "line 10"]);
    tail.setText(Array.from({ length: 11 }, (_, index) => `line ${index + 1}`).join("\n"));
    assert.deepEqual(tail.render(40), ["line 9", "line 10", "line 11"], "it overwrites itself as the text grows");
});

test("TailText wraps to the viewport width before it counts lines", () => {
    const tail = new TailText(() => 2);
    tail.setText("alpha beta gamma delta");
    assert.deepEqual(tail.render(6), ["gamma", "delta"], "the newest wrapped segments are the lines shown");
});

test("TailText re-reads its cap every render, so a resized terminal changes the region", () => {
    let rows = 2;
    const tail = new TailText(() => rows);
    tail.setText("a\nb\nc\nd");
    assert.deepEqual(tail.render(40), ["c", "d"]);
    rows = 3;
    assert.deepEqual(tail.render(40), ["b", "c", "d"]);
});
