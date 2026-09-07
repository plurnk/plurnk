import test from "node:test";
import assert from "node:assert/strict";
import QuestionForm from "./QuestionForm.ts";

test("multi-field questions collect plain answers without requiring an undisclosed JSON object", () => {
    const form = new QuestionForm({ type: "object", properties: {
        post: { type: "string" }, credential: { type: "string" }, notes: { type: "string" },
    }, required: [] });
    assert.match(form.prompt, /post.*optional.*Enter/);
    assert.deepEqual(form.submit(""), { kind: "next" });
    assert.match(form.prompt, /credential/);
    assert.deepEqual(form.submit("fixture-token"), { kind: "next" });
    assert.match(form.prompt, /notes/);
    assert.deepEqual(form.submit(""), { kind: "complete", content: { credential: "fixture-token" } });
});

test("required and typed fields give corrective feedback without advancing", () => {
    const form = new QuestionForm({ properties: { count: { type: "integer" }, confirmed: { type: "boolean" } }, required: ["count"] });
    assert.deepEqual(form.submit(""), { kind: "invalid", message: "count is required." });
    assert.equal(form.submit("not a number").kind, "invalid");
    assert.match(form.prompt, /^count/);
    assert.equal(form.submit("3").kind, "next");
    assert.deepEqual(form.submit("false"), { kind: "complete", content: { count: 3, confirmed: false } });
});

test("single-field numbered choices and free text retain their normal mapping", () => {
    const schema = { properties: { branch: { type: "string", enum: ["main", "topic"] } } };
    const form = new QuestionForm(schema);
    assert.deepEqual(form.choices, ["main", "topic"]);
    assert.deepEqual(form.submit("2"), { kind: "complete", content: { branch: "topic" } });
    assert.deepEqual(new QuestionForm(schema).submit("custom"), { kind: "complete", content: { branch: "custom" } });
});

test("empty forms explicitly submit empty content", () => {
    const form = new QuestionForm({ type: "object" });
    assert.match(form.prompt, /Enter/);
    assert.equal(form.submit("unassigned text").kind, "invalid");
    assert.deepEqual(form.submit(""), { kind: "complete", content: {} });
});

test("structured fields preserve types and reject mismatches without losing prior answers", () => {
    const form = new QuestionForm({ properties: {
        count: { type: "number" }, items: { type: "array" }, options: { type: "object" },
    } });
    assert.equal(form.submit("0").kind, "next");
    assert.equal(form.submit("{}").kind, "invalid");
    assert.equal(form.submit('["a"]').kind, "next");
    assert.equal(form.submit("null").kind, "invalid");
    assert.deepEqual(form.submit('{"enabled":false}'), {
        kind: "complete", content: { count: 0, items: ["a"], options: { enabled: false } },
    });
});
