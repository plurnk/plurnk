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

// The native status names in their stable relative order ({§cli-plan-rendering}); only the
// populated ones become table columns.
export type PlanStatus = "todo" | "in_progress" | "waiting" | "completed" | "failed";
const PLAN_STATUS_ORDER: readonly PlanStatus[] = ["todo", "in_progress", "waiting", "completed", "failed"];

const entryStatus = (entry: AcpPlanEntry): PlanStatus => {
    const subtype = entry._meta?.["plurnk.xyz/status"];
    if (subtype === "waiting" && entry.status === "in_progress") return "waiting";
    if (subtype === "failed" && entry.status === "completed") return "failed";
    return entry.status === "pending" ? "todo" : entry.status;
};

const canonicalPlan = (tx: unknown) => {
    const body = (tx as { body?: unknown } | null)?.body;
    try {
        return AcpPlanValue.assertCanonical(body);
    } catch (error) {
        throw new TypeError("A TASK row must carry its canonical Plan body.", { cause: error });
    }
};

export interface PlanColumn {
    status: PlanStatus;
    entries: string[];
}

// Entries grouped under their status, source order within each column, columns in the
// stable relative order, empty columns absent.
export const planColumns = (tx: unknown): PlanColumn[] => {
    const buckets = new Map<PlanStatus, string[]>();
    for (const entry of canonicalPlan(tx).entries) {
        const status = entryStatus(entry);
        const bucket = buckets.get(status) ?? [];
        bucket.push(entryText(entry));
        buckets.set(status, bucket);
    }
    return PLAN_STATUS_ORDER.flatMap((status) => {
        const entries = buckets.get(status);
        return entries === undefined ? [] : [{ status, entries }];
    });
};

export const presentPlan = (tx: unknown): PresentedPlanEntry[] => {
    return canonicalPlan(tx).entries.map((entry) => ({
        glyph: entryGlyph(entry),
        text: entryText(entry),
    }));
};
