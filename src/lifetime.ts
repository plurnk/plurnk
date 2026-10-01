// {§cli-daemon-autostart} — process termination waits for invocation-owned resources.
// A foreground surface may handle interrupts first (for example, flushing a CLI record).
// Before and after that surface, the same owner handles interruption during admission.
const EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
export type ExitSignal = keyof typeof EXIT_CODES;
export const signalExitCode = (signal: ExitSignal): number => EXIT_CODES[signal];
type OwnedProcess = Pick<NodeJS.Process, "on" | "off" | "exit">;

export default class Lifetime {
    readonly #resources = new AsyncDisposableStack();
    readonly #listeners = new Map<ExitSignal, () => void>();
    #handler: ((signal: ExitSignal) => void) | null = null;
    #closing: Promise<void> | undefined;
    #interrupted = false;
    readonly #process: OwnedProcess;
    readonly #abort = new AbortController();

    constructor(proc: OwnedProcess = process) {
        this.#process = proc;
        for (const signal of Object.keys(EXIT_CODES) as ExitSignal[]) {
            const listener = (): void => {
                if (this.#handler !== null) this.#handler(signal);
                else void this.exit(EXIT_CODES[signal]);
            };
            this.#listeners.set(signal, listener);
            proc.on(signal, listener);
        }
    }

    own<T extends AsyncDisposable>(pending: Promise<T>): Promise<T> {
        this.#resources.defer(async () => {
            // The awaiting caller reports acquisition failure. The service launcher already
            // cleans failed startup; only a successfully returned resource needs releasing.
            const resource = await pending.catch(() => null);
            if (resource !== null) await resource[Symbol.asyncDispose]();
        });
        return pending.then((resource) => {
            if (this.#closing !== undefined) throw new DOMException("The client stopped during backend startup.", "AbortError");
            return resource;
        });
    }

    get interrupted(): boolean { return this.#interrupted; }
    get signal(): AbortSignal { return this.#abort.signal; }

    handleSignals(handler: (signal: ExitSignal) => void): () => void {
        if (this.#handler !== null) throw new Error("Two foreground surfaces cannot own process interruption.");
        this.#handler = handler;
        return () => { this.#handler = null; };
    }

    close(): Promise<void> {
        return this.#closing ??= (async () => {
            this.#abort.abort();
            try { await this.#resources.disposeAsync(); }
            finally {
                for (const [signal, listener] of this.#listeners) this.#process.off(signal, listener);
            }
        })();
    }

    [Symbol.asyncDispose](): Promise<void> { return this.close(); }

    async exit(code: number): Promise<never> {
        this.#interrupted = true;
        try { await this.close(); }
        catch (cause) { console.error("Client shutdown failed:", cause); this.#process.exit(1); }
        this.#process.exit(code);
    }
}
