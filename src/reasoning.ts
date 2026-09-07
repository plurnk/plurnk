export interface ReasoningCaller {
    call(method: string, params?: object): Promise<unknown>;
}

export interface WorkerReasoning {
    policy: string | null;
    // {§cli-identity-effort} — the daemon's provenance for `policy`; absent on older daemons.
    source?: "default" | "explicit";
    supportedPolicies: string[];
}

export const readWorkerReasoning = async (rpc: ReasoningCaller): Promise<WorkerReasoning> =>
    await rpc.call("worker.reasoning.get") as WorkerReasoning;

export const setWorkerReasoning = async (
    rpc: ReasoningCaller,
    policy: string,
): Promise<WorkerReasoning> =>
    await rpc.call("worker.reasoning.set", { policy }) as WorkerReasoning;

export const formatWorkerReasoning = (reasoning: WorkerReasoning): string => {
    const provenance = reasoning.policy === null || reasoning.source === undefined
        ? ""
        : reasoning.source === "explicit" ? " (chosen with /reasoning)" : " (provider default)";
    const policy = reasoning.policy === null ? "(unavailable)" : `${reasoning.policy}${provenance}`;
    const supported = reasoning.supportedPolicies.length === 0
        ? "none"
        : reasoning.supportedPolicies.join(", ");
    return `reasoning: ${policy}\nsupported: ${supported}\n`;
};
