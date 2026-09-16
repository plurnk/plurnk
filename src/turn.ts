import type { Component } from "@earendil-works/pi-tui";
import { renderLogEntry, type LogEntryWire } from "./render.ts";

// {§cli-plan-rendering}: current inventory above deliberate messages; operations are not buffered.
export default class TurnDisplay implements Component {
    #task: LogEntryWire | null = null;
    #responses: LogEntryWire[] = [];

    get empty(): boolean { return this.#task === null && this.#responses.length === 0; }

    setTask(entry: LogEntryWire): void { this.#task = entry; }
    addResponse(entry: LogEntryWire): void { this.#responses.push(entry); }
    invalidate(): void {}

    render(width: number): string[] {
        const entries = [...(this.#task === null ? [] : [this.#task]), ...this.#responses];
        return entries.flatMap((entry) => renderLogEntry(entry, width).split("\n"));
    }

    takeResponses(): TurnDisplay {
        const previous = new TurnDisplay();
        previous.#responses = this.#responses;
        this.#responses = [];
        return previous;
    }

    take(): TurnDisplay {
        const previous = this.takeResponses();
        previous.#task = this.#task;
        this.#task = null;
        return previous;
    }
}
