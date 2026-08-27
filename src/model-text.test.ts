import test from "node:test";
import assert from "node:assert/strict";
import ModelText from "./model-text.ts";

test("ModelText.plain strips every terminal-significant sequence a model could author", () => {
    assert.equal(ModelText.plain("a\x1b[31mred\x1b[0m b"), "ared b", "CSI SGR");
    assert.equal(ModelText.plain("x\x1b]52;c;aGVsbG8=\x07y"), "xy", "OSC 52 clipboard write, BEL-terminated");
    assert.equal(ModelText.plain("x\x1b]52;c;aGVsbG8=\x1b\\y"), "xy", "OSC 52, ST-terminated");
    assert.equal(ModelText.plain("see \x1b]8;;https://evil.test\x07docs\x1b]8;;\x07"), "see docs", "OSC 8 link");
    assert.equal(ModelText.plain("t\x1bPq#0;2;0;0;0\x1b\\u"), "tu", "DCS payload");
    assert.equal(ModelText.plain("t\x1b_G a=T\x1b\\u"), "tu", "APC payload (kitty graphics)");
    assert.equal(ModelText.plain("a\x1bcb"), "ab", "two-character escape (RIS)");
    assert.equal(ModelText.plain("a\x1b"), "a", "a lone trailing ESC");
    assert.equal(ModelText.plain("one\rtwo"), "onetwo", "carriage-return overwrite");
    assert.equal(ModelText.plain("a\x9b31mb"), "ab", "C1 CSI byte");
    assert.equal(ModelText.plain("bell\x07 del\x7f"), "bell del", "BEL and DEL");
});

test("ModelText.plain keeps text, newlines, tabs, and non-ASCII exactly", () => {
    const text = "line one\n\tindented — 日本語 🎉 «quotes» `code`";
    assert.equal(ModelText.plain(text), text);
});

test("ModelText.plainFields sanitizes only the string-valued fields", () => {
    const problem = { status: 400, detail: "bad \x1b[2mline\x1b[0m", recovery: null, retryable: false };
    assert.deepEqual(ModelText.plainFields(problem), { status: 400, detail: "bad line", recovery: null, retryable: false });
});
