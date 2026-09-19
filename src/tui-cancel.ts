// The interrupt latch for one run, extracted from runTui so it's testable ({§cli-cancellation}).
// Ctrl-C and Esc share it: the first gesture of a run fires loop.cancel and arms the exit, and
// every Ctrl-C after that exits. "ctrl-c again to quit" is a promise, so a FAILED cancel NEVER
// re-arms the latch — re-arming it made every Ctrl-C fire another cancel at a daemon that was not
// there to receive it, and the only way out was Ctrl-D (#90). An explicit /stop still retries: it
// calls loop.cancel directly, outside the latch.
//
// A cancel that never reached the daemon is not a cancel the user can retry: there is nothing on
// the other end to receive it. The client names what it could not deliver and closes itself — the
// same local teardown Ctrl-D performs. A cancel the daemon refused is the daemon's own answer: it
// surfaces, the session continues, and the armed exit is one keystroke away.
import { isUnreachable } from "./diagnostics.ts";

interface CancelPort {
    cancel(reason: string): Promise<unknown>;
    print(line: string): void;
    close(): void;
}

export default class CancelGesture {
    #requested = false;
    readonly #port: CancelPort;

    constructor(port: CancelPort) {
        this.#port = port;
    }

    // True once this run has been asked to cancel: the next interrupt exits.
    get requested(): boolean {
        return this.#requested;
    }

    // The run ended (cancelled or not) — the next interrupt is a fresh first gesture.
    release(): void {
        this.#requested = false;
    }

    request(reason: string): void {
        if (this.#requested) return;
        this.#requested = true;
        this.#port.print("  \x1b[2mcancelling… (ctrl-c again to quit)\x1b[0m");
        void this.#port.cancel(reason).catch((cause: unknown) => {
            const detail = cause instanceof Error ? cause.message : String(cause);
            if (!isUnreachable(cause)) {
                this.#port.print(`  \x1b[31mcancel failed: ${detail}\x1b[0m`);
                return;
            }
            this.#port.print(`  \x1b[31mcancel not delivered: the daemon is unreachable (${detail}) — closing this client\x1b[0m`);
            this.#port.close();
        });
    }
}
