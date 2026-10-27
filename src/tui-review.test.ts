import test from "node:test";
import assert from "node:assert/strict";
import type { Terminal } from "@earendil-works/pi-tui";
import Review, {
    isElicitationGateEvent,
    isPermissionGateEvent,
    QuestionForm,
} from "./tui-review.ts";
import TuiSurface from "./tui-surface.ts";

const makeFakeTerminal = (): { terminal: Terminal; written: string[] } => {
    const written: string[] = [];
    const terminal: Terminal = {
        columns: 80,
        rows: 24,
        kittyProtocolActive: false,
        start() {},
        stop() {},
        async drainInput() {},
        write(data: string) {
            written.push(data);
        },
        moveBy() {},
        hideCursor() {},
        showCursor() {},
        clearLine() {},
        clearFromCursor() {},
        clearScreen() {},
        setTitle(t: string) {
            written.push(`TITLE:${t}`);
        },
        setProgress() {},
        setProgramStatus() {},
    };
    return { terminal, written };
};

test("{§cli-inline-review}: type guards, QuestionForm multi-field validation, and Review permission/elicitation controls", async () => {
    assert.equal(isPermissionGateEvent({ id: "a1b2c3d4", title: "EDIT a.ts" }), true);
    assert.equal(isPermissionGateEvent({ id: "a1b2c3d4" }), false);
    assert.equal(isElicitationGateEvent({ id: "a1b2c3d4", mode: "form", message: "Question?" }), true);
    assert.equal(isElicitationGateEvent({ id: "a1b2c3d4", mode: "url", message: "Sign in" }), true);
    assert.equal(isElicitationGateEvent({ id: "a1b2c3d4", mode: "invalid", message: "?" }), false);

    // Multi-field QuestionForm with required and optional fields
    const form = new QuestionForm({
        type: "object",
        properties: {
            name: { type: "string", title: "Name", minLength: 2 },
            count: { type: "integer", title: "Count" },
        },
        required: ["name"],
    });
    assert.match(form.prompt, /Name \(name\) \(string; required\)/u);
    assert.equal(form.submit("a").kind, "invalid", "minLength 2 enforced");
    assert.deepEqual(form.submit("alice"), { kind: "next" });
    assert.equal(form.optional, true);
    assert.equal(form.submit("not-a-number").kind, "invalid");
    assert.deepEqual(form.submit("3"), { kind: "complete", content: { name: "alice", count: 3 } });

    // Non-flat schema falls back to whole JSON object submission
    const jsonForm = new QuestionForm({
        type: "object",
        properties: {
            nested: { anyOf: [{ type: "object" }] },
        },
    });
    assert.equal(jsonForm.submit("not-json").kind, "invalid");
    assert.equal(jsonForm.submit("[]").kind, "invalid");
    assert.deepEqual(jsonForm.submit('{"nested":{"ok":true}}'), {
        kind: "complete",
        content: { nested: { ok: true } },
    });

    // Review URL elicitation and form elicitation
    const { terminal } = makeFakeTerminal();
    const surface = new TuiSurface(terminal);
    const stdinCommands: string[] = [];
    const review = new Review(surface, {
        sendStdin: (cmd) => stdinCommands.push(cmd),
        editBody: async () => "patched content",
        record: (t) => surface.append(t),
    });
    surface.start();

    review.addElicitationGate({
        id: "11223344",
        mode: "url",
        message: "Authorize MCP server",
        url: "http://127.0.0.1:9999/oauth",
    });
    assert.equal(review.waiting, 1);
    assert.equal(review.focusedGateId, "11223344");
    review.handleInput("\r");
    assert.deepEqual(stdinCommands, ["/approve @11223344\n"]);
    review.remove("11223344");
    assert.equal(review.waiting, 0);

    review.addElicitationGate({
        id: "55667788",
        mode: "form",
        message: "Enter environment name",
        requestedSchema: {
            type: "object",
            properties: {
                env: { type: "string", enum: ["dev", "prod"] },
            },
            required: ["env"],
        },
    });
    assert.equal(review.waiting, 1);
    review.handleInput("\r");
    assert.equal(stdinCommands.at(-1), '\x1b[200~/answer @55667788 {"env":"dev"}\x1b[201~\n');
    review.remove("55667788");
    surface.stop();
});
