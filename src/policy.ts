import {
    DEFAULT_LOOP_POLICY,
    Validator,
    type CapabilityPolicy,
    type LoopPolicy,
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

export const parseLoopPolicy = (label: string, raw: string): LoopPolicy => {
    const parsed = parseJson(label, raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new TypeError(`${label} must be a JSON object.`);
    }
    const partial = parsed as Partial<LoopPolicy>;
    if (Object.keys(partial).some((key) => key !== "proposals")) {
        throw new TypeError(`${label} contains an unsupported field.`);
    }
    return Validator.assertLoopPolicy({
        proposals: partial.proposals ?? DEFAULT_LOOP_POLICY.proposals,
    });
};

export const composeLoopPolicy = (
    base: LoopPolicy = DEFAULT_LOOP_POLICY,
    proposals: LoopPolicy["proposals"] = base.proposals,
): LoopPolicy => Validator.assertLoopPolicy({
    proposals,
});

export const resolveLoopPolicy = (raw: string | undefined, auto = false): LoopPolicy => {
    const base = raw === undefined ? DEFAULT_LOOP_POLICY : parseLoopPolicy("--policy", raw);
    return composeLoopPolicy(base, auto ? "accept" : base.proposals);
};

export const formatCapabilityProjection = (projection: Readonly<Record<string, CapabilityPolicy>>): string => [
    "capabilities:",
    `  effective: ${JSON.stringify(projection.effective)}`,
    `  workspace: ${JSON.stringify(projection.workspace)}`,
    `  service: ${JSON.stringify(projection.service)}`,
    "",
].join("\n");

export const promptPolicy = (
    prompt: string,
    base: LoopPolicy = DEFAULT_LOOP_POLICY,
): { policy: LoopPolicy; prompt: string } => {
    const prefix = prompt[0];
    return {
        policy: prefix === "?"
            ? composeLoopPolicy(base, "review")
            : base,
        prompt: prompt.replace(/^(\.\.\.|[?:]+)\s*/, ""),
    };
};
