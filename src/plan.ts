import {
    AcpPlanValue,
    type AcpPlanEntry,
} from "@plurnk/plurnk-contracts";

export const PLAN_STATUS_GLYPHS = {
    completed: "✅",
    in_progress: "🚧",
    pending: "⬜",
} as const satisfies Record<AcpPlanEntry["status"], string>;

export interface PresentedPlanEntry {
    glyph: string;
    text: string;
}

const entryText = (entry: AcpPlanEntry): string => {
    const content = entry.content.replace(/\s+/gu, " ").trim();
    return entry.priority === "medium"
        ? content
        : `[${entry.priority}] ${content}`;
};

export const presentPlan = (tx: unknown): PresentedPlanEntry[] => {
    const body = (tx as { body?: unknown } | null)?.body;
    let plan;
    try {
        plan = AcpPlanValue.assertCanonical(body);
    } catch (error) {
        throw new TypeError("A PLAN row must carry its canonical Plan body.", { cause: error });
    }
    return plan.entries.map((entry) => ({
        glyph: PLAN_STATUS_GLYPHS[entry.status],
        text: entryText(entry),
    }));
};
