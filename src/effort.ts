export interface EffortCaller {
    call(method: string, params?: object): Promise<unknown>;
}

export interface WorkerEffort {
    effort: string | null;
    // {§cli-identity-effort} — the daemon's provenance for `effort`.
    source: "default" | "explicit";
    supportedEfforts: string[];
}

export const readWorkerEffort = async (rpc: EffortCaller): Promise<WorkerEffort> =>
    await rpc.call("worker.effort.get") as WorkerEffort;

export const setWorkerEffort = async (
    rpc: EffortCaller,
    effort: string,
): Promise<WorkerEffort> =>
    await rpc.call("worker.effort.set", { effort }) as WorkerEffort;

export const formatWorkerEffort = (worker: WorkerEffort): string => {
    const provenance = worker.effort === null
        ? ""
        : worker.source === "explicit" ? " (chosen with /effort)" : " (provider default)";
    const effort = worker.effort === null ? "(unavailable)" : `${worker.effort}${provenance}`;
    const supported = worker.supportedEfforts.length === 0
        ? "none"
        : worker.supportedEfforts.join(", ");
    return `effort: ${effort}\nsupported: ${supported}\n`;
};
