import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";

// A live region that shows only the newest lines of its text, overwriting itself as the
// text grows: the reasoning scroll. Nothing here is durable; the transcript is the record.
export default class TailText implements Component {
    #text = "";
    readonly #maxLines: () => number;

    constructor(maxLines: () => number) {
        this.#maxLines = maxLines;
    }

    setText(text: string): void {
        this.#text = text;
    }

    // Nothing is cached: every render wraps the current text at the current width.
    invalidate(): void {}

    render(width: number): string[] {
        if (this.#text.length === 0) return [];
        const lines = this.#text.split("\n").flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
        const max = Math.max(1, this.#maxLines());
        return lines.length <= max ? lines : lines.slice(lines.length - max);
    }
}
