import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { type LogEntryWire } from "./render.ts";
import { renderLogEntry } from "./render-message.ts";

interface Response {
    entry: LogEntryWire;
    projection?: { width: number; lines: string[] };
}

// {§cli-response-order}: deliberate responses remain below the live reasoning lane.
export default class TurnDisplay implements Component {
    #responses: Response[] = [];

    get empty(): boolean { return this.#responses.length === 0; }

    addResponse(entry: LogEntryWire): void { this.#responses.push({ entry }); }
    invalidate(): void { for (const response of this.#responses) response.projection = undefined; }

    render(width: number): string[] {
        return this.#responses.flatMap((response) => {
            if (response.projection?.width !== width) {
                response.projection = { width, lines: wrapTextWithAnsi(renderLogEntry(response.entry, width), Math.max(1, width)) };
            }
            return response.projection.lines;
        });
    }

    take(): TurnDisplay {
        const previous = new TurnDisplay();
        previous.#responses = this.#responses;
        this.#responses = [];
        return previous;
    }

}
