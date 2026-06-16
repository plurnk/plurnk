// Bracketed-paste buffering for the readline TUI.
//
// Terminals wrap pasted text in ESC[200~ … ESC[201~ when ?2004 is enabled.
// Node readline doesn't understand this, so a multi-line paste fires one
// 'line' event (one loop.run) per pasted line — the bug. We interpose on
// stdin and collapse a multi-line paste into a single short marker
// (`[paste #N +K lines]`) so readline stays on one line (NO cursor/width
// math — the marker is a normal short token); on submit the marker expands
// back to the raw text. Single-line pastes pass straight through.
//
// We don't heuristically test paste size (pi does); the terminal's markers
// tell us exactly where a paste is — "always catch as []".

const START = "\x1b[200~";
const END = "\x1b[201~";
const MARKER = /\[paste #(\d+) \+\d+ lines\]/g;

// Longest suffix of `s` that is a proper prefix of `marker` — bytes to hold
// back in case a marker is split across reads.
const partialTail = (s: string, marker: string): number => {
    const max = Math.min(s.length, marker.length - 1);
    for (let n = max; n > 0; n--) {
        if (marker.startsWith(s.slice(s.length - n))) return n;
    }
    return 0;
};

export default class PasteFilter {
    #state: "normal" | "pasting" = "normal";
    #paste = "";
    #carry = "";
    #store = new Map<number, string>();
    #nextId = 1;

    // Process a stdin chunk; return the bytes readline should see (multi-line
    // pastes collapsed to markers). Completed pastes are stored for expand().
    feed(chunk: string): string {
        let input = this.#carry + chunk;
        this.#carry = "";
        let out = "";
        for (;;) {
            if (this.#state === "normal") {
                const i = input.indexOf(START);
                if (i >= 0) {
                    out += input.slice(0, i);
                    input = input.slice(i + START.length);
                    this.#state = "pasting";
                    this.#paste = "";
                    continue;
                }
                const hold = partialTail(input, START);
                out += input.slice(0, input.length - hold);
                this.#carry = input.slice(input.length - hold);
                return out;
            }
            const j = input.indexOf(END);
            if (j >= 0) {
                this.#paste += input.slice(0, j);
                input = input.slice(j + END.length);
                this.#state = "normal";
                out += this.#emit(this.#paste);
                this.#paste = "";
                continue;
            }
            const hold = partialTail(input, END);
            this.#paste += input.slice(0, input.length - hold);
            this.#carry = input.slice(input.length - hold);
            return out;
        }
    }

    // Single-line paste passes through verbatim (readline handles it). A
    // multi-line paste becomes a one-line marker expand() restores. CR/CRLF
    // are normalized to LF so a lone CR can't sneak a submit past readline.
    #emit(raw: string): string {
        const paste = raw.replace(/\r\n?/g, "\n");
        if (!paste.includes("\n")) return paste;
        const id = this.#nextId++;
        this.#store.set(id, paste);
        return `[paste #${id} +${paste.split("\n").length} lines]`;
    }

    // Replace paste markers in a submitted line with their stored text.
    // Unknown ids (user edited the marker) are left literal.
    expand(line: string): string {
        return line.replace(MARKER, (m, idStr) => {
            const id = Number(idStr);
            const stored = this.#store.get(id);
            if (stored === undefined) return m;
            this.#store.delete(id);
            return stored;
        });
    }
}
