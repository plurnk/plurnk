import {
    ACP_MEMORY_PREFIX,
    AcpPlanValue,
    type AcpPlanEntry,
} from "@plurnk/plurnk-contracts";

export const PLAN_STATUS_GLYPHS = {
    completed: "✅",
    in_progress: "🚧",
    memory: "💾",
    pending: "⬜",
} as const satisfies Record<AcpPlanEntry["status"] | "memory", string>;

export interface PresentedPlanEntry {
    glyph: string;
    text: string;
}

const isProjectedMemory = (entry: AcpPlanEntry): boolean => (
    entry.status === "completed" && entry.content.startsWith(ACP_MEMORY_PREFIX)
);

const entryText = (entry: AcpPlanEntry): string => {
    const raw = isProjectedMemory(entry) ? entry.content.slice(ACP_MEMORY_PREFIX.length) : entry.content;
    const content = raw.replace(/\s+/gu, " ").trim();
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
        glyph: PLAN_STATUS_GLYPHS[isProjectedMemory(entry) ? "memory" : entry.status],
        text: entryText(entry),
    }));
};
