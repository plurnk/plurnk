import {
    ACP_MEMORY_PREFIX,
    type AcpPlan,
    type AcpPlanEntry,
    type Plan,
    type PlanEntry,
} from "@plurnk/plurnk-contracts";

export const PLAN_STATUS_GLYPHS = {
    completed: "✅",
    in_progress: "🚧",
    memory: "💾",
    pending: "⬜",
} as const satisfies Record<PlanEntry["status"], string>;

export interface PresentedPlanEntry {
    glyph: string;
    text: string;
}

type PresentablePlanEntry = PlanEntry | AcpPlanEntry;

const isProjectedMemory = (entry: PresentablePlanEntry): entry is AcpPlanEntry => (
    entry.status === "completed" && entry.content.startsWith(ACP_MEMORY_PREFIX)
);

const entryText = (entry: PresentablePlanEntry): string => {
    const raw = isProjectedMemory(entry) ? entry.content.slice(ACP_MEMORY_PREFIX.length) : entry.content;
    const content = raw.replace(/\s+/gu, " ").trim();
    return entry.priority === "medium"
        ? content
        : `[${entry.priority}] ${content}`;
};

export const presentPlan = (tx: unknown): PresentedPlanEntry[] => {
    const plan = (tx as { body?: Plan | AcpPlan } | null)?.body;
    if (plan === undefined) {
        throw new TypeError("A PLAN row must carry its canonical Plan body.");
    }
    return plan.entries.map((entry) => ({
        glyph: entry.status === "memory" || isProjectedMemory(entry)
            ? PLAN_STATUS_GLYPHS.memory
            : PLAN_STATUS_GLYPHS[entry.status],
        text: entryText(entry),
    }));
};
