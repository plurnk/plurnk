// {§cli-plan-rendering} — a turn's TASK table stands before the turn's operation rows, so the
// model's response is what ends the turn, not its checklist. The daemon dispatches the
// disposition last; the waterfall holds a turn's model rows until its TASK arrives, then renders
// the table and the rows in authored order. A turn without a TASK releases its rows when the
// next turn's first row arrives or the loop concludes.

import type { LogEntryWire } from "./render.ts";

export default class TurnBuffer {
    #key: string | null = null;
    #rows: string[] = [];

    // Whether this entry begins a turn the buffer has not seen.
    begins(entry: LogEntryWire): boolean {
        return TurnBuffer.#keyOf(entry) !== this.#key;
    }

    // The lines to print now, in order: a previous turn's leftovers, then, on a disposition,
    // the table followed by this turn's held rows.
    admit(entry: LogEntryWire, rendered: string, disposition: boolean): string[] {
        const key = TurnBuffer.#keyOf(entry);
        const flushed = key === this.#key ? [] : this.flush();
        this.#key = key;
        if (!disposition) {
            this.#rows.push(rendered);
            return flushed;
        }
        const held = this.#rows;
        this.#rows = [];
        return [...flushed, rendered, ...held];
    }

    flush(): string[] {
        const held = this.#rows;
        this.#rows = [];
        this.#key = null;
        return held;
    }

    static #keyOf(entry: LogEntryWire): string {
        return `${entry.loop_seq}/${entry.turn_seq}`;
    }
}
