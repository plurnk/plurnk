import { isExecutionOp } from "@plurnk/plurnk-contracts";
import Knobs, { KnobError } from "./knobs.ts";
import type { Notice } from "./diagnostics.ts";
import type { ProposalParams, Resolution } from "./proposal.ts";

const PREFIX = "PLURNK_CLIENT_ACCEPT_";
type Rule = { enabled: boolean; tools: ReadonlySet<string> | null };

// {§cli-tool-acceptance} This is the client's answer to a proposal, never an effect or permission.
export default class ToolAcceptance {
    #rules = new Map<string, Rule>();

    constructor(notify: (notice: Notice) => void, environment: NodeJS.ProcessEnv = process.env) {
        try {
            const keys = Object.keys(environment).filter((key) => key.startsWith(PREFIX));
            for (const key of keys) {
                const suffix = key.slice(PREFIX.length);
                const alias = suffix.endsWith("_TOOLS") ? suffix.slice(0, -6) : suffix;
                const runtime = alias.replaceAll("_", "-");
                if (alias.includes("-") || !isExecutionOp(runtime)) {
                    throw new KnobError(key, environment[key] ?? "", "must name a lowercase runtime (underscores encode hyphens), optionally followed by _TOOLS.");
                }
                const switchKey = `${PREFIX}${alias}`;
                const toolsKey = `${switchKey}_TOOLS`;
                const rawTools = environment[toolsKey];
                let tools: ReadonlySet<string> | null = null;
                if (rawTools !== undefined) {
                    let value: unknown;
                    try { value = JSON.parse(rawTools); }
                    catch (cause) { throw new KnobError(toolsKey, rawTools, "must be a JSON array of exact tool names.", { cause }); }
                    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) {
                        throw new KnobError(toolsKey, rawTools, "must be a JSON array of exact tool names.");
                    }
                    tools = new Set(value as string[]);
                }
                this.#rules.set(runtime, { enabled: Knobs.flag(switchKey, "optional", environment), tools });
            }
        } catch (cause) {
            if (!(cause instanceof KnobError)) throw cause;
            this.#rules.clear();
            notify({
                source: "client:proposal", kind: "acceptance-unavailable", level: "warn",
                message: `${cause.message} Configured tool acceptance is disabled.`,
                knob: cause.knob, cause,
            });
        }
    }

    get enabled(): boolean {
        return [...this.#rules.values()].some(({ enabled, tools }) => enabled && (tools === null || tools.size > 0));
    }

    resolve(proposal: ProposalParams, options: { yolo: boolean; reviewRequested?: boolean; noReviewChannel?: boolean }): Resolution | null {
        if (options.reviewRequested !== true) {
            if (options.yolo) return { decision: "accept", outcome: "client_yolo" };
            const rule = this.#rules.get(proposal.op);
            if (rule?.enabled === true) {
                if (rule.tools === null) return { decision: "accept", outcome: `auto: ${proposal.op}` };
                const attrs = proposal.attrs as { runtime?: unknown; target?: unknown; resourceSource?: unknown } | null;
                if (attrs?.runtime === proposal.op && typeof attrs.target === "string"
                    && attrs.resourceSource === undefined && rule.tools.has(attrs.target)) {
                    return { decision: "accept", outcome: `auto: ${proposal.op} (${attrs.target})` };
                }
            }
        }
        return options.noReviewChannel === true ? { decision: "reject", outcome: "client_no_review_channel" } : null;
    }
}
