import {
    PROPOSAL_POLICIES,
    Validator,
    type CapabilityPolicy,
    type LoopPolicyRequest,
} from "@plurnk/plurnk-contracts";

const parseJson = (label: string, raw: string): unknown => {
    try {
        return JSON.parse(raw) as unknown;
    } catch (cause) {
        throw new TypeError(`${label} must be valid JSON.`, { cause });
    }
};

export const parseCapabilityPolicy = (label: string, raw: string): CapabilityPolicy =>
    Validator.assertCapabilityPolicy(parseJson(label, raw) as CapabilityPolicy);

// {§cli-loop-policy} — the client states only what its user chose, one knob per choice:
// `--proposals` is a disposition and `--auto` is exactly "nobody is attending". Whatever is left
// unsaid is the daemon's panel's to supply, so nothing here stands in for it.
export const statedLoopPolicy = (proposals: string | undefined, auto: boolean): LoopPolicyRequest => {
    if (proposals !== undefined && !(PROPOSAL_POLICIES as readonly string[]).includes(proposals)) {
        throw new TypeError(`proposals must be one of ${PROPOSAL_POLICIES.join(", ")}.`);
    }
    return Validator.assertLoopPolicyRequest({
        ...(proposals === undefined ? {} : { proposals: proposals as NonNullable<LoopPolicyRequest["proposals"]> }),
        ...(auto ? { attended: false } : {}),
    });
};

export const formatCapabilityProjection = (projection: Readonly<Record<string, CapabilityPolicy>>): string => [
    "capabilities:",
    `  effective: ${JSON.stringify(projection.effective)}`,
    `  workspace: ${JSON.stringify(projection.workspace)}`,
    `  service: ${JSON.stringify(projection.service)}`,
    "",
].join("\n");

// A `?` prompt states review for that loop; every other prefix states nothing new.
export const promptPolicy = (
    prompt: string,
    base: LoopPolicyRequest = {},
): { policy: LoopPolicyRequest; prompt: string } => ({
    policy: prompt[0] === "?" ? { ...base, proposals: "review" } : base,
    prompt: prompt.replace(/^(\.\.\.|[?:]+)\s*/, ""),
});
