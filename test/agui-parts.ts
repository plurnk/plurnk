// What the daemon sends for one row (plurnk-service {§agui-projection}, {§agui-plurnk-metadata}): the standard part
// the row builds, carrying the row's facts, or the whole row as CUSTOM plurnk.ambient when it builds none.

import type { AguiEvent } from "../src/agui.ts";
import { objectOf, type LogEntryWire } from "../src/render.ts";

export type PartRow = Partial<LogEntryWire> & { op: string; invocation?: string };

const coordinate = (row: PartRow): string => `${row.loop_seq ?? 1}/${row.turn_seq ?? 1}/${row.sequence ?? 1}`;

export const factsOf = (row: PartRow): Record<string, unknown> => ({
    id: row.id ?? 1, coordinate: coordinate(row), worker: row.worker_id ?? 1, origin: row.origin ?? "model", op: row.op,
    source: row.source ?? null, address: row.target ?? null, signal: row.signal ?? null, status: row.status_rx ?? 200, attrs: row.attrs ?? {},
});

const body = (tx: unknown): string => {
    const value = objectOf(tx)?.body;
    if (typeof value === "string") return value;
    const raw = objectOf(value)?.raw;
    return typeof raw === "string" ? raw : "";
};

// A tool call and its receipt; a call that opened an obligation ends without one.
export const callOf = (row: PartRow, id = coordinate(row)): AguiEvent[] => {
    const metadata = { plurnk: factsOf(row) };
    const { op: _op, position: _position, ...operands } = objectOf(row.tx) ?? {};
    const attrs = objectOf(row.attrs);
    const opens = (typeof attrs?.stream === "string" || typeof attrs?.message === "string") && (row.status_rx ?? 200) < 400;
    return [
        { type: "TOOL_CALL_START", toolCallId: id, toolCallName: row.op, metadata },
        { type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(operands) },
        { type: "TOOL_CALL_END", toolCallId: id },
        ...(opens ? [] : [{ type: "TOOL_CALL_RESULT", toolCallId: id, messageId: `${id}/result`, content: row.rx === undefined || row.rx === null ? "" : JSON.stringify(row.rx), metadata }]),
    ] as AguiEvent[];
};

// Speech: the body, with the heading's aside and the receipt beside the row's facts.
export const speechOf = (row: PartRow, id = coordinate(row)): AguiEvent[] => {
    const aside = objectOf(row.tx)?.aside;
    const metadata = { plurnk: { ...factsOf(row), aside: typeof aside === "string" ? aside : null, receipt: row.rx ?? null } };
    return [
        { type: "TEXT_MESSAGE_START", messageId: id, role: "assistant", metadata },
        { type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: body(row.tx) },
        { type: "TEXT_MESSAGE_END", messageId: id },
    ] as AguiEvent[];
};

// An arrival: the message it delivered, named by its source.
export const arrivalOf = (row: PartRow, id = coordinate(row)): AguiEvent[] => {
    const text = body(row.tx);
    return [
        { type: "TEXT_MESSAGE_START", messageId: id, role: "user", ...(typeof row.source === "string" ? { name: row.source } : {}), metadata: { plurnk: factsOf(row) } },
        ...(text.length === 0 ? [] : [{ type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: text }]),
        { type: "TEXT_MESSAGE_END", messageId: id },
    ] as AguiEvent[];
};

// A row that answers another row's call: what it delivered, under its own coordinate.
export const dischargeOf = (row: PartRow, call: string): AguiEvent[] => [
    { type: "TOOL_CALL_RESULT", toolCallId: call, messageId: coordinate(row), content: row.op === "SEND" ? body(row.tx) : JSON.stringify(row.rx ?? null), metadata: { plurnk: factsOf(row) } },
] as AguiEvent[];

// A row that builds nothing in the conversation, whole: its target is the path the daemon's row records.
export const ambientOf = (row: PartRow): AguiEvent => ({
    type: "CUSTOM", name: "plurnk.ambient",
    value: {
        id: row.id ?? 1, worker_id: row.worker_id ?? 1, loop_seq: row.loop_seq ?? 1, turn_seq: row.turn_seq ?? 1, sequence: row.sequence ?? 1,
        origin: row.origin ?? "_plurnk", source: row.source ?? null, op: row.op, signal: row.signal ?? null,
        scheme: null, hostname: null, pathname: row.target ?? null, fragment: null,
        lineMarker: row.lineMarker ?? null, tx: row.tx ?? null, rx: row.rx ?? null, status_rx: row.status_rx ?? 200, attrs: row.attrs ?? {},
    },
} as AguiEvent);

// {§message-arrival} A message address on the thread: agui://<principal>/threads/<thread>/messages/<id>.
const onThread = (address: unknown, thread: string): boolean =>
    typeof address === "string" && new RegExp(`^agui://[^/]+/threads/${encodeURIComponent(thread)}/messages/[^/]+$`, "u").test(address);

// A SEND or KILL that delivered words to the thread is the worker's speech; a WAIT's body is too.
const speaks = (row: PartRow, thread: string): boolean => {
    const text = body(row.tx).trim();
    if (row.op === "WAIT") return row.origin === "model" && text.length > 0;
    if (row.op !== "SEND" && row.op !== "KILL") return false;
    const reply = objectOf(row.attrs)?.kind === "reply";
    const status = row.status_rx ?? 200;
    if ((!reply && row.source != null) || status < 200 || status >= 300 || text.length === 0) return false;
    const answers = objectOf(row.rx)?.answers;
    return Array.isArray(answers) && answers.some((address) => onThread(address, thread));
};

// The events the daemon sends for one row on a Run of `thread` (plurnk-service {§agui-projection}).
export const partsOf = (row: PartRow, thread = "t"): AguiEvent[] => {
    if (speaks(row, thread)) return speechOf(row);
    const origin = row.origin ?? "model";
    if (origin === "model") return callOf(row);
    if (row.op === "SEND" && objectOf(row.attrs)?.kind === "message") return arrivalOf(row);
    if (typeof row.invocation === "string") {
        const call = /^log:\/\/\/(\d+)\/(\d+)\/(\d+)\//u.exec(row.invocation);
        if (call === null) throw new TypeError(`An invocation is an operation's log address: ${row.invocation}`);
        return dischargeOf(row, `${call[1]}/${call[2]}/${call[3]}`);
    }
    return [ambientOf(row)];
};
