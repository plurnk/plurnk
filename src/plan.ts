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

const entryGlyph = (entry: AcpPlanEntry): string => {
    const subtype = entry._meta?.["plurnk.xyz/status"];
    if (subtype === "waiting" && entry.status === "in_progress") return "💤";
    if (subtype === "failed" && entry.status === "completed") return "✋";
    return PLAN_STATUS_GLYPHS[entry.status];
};

export const presentPlan = (tx: unknown): PresentedPlanEntry[] => {
    const body = (tx as { body?: unknown } | null)?.body;
    let plan;
    try {
        plan = AcpPlanValue.assertCanonical(body);
    } catch (error) {
        throw new TypeError("A TASK row must carry its canonical Plan body.", { cause: error });
    }
    return plan.entries.map((entry) => ({
        glyph: entryGlyph(entry),
        text: entryText(entry),
    }));
};
