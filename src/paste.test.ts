// Unit tests for the bracketed-paste filter — the parsing state machine that
// must survive markers split across reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import PasteFilter from "./paste.ts";

const START = "\x1b[200~";
const END = "\x1b[201~";

test("PasteFilter: normal typing passes through untouched", () => {
    const f = new PasteFilter();
    assert.equal(f.feed("hello"), "hello");
    assert.equal(f.feed(" world\r"), " world\r");
});

test("PasteFilter: single-line paste passes through verbatim (no marker)", () => {
    const f = new PasteFilter();
    const out = f.feed(`${START}just one line${END}`);
    assert.equal(out, "just one line");
    assert.equal(f.expand(out), "just one line");
});

test("PasteFilter: multi-line paste collapses to a one-line marker", () => {
    const f = new PasteFilter();
    const out = f.feed(`${START}line one\nline two\nline three${END}`);
    assert.match(out, /^\[paste #1 \+3 lines\]$/);
    assert.ok(!out.includes("\n"), "marker is a single line");
    assert.equal(f.expand(out), "line one\nline two\nline three");
});

test("PasteFilter: text around a paste is preserved in order", () => {
    const f = new PasteFilter();
    const out = f.feed(`fix this:${START}a\nb${END} please`);
    assert.equal(out, "fix this:[paste #1 +2 lines] please");
    assert.equal(f.expand(out), "fix this:a\nb please");
});

test("PasteFilter: marker split across two reads still parses", () => {
    const f = new PasteFilter();
    // START split mid-sequence.
    let out = f.feed("ab\x1b[20");
    out += f.feed("0~x\ny");
    out += f.feed(`z${END}`);
    assert.equal(out, "ab[paste #1 +2 lines]");
    assert.equal(f.expand(out), "abx\nyz", "leading literal text stays, marker expands");
});

test("PasteFilter: END split across reads, paste content accumulates", () => {
    const f = new PasteFilter();
    let out = f.feed(`${START}one\ntwo`);
    assert.equal(out, "", "nothing emitted until the paste closes");
    out += f.feed("\x1b[201");
    out += f.feed("~tail");
    assert.equal(out, "[paste #1 +2 lines]tail");
    assert.equal(f.expand(out), "one\ntwotail", "marker expands; trailing literal text stays");
});

test("PasteFilter: CRLF and lone CR normalize to LF", () => {
    const f = new PasteFilter();
    const out = f.feed(`${START}a\r\nb\rc${END}`);
    assert.match(out, /\+3 lines/);
    assert.equal(f.expand(out), "a\nb\nc");
});

test("PasteFilter: two pastes get distinct ids, both expand", () => {
    const f = new PasteFilter();
    const a = f.feed(`${START}x\ny${END}`);
    const b = f.feed(`${START}p\nq${END}`);
    assert.equal(a, "[paste #1 +2 lines]");
    assert.equal(b, "[paste #2 +2 lines]");
    assert.equal(f.expand(`${a} and ${b}`), "x\ny and p\nq");
});

test("PasteFilter: expand leaves unknown/edited markers literal", () => {
    const f = new PasteFilter();
    assert.equal(f.expand("[paste #99 +5 lines]"), "[paste #99 +5 lines]");
});

test("PasteFilter: a marker is consumed once (expand is destructive)", () => {
    const f = new PasteFilter();
    const out = f.feed(`${START}a\nb${END}`);
    assert.equal(f.expand(out), "a\nb");
    assert.equal(f.expand(out), out, "second expand finds nothing stored");
});

test("PasteFilter: stash multi-line content (/import) → marker, expands back", () => {
    const f = new PasteFilter();
    const marker = f.stash("a\nb\nc");
    assert.match(marker, /^\[paste #1 \+3 lines\]$/);
    assert.equal(f.expand(marker), "a\nb\nc");
});

test("PasteFilter: stash single-line content → verbatim (no marker)", () => {
    const f = new PasteFilter();
    assert.equal(f.stash("one line"), "one line");
});
