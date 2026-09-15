// The human's inspection of a resource ({§cli-inspection}). `/look <address> [<scope>] [pattern]`
// composes the LOOK fence the daemon's `op.look` observation action admits; the readout is a
// local human record printed above the composer — never a loop, a log entry, a summary, or a
// lifecycle transition, and never a wait on the model.

import type { OperationResult } from "@plurnk/plurnk-contracts";
import { colorEnabled } from "./color.ts";
import ModelText from "./model-text.ts";

const useColor = colorEnabled();
const code = (n: string): string => useColor ? `\x1b[${n}m` : "";
const RESET = code("0");
const DIM = code("2");
const PINK = code("95");

export type LookResult = OperationResult & { content?: unknown; detail?: unknown };

// `/look worker:///plan.md <1,20> /needle/` → the LOOK fence with the address in its
// parentheses; an address the user already parenthesized passes through. Nothing to look at
// is null.
export const lookFence = (rest: string): string | null => {
    const text = rest.trim();
    if (text.length === 0) return null;
    const heading = text.startsWith("(") ? text : text.replace(/^(\S+)/u, "($1)");
    return `\`\`\`LOOK ${heading}\`\`\``;
};

// The heading as submitted, without its fence: `LOOK (worker:///plan.md) <1,20>`.
export const lookHeading = (fence: string): string => {
    const inner = fence.replace(/^`{3,}/u, "").replace(/`{3,}\s*$/u, "");
    const [heading] = inner.split("\n");
    return (heading ?? "").trim();
};

// The readout: the heading, then the content verbatim; an empty result says so in the
// daemon's words; an unsuccessful one names the Problem title, its detail and recovery beneath.
export const renderLook = (fence: string, result: LookResult): string => {
    const heading = `${DIM}${ModelText.plain(lookHeading(fence))}${RESET}`;
    const status = result.status ?? 0;
    const detail = typeof result.detail === "string" && result.detail.length > 0 ? result.detail : null;
    if (status >= 400) {
        const problem = result.problem;
        const title = typeof problem?.title === "string" && problem.title.length > 0 ? problem.title : detail ?? String(status);
        const lines = [`${heading} — ${PINK}${ModelText.plain(title)}${RESET}`];
        if (typeof problem?.detail === "string" && problem.detail.length > 0) lines.push(`  ${DIM}${ModelText.plain(problem.detail)}${RESET}`);
        const recovery = (problem as { recovery?: unknown } | undefined)?.recovery;
        if (typeof recovery === "string" && recovery.length > 0) lines.push(`  ${DIM}${ModelText.plain(recovery)}${RESET}`);
        return lines.join("\n");
    }
    const content = typeof result.content === "string" ? result.content : "";
    if (content.length === 0) return `${heading} — ${DIM}${ModelText.plain(detail ?? "(empty)")}${RESET}`;
    return `${heading}\n${ModelText.plain(content).replace(/\n$/u, "")}`;
};
