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

test("single-field numbered choices accept listed text and reject values outside the enum", () => {
    const schema = { properties: { branch: { type: "string", enum: ["main", "topic"] } } };
    const form = new QuestionForm(schema);
    assert.deepEqual(form.choices, ["main", "topic"]);
    assert.deepEqual(form.submit("2"), { kind: "complete", content: { branch: "topic" } });
    const corrected = new QuestionForm(schema);
    assert.equal(corrected.submit("custom").kind, "invalid");
    assert.deepEqual(corrected.submit("main"), { kind: "complete", content: { branch: "main" } });
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

test("complex response schemas expose the exact schema and accept typed JSON after correction", () => {
    const schema = { type: "object", properties: {
        profile: { description: "Who is making this request?", oneOf: [
            { type: "object", properties: { action: { const: "accept" }, content: {
                type: "object", properties: { name: { type: "string", minLength: 1 } }, required: ["name"],
            } }, required: ["action", "content"], additionalProperties: false },
            { type: "object", properties: { action: { enum: ["decline", "cancel"] } }, required: ["action"], additionalProperties: false },
        ] },
    }, required: ["profile"], additionalProperties: false };
    const form = new QuestionForm(schema);
    assert.match(form.prompt, /JSON object/);
    assert.ok(form.prompt.includes(JSON.stringify(schema, null, 2)), "the full response schema is visible, not a guessed example");
    assert.equal(form.submit("{").kind, "invalid");
    assert.equal(form.submit("[]").kind, "invalid");
    assert.equal(form.submit('{"profile":{"action":"accept","content":{"name":42}}}').kind, "invalid");
    assert.equal(form.submit('{"profile":{"action":"accept","content":{"name":""}}}').kind, "invalid");
    const payload = { profile: { action: "accept", content: { name: "Ada" } } };
    assert.deepEqual(form.submit(JSON.stringify(payload)), { kind: "complete", content: payload });
    assert.deepEqual(new QuestionForm(schema).submit('{"profile":{"action":"decline"}}'), {
        kind: "complete", content: { profile: { action: "decline" } },
    });
});

test("complex forms keep root references and cross-field constraints in their validation context", () => {
    const schema = { type: "object", $defs: { name: { type: "string", minLength: 1 } }, properties: {
        name: { $ref: "#/$defs/name" }, enabled: { type: "boolean" },
    }, required: ["name"], dependentRequired: { enabled: ["name"] }, additionalProperties: false };
    const form = new QuestionForm(schema);
    assert.match(form.prompt, /\$defs/);
    assert.equal(form.submit('{"enabled":false}').kind, "invalid");
    assert.equal(form.submit('{"name":null}').kind, "invalid");
    assert.deepEqual(form.submit('{"name":"Ada","enabled":false}'), {
        kind: "complete", content: { name: "Ada", enabled: false },
    });
});

test("boolean property schemas use the complete JSON form without inventing a field type", () => {
    const form = new QuestionForm({ type: "object", properties: { anything: true, forbidden: false }, required: ["anything"] });
    assert.match(form.prompt, /JSON object/);
    assert.equal(form.submit('{"anything":null,"forbidden":false}').kind, "invalid");
    assert.deepEqual(form.submit('{"anything":[1,false,null]}'), {
        kind: "complete", content: { anything: [1, false, null] },
    });
});

test("flat field constraints are checked before advancing, preserving the previous answer", () => {
    const form = new QuestionForm({ type: "object", properties: {
        name: { type: "string", minLength: 2 }, count: { type: "integer", minimum: 0 },
    }, required: ["name", "count"] });
    assert.equal(form.submit("A").kind, "invalid");
    assert.equal(form.submit("Ada").kind, "next");
    assert.equal(form.submit("-1").kind, "invalid");
    assert.deepEqual(form.submit("0"), { kind: "complete", content: { name: "Ada", count: 0 } });
});
