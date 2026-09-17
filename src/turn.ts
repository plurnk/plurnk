import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { type LogEntryWire } from "./render.ts";
import { renderLogEntry } from "./render-message.ts";

// {§cli-response-order}: deliberate responses remain below the live reasoning lane.
export default class TurnDisplay implements Component {
    #responses: LogEntryWire[] = [];

    get empty(): boolean { return this.#responses.length === 0; }

    addResponse(entry: LogEntryWire): void { this.#responses.push(entry); }
    invalidate(): void {}

    render(width: number): string[] {
        return this.#responses.flatMap((entry) => wrapTextWithAnsi(renderLogEntry(entry, width), Math.max(1, width)));
    }

    take(): TurnDisplay {
        const previous = new TurnDisplay();
        previous.#responses = this.#responses;
        this.#responses = [];
        return previous;
    }

}
