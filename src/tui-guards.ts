// The surface puts the terminal in raw mode with bracketed paste and the kitty keyboard
// protocol pushed; only `stop()` pops them. Every way out of the process — a signal, an
// escaped throw, a rejection nobody caught — restores the terminal first (plurnk#35). The
// surface's stop is idempotent, so the run's own `finally` and these guards never conflict.
type GuardedProcess = Pick<NodeJS.Process, "once" | "off" | "exit">;

export default class TerminalGuards {
    static install(surface: { stop(): void }, proc: GuardedProcess = process): () => void {
        const onSigterm = (): void => { surface.stop(); proc.exit(143); };
        const onSighup = (): void => { surface.stop(); proc.exit(129); };
        const onFatal = (error: unknown): void => { surface.stop(); console.error(error); proc.exit(1); };
        proc.once("SIGTERM", onSigterm);
        proc.once("SIGHUP", onSighup);
        proc.once("uncaughtException", onFatal);
        proc.once("unhandledRejection", onFatal);
        return () => {
            proc.off("SIGTERM", onSigterm);
            proc.off("SIGHUP", onSighup);
            proc.off("uncaughtException", onFatal);
            proc.off("unhandledRejection", onFatal);
        };
    }
}
