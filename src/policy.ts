import {
    Validator,
    type CapabilityPolicy,
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

export const formatCapabilityProjection = (projection: Readonly<Record<string, CapabilityPolicy>>): string => [
    "capabilities:",
    `  effective: ${JSON.stringify(projection.effective)}`,
    `  workspace: ${JSON.stringify(projection.workspace)}`,
    `  service: ${JSON.stringify(projection.service)}`,
    "",
].join("\n");

// A `?` prompt requests review by this client; messages carry no authority.
export const parsePrompt = (prompt: string): { reviewRequested: boolean; prompt: string } => ({
    reviewRequested: prompt.startsWith("?"),
    prompt: prompt.replace(/^(\.\.\.|[?:]+)\s*/, ""),
});
