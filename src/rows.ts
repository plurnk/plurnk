// {§cli-row-sources} The rows the waterfall draws, rebuilt from the standard parts a row builds: a tool call and its
// receipt, a result that answers another row's call, speech, or an arrival, each carrying the row's facts as its
// metadata (plurnk-service `{§agui-plurnk-metadata}`). A row that builds nothing in the conversation arrives whole as
// `CUSTOM plurnk.ambient`, and history whole from `log.read`; both become the same row.

import type { AguiEvent } from "./agui.ts";
import { clientTransportResultInvalid, ProblemError } from "./diagnostics.ts";
import { objectOf, type LogEntryWire } from "./render.ts";

// What metadata.plurnk names on every part a row builds; speech adds its heading's aside and its receipt.
interface Facts {
    readonly id: number;
    readonly coordinate: string;
    readonly worker: number;
    readonly origin: string;
    readonly op: string;
    readonly source: string | null;
    readonly address: string | null;
    readonly signal: unknown;
    readonly status: number;
    readonly attrs: unknown;
    readonly aside?: unknown;
    readonly receipt?: unknown;
}

const COORDINATE = /^(\d+)\/(\d+)\/(\d+)$/u;

// A part's row facts, or null for a part no row built (a client-owned interrupt's call). Facts that are present
// but unreadable are a broken wire, never a part to skip.
const factsOf = (metadata: unknown): Facts | null => {
    const plurnk = objectOf(metadata)?.plurnk;
    if (plurnk === undefined) return null;
    const facts = objectOf(plurnk);
    if (facts === null || !Number.isSafeInteger(facts.id) || typeof facts.coordinate !== "string" || !COORDINATE.test(facts.coordinate)
        || !Number.isSafeInteger(facts.worker) || typeof facts.origin !== "string" || typeof facts.op !== "string"
        || !(facts.source === null || typeof facts.source === "string") || !(facts.address === null || typeof facts.address === "string")
        || !Number.isSafeInteger(facts.status)) {
        throw new ProblemError(clientTransportResultInvalid("A part's row facts are not { id, coordinate, worker, origin, op, source, address, signal, status, attrs }."));
    }
    return facts as unknown as Facts;
};

// A wire field as its value: JSON text parsed, any other text as it is.
const valueOf = (text: string): unknown => {
    if (text.length === 0) return null;
    try { return JSON.parse(text) as unknown; } catch { return text; }
};

// A SEND body is `{ raw, json }`, json being the best-effort parse the daemon's parser makes of raw; others are text.
const bodyOf = (op: string, content: string): unknown =>
    op === "SEND" ? { raw: content, json: (() => { try { return JSON.parse(content) as unknown; } catch { return null; } })() } : content;

const lineMarkerOf = (tx: unknown): LogEntryWire["lineMarker"] => {
    const statement = objectOf(tx);
    const marker = objectOf(statement?.lineMarker) ?? objectOf(objectOf(statement?.source)?.lineMarker);
    return Array.isArray(marker?.marks) ? marker as LogEntryWire["lineMarker"] : null;
};

const rowOf = (facts: Facts, tx: unknown, rx: unknown): LogEntryWire => {
    const [, loop, turn, sequence] = COORDINATE.exec(facts.coordinate)!;
    return {
        id: facts.id, worker_id: facts.worker, origin: facts.origin, op: facts.op, source: facts.source,
        signal: facts.signal, status_rx: facts.status, attrs: facts.attrs, tx, rx,
        target: facts.address, lineMarker: lineMarkerOf(tx),
        loop_seq: Number(loop), turn_seq: Number(turn), sequence: Number(sequence),
    };
};

// {§agui-call-result} A call that opened an obligation is answered by what discharges it, never by its receipt.
const opensObligation = (facts: Facts): boolean => {
    const attrs = objectOf(facts.attrs);
    return (typeof attrs?.stream === "string" || typeof attrs?.message === "string") && facts.status < 400;
};

// The address a whole row recorded, composed as its parts' facts name it (plurnk-service `{§agui-plurnk-metadata}`):
// `scheme://host[:port]path[?query][#fragment]`, or the bare path a file target records, with its channel.
const addressOf = (row: Record<string, unknown>): string | null => {
    const text = (value: unknown): string | null => typeof value === "string" ? value : null;
    const pathname = text(row.pathname);
    if (pathname === null) return null;
    const fragment = text(row.fragment) === null ? "" : `#${text(row.fragment)}`;
    const scheme = text(row.scheme);
    if (scheme === null) return `${pathname}${fragment}`;
    const port = typeof row.port === "number" ? `:${row.port}` : "";
    const query = text(row.query) === null ? "" : `?${text(row.query)}`;
    return `${scheme}://${text(row.hostname) ?? ""}${port}${pathname}${query}${fragment}`;
};

// A whole row, as plurnk.ambient and log.read carry it; null for an actionless row, which draws nothing.
export const wholeRow = (value: unknown): LogEntryWire | null => {
    const row = objectOf(value);
    if (row === null || !Number.isSafeInteger(row.id)) throw new ProblemError(clientTransportResultInvalid("A whole row carries its durable id."));
    if (typeof row.op !== "string") return null;
    return {
        id: row.id as number, worker_id: row.worker_id as number, origin: row.origin as string, op: row.op,
        source: (row.source ?? null) as string | null, signal: row.signal, status_rx: row.status_rx as number,
        attrs: row.attrs, tx: row.tx, rx: row.rx,
        target: addressOf(row), lineMarker: (row.lineMarker ?? null) as LogEntryWire["lineMarker"],
        loop_seq: row.loop_seq as number, turn_seq: row.turn_seq as number, sequence: row.sequence as number,
    };
};

// One Run's stream, one assembler: a row's events arrive together, so a part opened and never finished is a broken wire.
export default class RowAssembler {
    #calls = new Map<string, { facts: Facts; args: string; ended: boolean }>();
    #texts = new Map<string, { facts: Facts; content: string }>();

    // One standard event in; the rows it completes out.
    consume(e: AguiEvent): LogEntryWire[] {
        switch (e.type) {
            case "TOOL_CALL_START": {
                this.#unanswered();
                const facts = factsOf(e.metadata);
                if (facts !== null) this.#calls.set(e.toolCallId, { facts, args: "", ended: false });
                return [];
            }
            case "TOOL_CALL_ARGS": {
                const call = this.#calls.get(e.toolCallId);
                if (call !== undefined) call.args += e.delta;
                return [];
            }
            case "TOOL_CALL_END": {
                const call = this.#calls.get(e.toolCallId);
                if (call === undefined) return [];
                call.ended = true;
                if (!opensObligation(call.facts)) return [];
                this.#calls.delete(e.toolCallId);
                return [rowOf(call.facts, this.#statement(call.args), null)];
            }
            case "TOOL_CALL_RESULT": {
                const facts = factsOf(e.metadata);
                if (facts === null) return [];
                // The daemon answers a call in text: its receipt as JSON, or the words a reply delivered.
                if (typeof e.content !== "string") throw new ProblemError(clientTransportResultInvalid(`The result for ${e.toolCallId} is not text.`));
                const call = this.#calls.get(e.toolCallId);
                if (call?.ended === true && call.facts.id === facts.id) {
                    this.#calls.delete(e.toolCallId);
                    return [rowOf(facts, this.#statement(call.args), valueOf(e.content))];
                }
                this.#unanswered();
                // {§agui-call-result} What another row delivered for the call: a reply's words, or what was observed.
                return [facts.op === "SEND" ? rowOf(facts, { body: bodyOf("SEND", e.content) }, null) : rowOf(facts, null, valueOf(e.content))];
            }
            case "TEXT_MESSAGE_START": {
                this.#unanswered();
                const facts = factsOf(e.metadata);
                if (facts !== null) this.#texts.set(e.messageId, { facts, content: "" });
                return [];
            }
            case "TEXT_MESSAGE_CONTENT": {
                const text = this.#texts.get(e.messageId);
                if (text !== undefined) text.content += e.delta;
                return [];
            }
            case "TEXT_MESSAGE_END": {
                const text = this.#texts.get(e.messageId);
                if (text === undefined) return [];
                this.#texts.delete(e.messageId);
                const { facts, content } = text;
                // Speech carries its heading's aside and its receipt; an arrival is the message it delivered.
                const aside = typeof facts.aside === "string" ? { aside: facts.aside } : {};
                return [rowOf(facts, { ...aside, body: bodyOf(facts.op, content) }, facts.receipt ?? null)];
            }
            default:
                return [];
        }
    }

    // A call's arguments are its statement as authored, without the verb its name carries (plurnk-service `{§agui-projection}`).
    #statement(args: string): unknown {
        try {
            return JSON.parse(args.length === 0 ? "{}" : args) as unknown;
        } catch (cause) {
            throw new ProblemError(clientTransportResultInvalid(`A call's arguments are not JSON: ${String(cause)}`));
        }
    }

    // {§agui-call-result} A call that opened no obligation is answered by its receipt before anything else is built.
    #unanswered(): void {
        for (const [id, call] of this.#calls) {
            if (call.ended) throw new ProblemError(clientTransportResultInvalid(`The call ${id} ended without its receipt.`));
        }
    }
}
