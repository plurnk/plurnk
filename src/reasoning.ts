export interface ReasoningCaller {
    call(method: string, params?: object): Promise<unknown>;
}

export interface WorkerReasoning {
    policy: string | null;
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
    const policy = reasoning.policy ?? "(unavailable)";
    const supported = reasoning.supportedPolicies.length === 0
        ? "none"
        : reasoning.supportedPolicies.join(", ");
    return `reasoning: ${policy}\nsupported: ${supported}\n`;
};
