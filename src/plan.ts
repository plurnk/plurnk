import type { Plan, PlanEntry } from "@plurnk/plurnk-contracts";

export const PLAN_STATUS_GLYPHS = {
    completed: "✅",
    in_progress: "🚧",
    pending: "⬜",
} as const satisfies Record<PlanEntry["status"], string>;

export interface PresentedPlanEntry {
    glyph: string;
    text: string;
}

const entryText = (entry: PlanEntry): string => {
    const content = entry.content.replace(/\s+/gu, " ").trim();
    return entry.priority === "medium"
        ? content
        : `[${entry.priority}] ${content}`;
};

export const presentPlan = (tx: unknown): PresentedPlanEntry[] => {
    const plan = (tx as { body?: Plan } | null)?.body;
    if (plan === undefined) {
        throw new TypeError("A PLAN row must carry its canonical ACP Plan body.");
    }
    return plan.entries.map((entry) => ({
        glyph: PLAN_STATUS_GLYPHS[entry.status],
        text: entryText(entry),
    }));
};
