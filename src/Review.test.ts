import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { CURSOR_MARKER, Editor, visibleWidth, type Terminal } from "@earendil-works/pi-tui";
import Review from "./Review.ts";
import TuiSurface from "./tui-surface.ts";
import type { ProposalParams, Resolution } from "./proposal.ts";

const proposal = (id = 1): ProposalParams => ({
    logEntryId: id, loopId: 1, turnId: 1, op: "sh", target: { scheme: null, pathname: null },
    body: "printf hello", attrs: {}, owner: "agui://anonymous/threads/client",
});
const question = (id = 1, responseSchema: Record<string, unknown> = {
    type: "object", properties: { name: { type: "string" } }, required: ["name"],
}) => ({ interactionId: id, toolName: "question", arguments: {}, message: `Question ${id}`, responseSchema });

const fixture = (t: TestContext) => {
    let input: (data: string) => void = () => {};
    let starts = 0;
    const output: string[] = [];
    const terminal: Terminal = {
        columns: 100, rows: 30, kittyProtocolActive: false,
        start: (handler) => { input = handler; starts++; }, stop() {}, drainInput: async () => {},
        write: (text) => { output.push(text); }, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
        clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
    };
    const surface = new TuiSurface(terminal);
    const calls: unknown[] = [];
    const records: string[] = [];
    const errors: unknown[] = [];
    const actions = {
        resolveProposal: async (p: ProposalParams, resolution: Resolution) => {
            calls.push([`prop:${p.logEntryId}`, resolution]);
            review.remove(`prop:${p.logEntryId}`);
        },
        editProposal: async (_p: ProposalParams): Promise<Resolution> => ({ decision: "accept", body: "edited" }),
        resolveQuestion: async (id: number, answer: Record<string, unknown> | "cancel") => {
            calls.push([`int:${id}`, answer]);
            review.remove(`int:${id}`);
        },
        record: (text: string) => { records.push(text); },
        error: (cause: unknown) => { errors.push(cause); },
    };
    const review = new Review(surface, actions);
    surface.start();
    t.after(() => surface.stop());
    return { surface, review, actions, calls, records, errors, output, get starts() { return starts; }, key: (text: string) => { input(text); } };
};

test("[§cli-inline-review] native selection resolves once; no raw-letter approvals", async (t) => {
    const h = fixture(t);
    h.review.addProposal(proposal());
    assert.equal(h.surface.reviewing, true);
    h.key("a");
    assert.deepEqual(h.calls, []);
    h.key("\x1b[B");
    h.key("\x1b[B");
    h.key("\r");
    await setImmediate();
    assert.deepEqual(h.calls, [["prop:1", { decision: "reject" }]]);
    assert.equal(h.surface.reviewing, false);
    assert.equal(h.surface.editor.focused, true);
    assert.match(h.records.join("\n"), /proposal sh sh — rejected/);
});

test("[§cli-inline-review] arrival preserves draft, cursor and undo; returning preserves partial answers", async (t) => {
    const h = fixture(t);
    const composer = h.surface.editor;
    h.key("draft");
    h.key("\x1b[D");
    const cursor = composer.getCursor();
    h.review.addQuestion(question());
    assert.equal(h.surface.reviewing, false);
    assert.equal(h.surface.editor, composer);
    assert.deepEqual(composer.getCursor(), cursor);
    assert.equal(h.surface.openReview(), true);
    assert.equal(composer.focused, false);
    h.key("/literal-answer");
    assert.ok(h.review.render(80).join("\n").includes(CURSOR_MARKER), "IME cursor comes from the focused answer editor");
    assert.equal(h.surface.leaveReview(), true);
    assert.deepEqual(composer.getCursor(), cursor);
    h.key("X");
    assert.equal(composer.getText(), "drafXt");
    h.key("\x1f");
    assert.equal(composer.getText(), "draft", "native undo survived the component swap");
    h.surface.openReview();
    assert.match(h.review.render(80).join("\n"), /\/literal-answer/);
    h.key("\r");
    await setImmediate();
    assert.deepEqual(h.calls, [["int:1", { name: "/literal-answer" }]]);
    assert.equal(composer.getText(), "draft");
    assert.doesNotMatch(h.records.join("\n"), /literal-answer/, "answers are not copied into the transcript");
    composer.setText("");
    h.key("\x1b[A");
    assert.equal(composer.getText(), "", "form answers do not enter prompt recall");
});

test("[§cli-inline-review] questions and proposals queue by identity, with cancellation and no focus stealing", async (t) => {
    const h = fixture(t);
    h.review.addQuestion(question(7));
    h.key("Ada");
    h.review.addProposal(proposal(7));
    h.review.addQuestion(question(8));
    assert.match(h.review.render(80).join("\n"), /Ada/);
    assert.throws(() => h.review.addQuestion(question(7)), /Duplicate review interrupt int:7/);
    h.review.remove("int:8");
    h.surface.leaveReview();
    h.key("ordinary draft");
    h.review.remove("int:7");
    assert.equal(h.surface.reviewing, false);
    assert.match(h.review.render(80).join("\n"), /proposal sh/);
    await h.review.decide("cancel");
    assert.deepEqual(h.calls, [["prop:7", { decision: "cancel" }]]);
    assert.equal(h.surface.editor.getText(), "ordinary draft");
    assert.equal(h.surface.openReview(), false);
});

test("[§cli-inline-review] background status and transcript updates render without stealing answer focus", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = fixture(t);
    h.review.addQuestion(question());
    h.key("Ada");
    h.surface.setStatus("elapsed 12m · cost $0.20");
    h.surface.append("child activity arrived");
    h.surface.setLive("reasoning continues");
    await setImmediate();
    t.mock.timers.tick(20);
    const output = h.output.join("");
    for (const text of ["elapsed 12m", "cost $0.20", "child activity arrived", "reasoning continues", "Ada"]) {
        assert.ok(output.includes(text), `${text} remains visible in the composed terminal`);
    }
    h.key(" Lovelace");
    h.key("\r");
    await setImmediate();
    assert.deepEqual(h.calls, [["int:1", { name: "Ada Lovelace" }]]);
});

test("[§cli-question-forms] enum selection and optional skip preserve exact field values", async (t) => {
    const h = fixture(t);
    h.review.addQuestion(question(1, { type: "object", properties: {
        branch: { type: "string", enum: ["2", "1"] }, optional: { type: "string", enum: ["secret"] },
    }, required: ["branch"] }));
    assert.doesNotMatch(h.review.render(80).join("\n"), /Skip/);
    h.key("\r");
    assert.match(h.review.render(80).join("\n"), /Skip \(optional\)/);
    h.key("\x1b[B");
    h.key("\r");
    await setImmediate();
    assert.deepEqual(h.calls, [["int:1", { branch: "2" }]]);
});

test("[§cli-question-forms] invalid JSON remains editable, then resumes the exact complex response", async (t) => {
    const h = fixture(t);
    h.review.addQuestion(question(1, { type: "object", properties: { profile: {
        type: "object", properties: { age: { type: "integer" } }, required: ["age"],
    } }, required: ["profile"] }));
    h.key("{");
    h.key("\r");
    assert.match(h.review.render(80).join("\n"), /Response requires valid JSON/);
    assert.equal((h.review.children.find((child) => child instanceof Editor) as Editor).getText(), "{");
    h.key('"profile":{"age":"wrong"}}');
    h.key("\r");
    assert.match(h.review.render(80).join("\n"), /Response does not satisfy/);
    assert.deepEqual(h.calls, []);
    h.key("\x15");
    h.key('{"profile":{"age":42}}');
    h.key("\r");
    await setImmediate();
    assert.deepEqual(h.calls, [["int:1", { profile: { age: 42 } }]]);
    assert.deepEqual(h.records, ["  question — answered"]);
});

test("[§cli-inline-review] a withdrawn proposal's external editor cannot resolve its successor", async (t) => {
    const h = fixture(t);
    const edit = Promise.withResolvers<Resolution>();
    h.actions.editProposal = () => h.surface.handOff(() => edit.promise);
    h.review.addProposal(proposal(1));
    h.review.addQuestion(question(2));
    const pending = h.review.decide("edit");
    h.review.remove("prop:1");
    edit.resolve({ decision: "accept", body: "stale" });
    await pending;
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.records, []);
    h.key("Ada");
    h.key("\r");
    await setImmediate();
    assert.deepEqual(h.calls, [["int:2", { name: "Ada" }]], "focus returns to the current question after handoff");
});

test("[§cli-inline-review] editor failure is visible and leaves the original proposal reviewable", async (t) => {
    const h = fixture(t);
    const error = new Error("editor exited 1");
    h.actions.editProposal = async () => { throw error; };
    h.review.addProposal(proposal());
    await h.review.decide("edit");
    assert.deepEqual(h.errors, [error]);
    assert.deepEqual(h.calls, [], "an editor failure is not an implicit cancellation");
    assert.equal(h.surface.reviewing, true);
    await h.review.decide("accept");
    assert.deepEqual(h.calls, [["prop:1", { decision: "accept" }]]);
});

test("[§cli-inline-review] an external editor cannot restart a closed terminal surface", async (t) => {
    const h = fixture(t);
    const edit = Promise.withResolvers<void>();
    const pending = h.surface.handOff(() => edit.promise);
    h.surface.stop();
    edit.resolve();
    await pending;
    assert.equal(h.starts, 1, "closing during handoff remains closed after the editor exits");
});

test("[§cli-inline-review] resolution failure keeps the request and partial answer; duplicate submissions are blocked", async (t) => {
    const h = fixture(t);
    const failed = Promise.withResolvers<void>();
    let attempts = 0;
    const resolve = h.actions.resolveQuestion;
    h.actions.resolveQuestion = async (id, answer) => {
        attempts++;
        if (attempts === 1) return failed.promise;
        await resolve(id, answer);
    };
    h.review.addQuestion(question());
    h.key("Ada");
    h.key("\r");
    h.key("\r");
    assert.equal(attempts, 1);
    const error = new Error("network unavailable");
    failed.reject(error);
    await setImmediate();
    assert.deepEqual(h.errors, [error]);
    assert.match(h.review.render(80).join("\n"), /Resolution failed/);
    assert.match(h.review.render(80).join("\n"), /Ada/);
    h.key("\r");
    await setImmediate();
    assert.deepEqual(h.calls, [["int:1", { name: "Ada" }]]);
});

test("[§cli-question-forms] malformed schema validation surfaces its cause and leaves cancellation available", async (t) => {
    const h = fixture(t);
    h.review.addQuestion(question(1, { properties: { name: { type: "string", pattern: "[" } }, required: ["name"] }));
    h.key("Ada");
    h.key("\r");
    assert.equal(h.errors.length, 1);
    assert.ok(h.errors[0] instanceof SyntaxError);
    assert.match(h.errors[0].message, /Invalid regular expression/);
    assert.match(h.review.render(80).join("\n"), /Answer validation failed/);
    assert.match(h.review.render(80).join("\n"), /Ada/);
    assert.deepEqual(h.calls, []);
    await h.review.decide("cancel");
    assert.deepEqual(h.calls, [["int:1", "cancel"]]);
});

test("[§cli-inline-review] narrow and wide redraws retain safe Unicode text, multiline paste and answer focus", async (t) => {
    const h = fixture(t);
    h.review.addQuestion({ ...question(), message: "Long 日本語 question " + "wrapped ".repeat(20) + "\x1b[2J" });
    h.key("\x1b[200~multiline\nanswer\x1b[201~");
    for (const width of [16, 37, 135]) {
        const lines = h.review.render(width);
        assert.ok(lines.every((line) => visibleWidth(line) <= width), `${width}-column rendering stays within the terminal`);
        assert.doesNotMatch(lines.join("\n"), /\x1b\[2J/);
        assert.ok(lines.join("\n").includes(CURSOR_MARKER));
    }
    assert.deepEqual(h.calls, []);
    h.key("\r");
    await setImmediate();
    assert.deepEqual(h.calls, [["int:1", { name: "multiline\nanswer" }]]);
});
