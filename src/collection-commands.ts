// Shared list/discover/models collection browsing grammar, pagination defaults, and footers
// ({§cli-configuration-source}, {§cli-subcommands}, {§cli-interactive-command-discovery}).

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

export const COLLECTION_PAGE_SIZE = 10;

export const LIST_STATES = Object.freeze([
    "active",
    "dormant",
    "disabled",
    "unavailable",
    "authorization-required",
] as const);

export const LIST_ORIGINS = Object.freeze(["service", "workspace", "session"] as const);

export const FAMILY_LIST_FLAGS: readonly { readonly value: string; readonly description: string }[] = Object.freeze([
    { value: "--query", description: "Filter by alias, source, or details" },
    { value: "--state", description: "Filter by state (active|dormant|disabled|unavailable|authorization-required)" },
    { value: "--origin", description: "Filter by origin (service|workspace|session)" },
    { value: "--offset", description: "Start index for pagination (default 0)" },
    { value: "--limit", description: "Maximum definitions to return (1-100)" },
]);

export const FAMILY_DISCOVER_FLAGS_BY_FAMILY: Readonly<
    Record<string, readonly { readonly value: string; readonly description: string }[]>
> = Object.freeze({
    mcp: Object.freeze([
        { value: "--query", description: "Search MCP Registry by name (optional)" },
        { value: "--cursor", description: "Opaque continuation cursor from previous page" },
        { value: "--limit", description: "Maximum candidates to return (1-100)" },
    ]),
    skills: Object.freeze([
        { value: "--source", description: "Skill discovery source (git URL, folder, archive, or server:///skills)" },
        { value: "--query", description: "Filter discovered skills by name or description" },
        { value: "--cursor", description: "Opaque continuation cursor from previous page" },
        { value: "--limit", description: "Maximum candidates to return (1-100)" },
    ]),
    personas: Object.freeze([
        { value: "--source", description: "Optional persona directory or file path" },
        { value: "--query", description: "Filter discovered personas by name or description" },
        { value: "--cursor", description: "Opaque continuation cursor from previous page" },
        { value: "--limit", description: "Maximum candidates to return (1-100)" },
    ]),
    members: Object.freeze([
        { value: "--query", description: "File path or glob rule to preview" },
        { value: "--limit", description: "Maximum matching paths to preview (1-100)" },
    ]),
    env: Object.freeze([
        { value: "--query", description: "Filter declared variables by name or comment" },
        { value: "--source", description: "Restrict discovery to one declaration source" },
        { value: "--cursor", description: "Opaque continuation cursor from previous page" },
        { value: "--limit", description: "Maximum candidates to return (1-100)" },
    ]),
    schedule: Object.freeze([
        { value: "--rule", description: "Cron, RRULE, +duration, or ISO timestamp to preview" },
        { value: "--cursor", description: "Opaque continuation cursor from previous page" },
        { value: "--limit", description: "Maximum preview results to return (1-100)" },
    ]),
});

export const MODELS_LIST_FLAGS: readonly { readonly value: string; readonly description: string }[] = Object.freeze([
    { value: "--provider", description: "Filter catalog to one provider" },
    { value: "--all", description: "Include unconfigured models with readiness causes" },
    { value: "--offset", description: "Catalog page offset (default 0)" },
    { value: "--limit", description: "Maximum models per page (1-100, default 10)" },
]);

const requireValue = (flag: string, value: string | undefined): string => {
    if (value === undefined) {
        throw new ScheduleCommandUsageError("Missing option value", `${flag} requires a value.`);
    }
    return value;
};

const parseBoundedInt = (flag: string, raw: string, min: number, max?: number): number => {
    if (!/^\d+$/u.test(raw)) {
        throw new ScheduleCommandUsageError(
            `Invalid ${flag} value`,
            `${flag} requires an integer${max !== undefined ? ` between ${String(min)} and ${String(max)}` : ` >= ${String(min)}`}.`,
        );
    }
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
        throw new ScheduleCommandUsageError(
            `Invalid ${flag} value`,
            `${flag} must be between ${String(min)} and ${String(max ?? "MAX_SAFE_INTEGER")}.`,
        );
    }
    return parsed;
};

export const isImplicitListFlag = (token: string | undefined): boolean =>
    token !== undefined && /^--(query|state|origin|offset|limit)(?:=|$)/u.test(token);

export const parseFamilyListArgs = (rest: readonly string[]): Record<string, unknown> => {
    let queryFlag: string | undefined;
    let state: string | undefined;
    let origin: string | undefined;
    let offset: number | undefined;
    let limit: number | undefined;
    const positionals: string[] = [];

    for (let i = 0; i < rest.length; i += 1) {
        const tok = rest[i] ?? "";
        if (tok === "--query") {
            queryFlag = requireValue("--query", rest[++i]);
        } else if (tok.startsWith("--query=")) {
            queryFlag = tok.slice("--query=".length);
        } else if (tok === "--state") {
            state = requireValue("--state", rest[++i]);
        } else if (tok.startsWith("--state=")) {
            state = tok.slice("--state=".length);
        } else if (tok === "--origin") {
            origin = requireValue("--origin", rest[++i]);
        } else if (tok.startsWith("--origin=")) {
            origin = tok.slice("--origin=".length);
        } else if (tok === "--offset") {
            offset = parseBoundedInt("--offset", requireValue("--offset", rest[++i]), 0);
        } else if (tok.startsWith("--offset=")) {
            offset = parseBoundedInt("--offset", tok.slice("--offset=".length), 0);
        } else if (tok === "--limit") {
            limit = parseBoundedInt("--limit", requireValue("--limit", rest[++i]), 1, 100);
        } else if (tok.startsWith("--limit=")) {
            limit = parseBoundedInt("--limit", tok.slice("--limit=".length), 1, 100);
        } else if (tok.startsWith("--")) {
            throw new ScheduleCommandUsageError(
                "Unknown list option",
                `Unknown list option '${tok}'. Expected --query, --state, --origin, --offset, or --limit.`,
            );
        } else if (tok.length > 0) {
            positionals.push(tok);
        }
    }

    if (state !== undefined && !(LIST_STATES as readonly string[]).includes(state)) {
        throw new ScheduleCommandUsageError(
            "Invalid --state value",
            `Invalid --state '${state}'. Expected one of: ${LIST_STATES.join(", ")}.`,
        );
    }
    if (origin !== undefined && !(LIST_ORIGINS as readonly string[]).includes(origin)) {
        throw new ScheduleCommandUsageError(
            "Invalid --origin value",
            `Invalid --origin '${origin}'. Expected one of: ${LIST_ORIGINS.join(", ")}.`,
        );
    }
    const query = queryFlag ?? (positionals.length > 0 ? positionals.join(" ") : undefined);
    const params: Record<string, unknown> = {};
    if (query !== undefined && query.trim().length > 0) params.query = query.trim();
    if (state !== undefined) params.state = state;
    if (origin !== undefined) params.origin = origin;
    if (offset !== undefined) params.offset = offset;
    if (limit !== undefined) params.limit = limit;
    return params;
};

export const parseFamilyDiscoverArgs = (family: string, rest: readonly string[]): Record<string, unknown> => {
    let sourceFlag: string | undefined;
    let queryFlag: string | undefined;
    let ruleFlag: string | undefined;
    let cursor: string | undefined;
    let limit: number | undefined;
    const positionals: string[] = [];

    for (let i = 0; i < rest.length; i += 1) {
        const tok = rest[i] ?? "";
        if (tok === "--source") {
            sourceFlag = requireValue("--source", rest[++i]);
        } else if (tok.startsWith("--source=")) {
            sourceFlag = tok.slice("--source=".length);
        } else if (tok === "--query") {
            queryFlag = requireValue("--query", rest[++i]);
        } else if (tok.startsWith("--query=")) {
            queryFlag = tok.slice("--query=".length);
        } else if (tok === "--rule") {
            ruleFlag = requireValue("--rule", rest[++i]);
        } else if (tok.startsWith("--rule=")) {
            ruleFlag = tok.slice("--rule=".length);
        } else if (tok === "--cursor") {
            cursor = requireValue("--cursor", rest[++i]);
        } else if (tok.startsWith("--cursor=")) {
            cursor = tok.slice("--cursor=".length);
        } else if (tok === "--limit") {
            limit = parseBoundedInt("--limit", requireValue("--limit", rest[++i]), 1, 100);
        } else if (tok.startsWith("--limit=")) {
            limit = parseBoundedInt("--limit", tok.slice("--limit=".length), 1, 100);
        } else if (tok.startsWith("--")) {
            throw new ScheduleCommandUsageError(
                "Unknown discover option",
                `Unknown discover option '${tok}'. Expected --source, --query, --rule, --cursor, or --limit.`,
            );
        } else if (tok.length > 0) {
            positionals.push(tok);
        }
    }

    const params: Record<string, unknown> = {};
    if (family === "skills" || family === "personas") {
        const source = sourceFlag ?? positionals[0];
        const positionalQuery = sourceFlag === undefined && positionals.length > 1
            ? positionals.slice(1).join(" ")
            : sourceFlag !== undefined && positionals.length > 0
              ? positionals.join(" ")
              : undefined;
        const query = queryFlag ?? positionalQuery;
        if (source !== undefined && source.trim().length > 0) params.source = source.trim();
        if (query !== undefined && query.trim().length > 0) params.query = query.trim();
    } else if (family === "schedule") {
        const rule = ruleFlag ?? (positionals.length > 0 ? positionals.join(" ") : undefined);
        if (rule !== undefined && rule.trim().length > 0) params.rule = rule.trim();
    } else {
        const query = queryFlag ?? (positionals.length > 0 ? positionals.join(" ") : undefined);
        if (query !== undefined && query.trim().length > 0) params.query = query.trim();
        if (sourceFlag !== undefined && sourceFlag.trim().length > 0) params.source = sourceFlag.trim();
    }
    if (cursor !== undefined && cursor.trim().length > 0) params.cursor = cursor.trim();
    if (limit !== undefined) params.limit = limit;
    return params;
};

export const parseModelsArgs = (args: readonly string[]): {
    readonly search?: string;
    readonly provider?: string;
    readonly all?: boolean;
    readonly offset?: number;
    readonly limit: number;
} => {
    let provider: string | undefined;
    let all = false;
    let offset: number | undefined;
    let limit: number | undefined;
    const searchTerms: string[] = [];

    for (let i = 0; i < args.length; i += 1) {
        const tok = args[i] ?? "";
        if (tok === "--provider") {
            provider = requireValue("--provider", args[++i]);
        } else if (tok.startsWith("--provider=")) {
            provider = tok.slice("--provider=".length);
        } else if (tok === "--all") {
            all = true;
        } else if (tok === "--offset") {
            offset = parseBoundedInt("--offset", requireValue("--offset", args[++i]), 0);
        } else if (tok.startsWith("--offset=")) {
            offset = parseBoundedInt("--offset", tok.slice("--offset=".length), 0);
        } else if (tok === "--limit") {
            limit = parseBoundedInt("--limit", requireValue("--limit", args[++i]), 1, 100);
        } else if (tok.startsWith("--limit=")) {
            limit = parseBoundedInt("--limit", tok.slice("--limit=".length), 1, 100);
        } else if (tok.startsWith("--")) {
            throw new ScheduleCommandUsageError(
                "Unknown models option",
                `Unknown models option '${tok}'. Expected --provider, --all, --offset, or --limit.`,
            );
        } else if (tok.length > 0) {
            searchTerms.push(tok);
        }
    }

    const search = searchTerms.length > 0 ? searchTerms.join(" ") : undefined;
    return {
        ...(search !== undefined ? { search } : {}),
        ...(provider !== undefined && provider.trim().length > 0 ? { provider: provider.trim() } : {}),
        ...(all ? { all: true } : {}),
        ...(offset !== undefined ? { offset } : {}),
        limit: limit ?? COLLECTION_PAGE_SIZE,
    };
};

export const formatListPageFooter = (result: Readonly<Record<string, unknown>>): string | null => {
    const definitions = Array.isArray(result.definitions) ? result.definitions : [];
    const offset = typeof result.offset === "number" ? result.offset : 0;
    const total = typeof result.total === "number" ? result.total : undefined;
    const nextOffset = typeof result.nextOffset === "number" ? result.nextOffset : undefined;
    if (total === undefined) return null;
    if (offset === 0 && nextOffset === undefined && definitions.length === total) return null;
    const start = definitions.length === 0 ? 0 : offset + 1;
    const end = offset + definitions.length;
    const range = definitions.length === 0 ? `0 of ${String(total)}` : `${String(start)}–${String(end)} of ${String(total)}`;
    return nextOffset !== undefined
        ? `Showing ${range} (next: --offset ${String(nextOffset)})`
        : `Showing ${range}`;
};

export const formatDiscoverPageFooter = (result: Readonly<Record<string, unknown>>): string | null => {
    const candidates = Array.isArray(result.candidates) ? result.candidates : [];
    const total = typeof result.total === "number" ? result.total : undefined;
    const nextCursor = typeof result.nextCursor === "string" && result.nextCursor.length > 0 ? result.nextCursor : undefined;
    if (nextCursor === undefined && (total === undefined || candidates.length === total)) return null;
    const countLabel = total !== undefined ? `${String(candidates.length)} of ${String(total)}` : String(candidates.length);
    return nextCursor !== undefined
        ? `Showing ${countLabel} (next: --cursor ${nextCursor})`
        : `Showing ${countLabel}`;
};
