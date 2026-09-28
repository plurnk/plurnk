// The surface puts the terminal in raw mode with bracketed paste and the kitty keyboard
// protocol pushed; only `stop()` pops them. Every way out of the process — a signal, an
// escaped throw, a rejection nobody caught — restores the terminal first (plurnk#35). The
// surface's stop is idempotent, so the run's own `finally` and these guards never conflict.
import type Lifetime from "./lifetime.ts";
import { signalExitCode } from "./lifetime.ts";

type GuardedProcess = Pick<NodeJS.Process, "once" | "off">;

export default class TerminalGuards {
    static install(surface: { stop(): void }, lifetime: Lifetime, proc: GuardedProcess = process): () => void {
        const releaseSignals = lifetime.handleSignals((signal) => {
            surface.stop();
            void lifetime.exit(signalExitCode(signal));
        });
        const onFatal = (error: unknown): void => { surface.stop(); console.error(error); void lifetime.exit(1); };
        proc.once("uncaughtException", onFatal);
        proc.once("unhandledRejection", onFatal);
        return () => {
            releaseSignals();
            proc.off("uncaughtException", onFatal);
            proc.off("unhandledRejection", onFatal);
        };
    }
}
