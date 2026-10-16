import { test } from "node:test";
import assert from "node:assert/strict";
import type { AguiEvent } from "./agui.ts";
import { ProblemError } from "./diagnostics.ts";
import type { LogEntryWire } from "./render.ts";
import RowAssembler, { snapshotRows, wholeRow } from "./rows.ts";
import { arrivalOf, callOf, dischargeOf, messagesOf, partsOf, settlementOf, speechOf } from "../test/agui-parts.ts";

// Every row an event completes, in the order the events arrive.
const drawn = (events: readonly AguiEvent[], rows = new RowAssembler()): LogEntryWire[] => events.flatMap((event) => rows.consume(event));

const read = { id: 4, op: "READ", origin: "model", loop_seq: 2, turn_seq: 3, sequence: 1, worker_id: 7, target: "worker://helper/notes.md", status_rx: 200,
    tx: { aside: "look first", target: { kind: "url", raw: "worker://helper/notes.md" }, lineMarker: { marks: [1, 4] }, matcher: null, body: null },
    rx: { status: 200, range: { unit: "line", total: 9, requested: [1, 4], returned: [1, 4] } } };

test("[§cli-row-sources] a call and its receipt are one row, drawn when the receipt arrives; a call that opened an obligation at its end", () => {
    const rows = new RowAssembler();
    const [start, args, end, result] = callOf(read);
    assert.deepEqual(drawn([start!, args!, end!], rows), [], "nothing is drawn before the receipt");
    const [row] = drawn([result!], rows);
    assert.deepEqual([row?.id, row?.op, row?.origin, row?.worker_id, row?.status_rx], [4, "READ", "model", 7, 200]);
    assert.deepEqual([row?.loop_seq, row?.turn_seq, row?.sequence], [2, 3, 1], "the coordinate is the row's own");
    assert.equal(row?.target, "worker://helper/notes.md", "the target is the address the row recorded");
    assert.deepEqual(row?.lineMarker, { marks: [1, 4] }, "the scope is the statement's");
    assert.equal((row?.tx as { aside?: string }).aside, "look first", "the statement is the call's arguments");
    assert.deepEqual(row?.rx, read.rx, "the receipt is the result");

    const exec = { id: 5, op: "sh", sequence: 2, status_rx: 200, attrs: { stream: "sh:///ab3d5678" }, tx: { runtime: "sh", body: "ls" }, rx: { status: 200, outcome: "started" } };
    const parts = callOf(exec);
    assert.deepEqual(parts.map(({ type }) => type), ["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"], "its discharge answers it, not its receipt");
    const [launched] = drawn(parts);
    assert.deepEqual([launched?.id, launched?.op, launched?.rx], [5, "sh", null], "drawn at its end, its stream named by its attributes");
});

test("[§cli-row-sources] speech carries its heading's aside and its receipt; an arrival is the message it delivered", () => {
    const receipt = { status: 200, answers: ["agui://anonymous/threads/t/messages/m1"] };
    const [reply] = drawn(speechOf({ id: 8, op: "SEND", sequence: 3, tx: { aside: "the answer", body: { raw: "{\"planet\":\"Jupiter\"}", json: null } }, rx: receipt }));
    assert.equal((reply?.tx as { aside?: string }).aside, "the answer");
    assert.deepEqual((reply?.tx as { body?: unknown }).body, { raw: "{\"planet\":\"Jupiter\"}", json: { planet: "Jupiter" } }, "a SEND's body is its words and their JSON reading");
    assert.deepEqual(reply?.rx, receipt);
    const [wait] = drawn(speechOf({ id: 9, op: "WAIT", sequence: 4, signal: 202, status_rx: 202, tx: { body: "Back soon." }, rx: { status: 202, attrs: { waiting: 1 } } }));
    assert.deepEqual([wait?.op, (wait?.tx as { body?: unknown }).body, wait?.signal], ["WAIT", "Back soon.", 202], "a WAIT's body is text");

    const [arrival] = drawn(arrivalOf({ id: 10, op: "SEND", origin: "_plurnk", source: "worker://helper", attrs: { kind: "message" }, tx: { body: { raw: "Done." } } }));
    assert.deepEqual([arrival?.origin, arrival?.source, (arrival?.tx as { body: { raw: string } }).body.raw], ["_plurnk", "worker://helper", "Done."]);
    const [own] = drawn(arrivalOf({ id: 11, op: "SEND", origin: "_plurnk", source: "agui://anonymous/threads/t/messages/m1", attrs: { kind: "message" }, tx: { body: { raw: "" } } }, "m1"));
    assert.deepEqual([own?.id, own?.sequence], [11, 1], "the client's own message, which it holds, still names its row");
});

test("[§cli-row-sources] a result that answers another row's call is that row: a reply's words, or what it received", () => {
    const [reply] = drawn(dischargeOf({ id: 12, op: "SEND", origin: "_plurnk", source: "worker://peer", sequence: 5, attrs: { kind: "reply" }, tx: { body: { raw: "forty-two" } } }, "1/1/2"));
    assert.deepEqual([reply?.op, reply?.source, (reply?.tx as { body: { raw: string } }).body.raw, reply?.rx], ["SEND", "worker://peer", "forty-two", null]);
    const conclusion = { status: 200, resource: "ops://helper/1", content: "hello" };
    const [concluded] = drawn(dischargeOf({ id: 13, op: "READ", origin: "_plurnk", source: "worker://helper", sequence: 6, target: "ops://helper/1", rx: conclusion }, "1/1/1"));
    assert.deepEqual([concluded?.op, concluded?.target, concluded?.rx], ["READ", "ops://helper/1", conclusion]);
});

test("[§cli-row-sources] a call ended without its receipt, a result that is not text, or unreadable facts are a broken wire; an interrupt's call is no row", () => {
    const broken = (events: AguiEvent[]): void => assert.throws(() => drawn(events),
        (error: unknown) => error instanceof ProblemError && error.problem.kind === "result-invalid");
    const [start, args, end] = callOf(read);
    broken([start!, args!, end!, ...callOf({ ...read, id: 5, sequence: 2 })]);
    broken([{ ...start!, metadata: { plurnk: { id: 4, op: "READ" } } } as AguiEvent]);
    const [, , , result] = callOf(read);
    broken([start!, args!, end!, { ...result!, content: [{ type: "text", text: "receipt" }] } as unknown as AguiEvent]);
    assert.deepEqual(drawn([
        { type: "TOOL_CALL_START", toolCallId: "int:43", toolCallName: "request_user_input" },
        { type: "TOOL_CALL_ARGS", toolCallId: "int:43", delta: "{}" },
        { type: "TOOL_CALL_END", toolCallId: "int:43" },
    ] as AguiEvent[]), [], "a client interaction's call builds no row");
});

// plurnk-service {§agui-proposal-resolve}: the gated call awaits its decision, then settles with a receipt or opening an obligation.
test("[§cli-row-sources] a gated call awaiting its decision is no broken wire and draws nothing; its settlement draws it once, with its statement", () => {
    const gated = { ...read, state: "proposed", status_rx: 202, rx: { status: 202 } };
    const settlements = [
        ["answered by its receipt", { ...read, state: "resolved" }, read.rx],
        ["opening an obligation", { ...read, state: "resolved", attrs: { stream: "sh:///ab3d5678" }, rx: { status: 200, outcome: "started" } }, null],
        ["refused", { ...read, state: "failed", status_rx: 403, rx: { status: 403 } }, { status: 403 }],
    ] as const;
    for (const [how, settled, rx] of settlements) {
        for (const [vantage, rows] of [["live", new RowAssembler()], ["held by a snapshot", (() => {
            const assembler = new RowAssembler();
            assert.deepEqual(snapshotRows(messagesOf(gated), assembler), [], "a snapshot holds the pending call without a row");
            return assembler;
        })()]] as const) {
            const before = vantage === "live" ? drawn([...callOf(gated), ...callOf({ ...read, id: 5, sequence: 2 })], rows) : [];
            assert.deepEqual(before.map(({ id }) => id), vantage === "live" ? [5] : [], `${how}, ${vantage}: the pending call draws nothing and breaks nothing`);
            const after = drawn(settlementOf(settled), rows);
            assert.deepEqual(after.map(({ id, status_rx, state }) => [id, status_rx, state]), [[4, settled.status_rx, settled.state]], `${how}, ${vantage}: its settlement draws it once`);
            assert.deepEqual([after[0]?.tx, after[0]?.rx], [read.tx, rx], `${how}, ${vantage}: with the statement its call was built with`);
        }
    }
});

test("[§cli-row-sources] a whole row draws as its parts do: the address it recorded, and nothing for an actionless row", () => {
    const whole = (over: Record<string, unknown>) => wholeRow({ id: 1, worker_id: 7, loop_seq: 1, turn_seq: 1, sequence: 1, origin: "_plurnk", op: "READ",
        source: null, signal: null, scheme: null, hostname: null, port: null, pathname: null, query: null, fragment: null, lineMarker: null,
        tx: null, rx: { status: 200 }, status_rx: 200, attrs: {}, ...over });
    assert.equal(whole({ scheme: "worker", pathname: "/plan.md" })?.target, "worker:///plan.md", "an empty authority stays empty");
    assert.equal(whole({ scheme: "worker", hostname: "extract-host", pathname: "/plan.md" })?.target, "worker://extract-host/plan.md");
    assert.equal(whole({ scheme: "https", hostname: "example.com", port: 8443, pathname: "/a", query: "b=1", fragment: "top" })?.target, "https://example.com:8443/a?b=1#top");
    assert.equal(whole({ scheme: "sh", pathname: "/ab3d5678", fragment: "stdout" })?.target, "sh:///ab3d5678#stdout", "an observed channel is its fragment");
    assert.equal(whole({ pathname: "src/a.ts" })?.target, "src/a.ts", "a file target records its bare path");
    assert.equal(whole({ op: null, origin: "model", attrs: { kind: "emissionAttempt" } }), null, "a rejected emission draws nothing");
    const [part] = drawn(callOf({ id: 1, op: "READ", worker_id: 7, target: "worker:///plan.md", tx: { target: { kind: "url", raw: "worker:///plan.md" } } }));
    const fromWhole = whole({ origin: "model", scheme: "worker", pathname: "/plan.md", tx: { target: { kind: "url", raw: "worker:///plan.md" } } });
    assert.deepEqual([part?.id, part?.op, part?.target, part?.status_rx], [fromWhole?.id, fromWhole?.op, fromWhole?.target, fromWhole?.status_rx],
        "the same row draws the same whichever way it arrived");
});

test("[§cli-worker-history] a snapshot rebuilds every row its live parts built, in log order; a subagent's messages and reasoning build none", () => {
    const exec = { id: 5, op: "sh", sequence: 1, attrs: { stream: "sh:///ab3d5678" }, tx: { runtime: "sh", body: "ls" }, rx: { status: 200, outcome: "started" } };
    const look = { id: 6, op: "READ", sequence: 2, target: "notes.md", tx: { target: { kind: "local", raw: "notes.md" } }, rx: { status: 200 } };
    const reply = { id: 7, op: "SEND", sequence: 3, tx: { aside: "the answer", body: { raw: "Done." } }, rx: { status: 200, answers: ["agui://anonymous/threads/t/messages/m1"] } };
    const concluded = { id: 8, op: "READ", origin: "_plurnk", source: "sh:///ab3d5678", sequence: 4, target: "sh:///ab3d5678", invocation: "log:///1/1/1/sh", rx: { status: 200, content: "a.ts" } };
    const arrival = { id: 9, op: "SEND", origin: "_plurnk", source: "worker://helper", sequence: 5, attrs: { kind: "message" }, tx: { body: { raw: "Thanks." } } };
    const again = { ...arrival, id: 10, sequence: 6, tx: { body: { raw: "One more thing." } } };
    const live = drawn([exec, look, reply, concluded, arrival, again].flatMap((row) => partsOf(row)));
    assert.deepEqual(live.map(({ id }) => id), [5, 6, 7, 8, 9, 10], "every part kind builds its row; two messages from one source are two rows");
    // plurnk-service `{§agui-snapshot}`: a discharge follows the call it answers, ahead of the rows between them.
    const messages = [exec, concluded, look, reply, arrival, again].flatMap((row) => messagesOf(row));
    assert.deepEqual(snapshotRows(messages), live, "the snapshot draws what the live stream drew, in log order");
    const subagent = messagesOf({ ...look, id: 11, sequence: 7 }).map((message) => ({ ...message, subagentRunId: "child" }));
    const reasoning = { id: "1/1/8/reasoning", role: "reasoning", content: "thinking" };
    assert.deepEqual(snapshotRows([...messages, ...subagent, reasoning]), live, "a subagent's messages belong to its run, and reasoning is never backfilled");
});
