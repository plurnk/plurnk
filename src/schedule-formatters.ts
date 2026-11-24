// {§cli-configuration-source} Schedule & macro output formatters, step receipt projection,
// and structured problem extraction (`409 already-done` reopen hint).

import type { ScheduledStepReceipt } from "./acp-client.ts";

export interface ScheduleUsageProblem {
    readonly type: string;
    readonly title: string;
    readonly status: number;
    readonly detail: string;
    readonly recovery?: string;
}

export class ScheduleCommandUsageError extends Error {
    readonly problem: ScheduleUsageProblem;

    constructor(title: string, detail: string, recovery?: string) {
        super(detail);
        this.name = "ScheduleCommandUsageError";
        this.problem = {
            type: "https://problems.plurnk.xyz/client/usage",
            title,
            status: 400,
            detail,
            ...(recovery !== undefined ? { recovery } : {}),
        };
    }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const summarizeStepChain = (steps: readonly unknown[]): string => {
    const names = steps.filter(isRecord).map((step) => {
        const srv = typeof step.server === "string" ? step.server : "?";
        const tool = typeof step.tool === "string" ? step.tool : "?";
        return `${srv}.${tool}`;
    });
    if (names.length === 0) return "0 steps";
    const chain = names.length <= 3 ? names.join(" → ") : `${names.slice(0, 3).join(" → ")} +${String(names.length - 3)}`;
    return `${String(names.length)} ${names.length === 1 ? "step" : "steps"}: ${chain}`;
};

const summarizeScheduleAction = (def: Record<string, unknown>): string => {
    if (Array.isArray(def.run)) {
        return summarizeStepChain(def.run);
    }
    const target = typeof def.target === "string" ? def.target : "";
    const persona = typeof def.persona === "string" && def.persona.length > 0 ? ` (${def.persona})` : "";
    const prompt = typeof def.prompt === "string" ? def.prompt.trim().replace(/\s+/gu, " ") : "";
    const clipped = prompt.length > 60 ? `${prompt.slice(0, 59)}…` : prompt;
    return [target.length > 0 ? `${target}${persona}` : "", clipped].filter((p) => p.length > 0).join(" · ");
};

const compactRuleLabel = (def: Record<string, unknown>, detail: Record<string, unknown>): string => {
    const rule = typeof detail.rule === "string"
        ? detail.rule
        : typeof def.rule === "string"
          ? def.rule
          : "manual";
    const compactRule = rule.includes("\n")
        ? (typeof detail.text === "string" && detail.text.length > 0 ? detail.text : rule.split(/\r?\n/u).join("; "))
        : rule;
    const next = typeof detail.next === "string" && detail.next.length > 0 ? ` (next ${detail.next})` : "";
    return `${compactRule}${next}`;
};

export const formatScheduleRows = (result: Readonly<Record<string, unknown>>): string => {
    const definitions = Array.isArray(result.definitions) ? result.definitions : [];
    if (definitions.length === 0) {
        return "schedule: none\n";
    }
    const lines: string[] = [];
    for (const rawItem of definitions) {
        if (!isRecord(rawItem)) {
            lines.push(String(rawItem));
            continue;
        }
        const alias = typeof rawItem.alias === "string" ? rawItem.alias : "";
        const state = typeof rawItem.state === "string" ? rawItem.state : "active";
        const def = isRecord(rawItem.definition) ? rawItem.definition : {};
        const detail = isRecord(rawItem.detail) ? rawItem.detail : {};
        const isMacro = Array.isArray(def.run) || detail.kind === "run";
        const kindLabel = isMacro ? "macro" : "prompt";
        const statusLabel = typeof detail.status === "string"
            ? `status=${detail.status}`
            : state === "unavailable"
              ? "status=fail"
              : "";
        const ruleSummary = compactRuleLabel(def, detail);
        const actionSummary = summarizeScheduleAction(def);
        const problemNote = state === "unavailable" && isRecord(rawItem.problem) && typeof rawItem.problem.detail === "string"
            ? `— ${rawItem.problem.detail}`
            : "";
        const prov = isRecord(rawItem.provenance) ? rawItem.provenance : {};
        const source = typeof prov.source === "string" && prov.source.length > 0 ? `source=${prov.source}` : "";
        const parts = [alias, state, kindLabel, statusLabel, ruleSummary, actionSummary, problemNote, source]
            .filter((p) => p.length > 0);
        lines.push(parts.join("  "));
    }
    return `${lines.join("\n")}\n`;
};

export const formatScheduleInspect = (entry: Readonly<Record<string, unknown>>): string => {
    const alias = typeof entry.alias === "string" ? entry.alias : "";
    const state = typeof entry.state === "string" ? entry.state : "active";
    const origin = typeof entry.origin === "string" ? entry.origin : "workspace";
    const def = isRecord(entry.definition) ? entry.definition : {};
    const detail = isRecord(entry.detail) ? entry.detail : {};
    const prov = isRecord(entry.provenance) ? entry.provenance : {};
    const isMacro = Array.isArray(def.run) || detail.kind === "run";
    const status = typeof detail.status === "string" ? detail.status : state === "unavailable" ? "fail" : "open";
    const rule = typeof detail.rule === "string" ? detail.rule : typeof def.rule === "string" ? def.rule : "manual";
    const ruleText = typeof detail.text === "string" && detail.text.length > 0 ? ` (${detail.text})` : "";

    const lines: string[] = [
        `alias:     ${alias}`,
        `kind:      ${isMacro ? "macro (run)" : "prompt"}`,
        `state:     ${state} (status=${status}, origin=${origin})`,
        `rule:      ${rule.replace(/\r?\n/gu, " / ")}${ruleText}`,
    ];
    if (typeof detail.next === "string" && detail.next.length > 0) {
        lines.push(`next:      ${detail.next}`);
    }
    if (typeof detail.zone === "string" && detail.zone.length > 0) {
        lines.push(`zone:      ${detail.zone}`);
    }
    if (typeof detail.catchup === "boolean" && rule !== "manual" && rule !== "once") {
        lines.push(`catchup:   ${String(detail.catchup)}`);
    }
    if (typeof detail.lastFiredAt === "string" && detail.lastFiredAt.length > 0) {
        lines.push(`lastFired: ${detail.lastFiredAt}`);
    }
    if (typeof detail.doneAt === "string" && detail.doneAt.length > 0) {
        lines.push(`doneAt:    ${detail.doneAt}`);
    }
    if (typeof detail.loopId === "number") {
        lines.push(`loopId:    ${String(detail.loopId)}`);
    }
    if (typeof prov.source === "string" && prov.source.length > 0) {
        lines.push(`source:    ${prov.source}`);
    }
    if (isRecord(entry.problem) && typeof entry.problem.detail === "string" && entry.problem.detail.length > 0) {
        lines.push(`problem:   ${entry.problem.detail}`);
    }

    if (isMacro && Array.isArray(def.run)) {
        if (typeof def.target === "string" && def.target.length > 0) {
            lines.push(`target:    ${def.target}`);
        }
        lines.push(`steps (${String(def.run.length)}):`);
        for (let i = 0; i < def.run.length; i += 1) {
            const rawStep = def.run[i];
            if (!isRecord(rawStep)) continue;
            const srv = typeof rawStep.server === "string" ? rawStep.server : "?";
            const tool = typeof rawStep.tool === "string" ? rawStep.tool : "?";
            const argsStr = isRecord(rawStep.arguments) && Object.keys(rawStep.arguments).length > 0
                ? `  ${JSON.stringify(rawStep.arguments)}`
                : "";
            const asideStr = typeof rawStep.aside === "string" && rawStep.aside.length > 0
                ? `  (${rawStep.aside})`
                : "";
            lines.push(`  #${String(i)}  ${srv}.${tool}${argsStr}${asideStr}`);
        }
    } else {
        if (typeof def.target === "string" && def.target.length > 0) {
            lines.push(`target:    ${def.target}`);
        }
        if (typeof def.persona === "string" && def.persona.length > 0) {
            lines.push(`persona:   ${def.persona}`);
        }
        if (typeof def.prompt === "string" && def.prompt.length > 0) {
            lines.push(`prompt:    ${def.prompt}`);
        }
    }
    return `${lines.join("\n")}\n`;
};

const parseStepReceipts = (raw: unknown): readonly ScheduledStepReceipt[] => {
    if (!Array.isArray(raw)) return [];
    const out: ScheduledStepReceipt[] = [];
    for (const item of raw) {
        if (!isRecord(item)) continue;
        if (typeof item.server !== "string" || typeof item.tool !== "string" || typeof item.status !== "number") continue;
        out.push({
            index: typeof item.index === "number" ? item.index : out.length,
            server: item.server,
            tool: item.tool,
            status: item.status,
            ...(typeof item.uri === "string" ? { uri: item.uri } : {}),
            ...(typeof item.preview === "string" ? { preview: item.preview } : {}),
            ...(isRecord(item.problem) ? { problem: item.problem } : {}),
        });
    }
    return out;
};

export const formatScheduleStepReceipts = (rawResults: unknown): string[] => {
    const receipts = parseStepReceipts(rawResults);
    const lines: string[] = [];
    for (const step of receipts) {
        const uriPart = step.uri !== undefined && step.uri.length > 0 ? `  ${step.uri}` : "";
        const rawPreview = step.preview?.trim() ?? "";
        const previewLines = rawPreview.length > 0 ? rawPreview.split(/\r?\n/u) : [];
        const inlinePreview = previewLines.length === 1 ? `  — ${previewLines[0]!}` : "";
        lines.push(`  #${String(step.index)}  ${step.server}.${step.tool}  ${String(step.status)}${uriPart}${inlinePreview}`);
        if (previewLines.length > 1) {
            for (const pLine of previewLines) {
                lines.push(`      ${pLine}`);
            }
        }
        if (step.problem !== undefined) {
            const detail = typeof step.problem.detail === "string"
                ? step.problem.detail
                : typeof step.problem.title === "string"
                  ? step.problem.title
                  : "";
            if (detail.length > 0) {
                lines.push(`      ! ${detail}`);
            }
        }
    }
    return lines;
};

export const formatScheduleRunResult = (
    fallbackAlias: string,
    result: Readonly<Record<string, unknown>>,
): string => {
    const alias = typeof result.alias === "string" && result.alias.length > 0 ? result.alias : fallbackAlias;
    const status = typeof result.status === "string" ? result.status : "open";
    const receipts = parseStepReceipts(result.results);
    const meta: string[] = [];
    if (receipts.length > 0) {
        meta.push(`${String(receipts.length)} ${receipts.length === 1 ? "step" : "steps"}`);
    }
    if (typeof result.loopId === "number") {
        meta.push(`loop ${String(result.loopId)}`);
    }
    if (typeof result.doneAt === "string" && result.doneAt.length > 0) {
        meta.push(`done ${result.doneAt}`);
    } else if (typeof result.lastFiredAt === "string" && result.lastFiredAt.length > 0) {
        meta.push(`fired ${result.lastFiredAt}`);
    }
    const header = meta.length > 0 ? `${alias}  ${status}  (${meta.join(" · ")})` : `${alias}  ${status}`;
    const stepLines = formatScheduleStepReceipts(receipts);
    return stepLines.length > 0 ? `${header}\n${stepLines.join("\n")}\n` : `${header}\n`;
};

export const formatScheduleStatusResult = (
    fallbackAlias: string,
    result: Readonly<Record<string, unknown>>,
): string => {
    const alias = typeof result.alias === "string" && result.alias.length > 0 ? result.alias : fallbackAlias;
    const status = typeof result.status === "string" ? result.status : "open";
    const doneNote = typeof result.doneAt === "string" && result.doneAt.length > 0 ? `  (done ${result.doneAt})` : "";
    return `${alias}  ${status}${doneNote}\n`;
};

export const extractScheduleProblem = (
    err: unknown,
    context: { readonly alias?: string; readonly surface: "cli" | "repl" },
): { readonly problem: ScheduleUsageProblem; readonly receiptLines: readonly string[] } | null => {
    if (err instanceof ScheduleCommandUsageError) {
        return { problem: err.problem, receiptLines: [] };
    }
    if (!isRecord(err)) return null;
    const data = isRecord(err.data) ? err.data : isRecord(err.problem) ? err.problem : null;
    if (data === null) return null;
    const type = typeof data.type === "string" ? data.type : "https://problems.plurnk.xyz/client/command-failed";
    const status = typeof data.status === "number" ? data.status : 500;
    const title = typeof data.title === "string" ? data.title : "Schedule command failed";
    let detail = typeof data.detail === "string"
        ? data.detail
        : err instanceof Error
          ? err.message
          : title;
    let recovery = typeof data.recovery === "string" ? data.recovery : undefined;
    const alias = context.alias;
    if (type.endsWith("/already-done") && alias !== undefined && alias.length > 0) {
        const reopenCmd = context.surface === "cli" ? `plurnk schedule reopen ${alias}` : `/schedule reopen ${alias}`;
        const hint = `Reopen with: ${reopenCmd}`;
        if (!detail.includes(reopenCmd)) {
            detail = `${detail} (${hint})`;
        }
        recovery ??= hint;
    }
    const receiptLines = formatScheduleStepReceipts(data.results);
    return {
        problem: {
            type,
            title,
            status,
            detail,
            ...(recovery !== undefined ? { recovery } : {}),
        },
        receiptLines,
    };
};
