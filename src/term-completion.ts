// Editor tab-completion provider for Term mode ({§cli-interactive-command-discovery}).

import { readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { PLURNK_OPS, PROPOSAL_POLICIES } from "@plurnk/plurnk-contracts";
import {
    FAMILY_DISCOVER_FLAGS_BY_FAMILY,
    FAMILY_LIST_FLAGS,
    LIST_ORIGINS,
    LIST_STATES,
    MODELS_LIST_FLAGS,
} from "./collection-commands.ts";
import { INTERACTIVE_COMMANDS } from "./commands.ts";
import { SCHEDULE_ADD_FLAGS } from "./schedule-command.ts";

export interface PathPartial {
    readonly kind: "local" | "reference" | "member" | "target";
    readonly partial: string;
}

const EXPRESSION_TARGET_PARTIAL = /^(?:await\s+)?plurnk\.[A-Za-z0-9_]+\s*\(\s*\{\s*(?:path|from|to|target)\s*:\s*["']([^"'\n]*)$/u;

export const pathPartial = (line: string): PathPartial | null => {
    const verb = line.match(/^\/(?:import|script)\s+(\S*)$/u);
    if (verb) return { kind: "local", partial: verb[1]! };
    const members = line.match(/^\/members\s+(?:discover|add(?:\s+\S+)*)\s+(\S*)$/u);
    if (members) return { kind: "member", partial: members[1]! };
    const envImport = line.match(/^\/env\s+(?:--scope(?:=|\s+)(?:session|workspace)\s+)?import\s+(\S*)$/u);
    if (envImport) return { kind: "local", partial: envImport[1]! };
    const at = line.match(/(?:^|\s)@(\S*)$/u);
    if (at) return { kind: "reference", partial: at[1]! };
    const target = line.slice(line.lastIndexOf("\n") + 1).match(EXPRESSION_TARGET_PARTIAL);
    if (target) return { kind: "target", partial: target[1]! };
    return null;
};

export interface DslOpPartial {
    readonly prefix: string;
    readonly typed: string;
}

export const dslOpPartial = (line: string): DslOpPartial | null => {
    const match = line.match(/^((?:await\s+)?plurnk\.)([A-Za-z]*)$/u);
    return match ? { prefix: match[1]!, typed: match[2]! } : null;
};

export const completeOps = ({ prefix, typed }: DslOpPartial): [string[], string] => {
    const lower = typed.toLowerCase();
    return [
        PLURNK_OPS.map((operation) => operation.toLowerCase()).filter((operation) => operation.startsWith(lower)).map((operation) => `${prefix}${operation}`),
        `${prefix}${typed}`,
    ];
};

export const completePath = async (partial: string, cwd: string): Promise<[string[], string]> => {
    const slash = partial.lastIndexOf("/");
    const dirPart = slash >= 0 ? partial.slice(0, slash + 1) : "";
    const prefix = slash >= 0 ? partial.slice(slash + 1) : partial;
    const dirAbs = isAbsolute(dirPart || ".") ? (dirPart || "/") : resolve(cwd, dirPart || ".");
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
        entries = await readdir(dirAbs, { withFileTypes: true });
    } catch {
        return [[], partial];
    }
    const hits = entries
        .filter((e) => e.name.startsWith(prefix) && (prefix.startsWith(".") || !e.name.startsWith(".")))
        .map((e) => `${dirPart}${e.name}${e.isDirectory() ? "/" : ""}`)
        .sort();
    return [hits, partial];
};

export const completeAddressPath = async (
    { kind, partial }: PathPartial,
    cwd: string,
    projectRoot: string | null,
): Promise<[string[], string]> => {
    if (kind === "local") return completePath(partial, cwd);
    if (projectRoot === null || projectRoot.length === 0) return [[], partial];
    if (kind === "reference") {
        const candidate = resolve(projectRoot, partial || ".");
        const rel = relative(projectRoot, candidate);
        if (rel.startsWith("..")) return [[], partial];
        return completePath(partial, projectRoot);
    }
    if (kind === "member") return completePath(partial, projectRoot);
    const scheme = partial.startsWith("file:///") ? "file://" : "";
    const path = partial.slice(scheme.length);
    if (/^[a-z][a-z0-9+.-]*:/iu.test(path)) return [[], partial];
    const leading = path.match(/^\/+/u)?.[0] ?? "";
    const [hits] = await completePath(path.slice(leading.length), projectRoot);
    return [hits.map((hit) => `${scheme}${leading}${hit}`), partial];
};

export interface CompletionSuggestion {
    readonly value: string;
    readonly description: string;
    readonly lcp?: string;
}

interface LcpAutocompleteItem extends AutocompleteItem {
    readonly lcp?: string;
}

export interface AutocompleteQueryOptions {
    readonly signal?: AbortSignal;
    readonly force?: boolean;
}

export const longestCommonPrefix = (strings: readonly string[]): string => {
    if (strings.length === 0) return "";
    let prefix = strings[0]!;
    for (let i = 1; i < strings.length && prefix.length > 0; i += 1) {
        const s = strings[i]!;
        const limit = Math.min(prefix.length, s.length);
        let j = 0;
        while (j < limit && prefix.charCodeAt(j) === s.charCodeAt(j)) j += 1;
        prefix = prefix.slice(0, j);
    }
    return prefix;
};

const namespace = (
    candidates: readonly string[],
    frag: string,
    describe: (value: string) => string,
    options?: AutocompleteQueryOptions,
): { suggestions: CompletionSuggestion[]; prefix: string } => {
    const hits = candidates.filter((c) => c.startsWith(frag));
    const lcp = longestCommonPrefix(hits);
    const hasStrictLcp = hits.length > 1 && lcp.length > frag.length;
    if (options?.force && hasStrictLcp) {
        return {
            suggestions: [{ value: lcp, description: describe(lcp), lcp }],
            prefix: frag,
        };
    }
    return {
        suggestions: hits.map((value, idx) => ({
            value,
            description: describe(value),
            ...(idx === 0 && hasStrictLcp && value !== lcp ? { lcp } : {}),
        })),
        prefix: frag,
    };
};

export interface CompletionContext {
    readonly cwd: string;
    readonly getProjectRoot: () => string | null;
    readonly getModels?: () => readonly string[];
    readonly getProviderModels?: (provider: string) => Promise<readonly string[]>;
    readonly searchModels?: (query: string) => Promise<readonly string[]>;
    readonly getEfforts?: () => readonly string[];
    readonly getEffortsForModel?: (selector: string) => Promise<readonly string[] | null>;
    readonly getPersonas?: () => readonly string[];
    readonly getFamilyAliases?: (family: string) => readonly string[];
    readonly getSessionNames?: () => readonly string[];
    readonly getWorkspaceNames?: () => readonly string[];
    readonly getPendingGateIds?: () => readonly string[];
    readonly getSkills?: () => readonly { readonly name: string; readonly description: string }[];
    readonly getAvailableCommands?: () => readonly { readonly name: string; readonly description: string }[];
    readonly getPromptSuggestions?: () => readonly string[];
}

const FAMILY_SUBCOMMANDS_BY_FAMILY: Readonly<Record<string, readonly { readonly value: string; readonly description: string }[]>> = {
    mcp: [
        { value: "list", description: "List definitions" },
        { value: "discover", description: "Discover candidates" },
        { value: "add", description: "Add definition" },
        { value: "replace", description: "Replace definition" },
        { value: "enable", description: "Enable definition" },
        { value: "disable", description: "Disable definition" },
        { value: "remove", description: "Remove definition" },
        { value: "skills", description: "Inspect MCP server skills" },
        { value: "complete", description: "Complete MCP prompt or resource" },
        { value: "oauth", description: "Authorize MCP server" },
    ],
    skills: [
        { value: "list", description: "List definitions" },
        { value: "discover", description: "Discover candidates" },
        { value: "add", description: "Add definition" },
        { value: "replace", description: "Replace definition" },
        { value: "enable", description: "Enable definition" },
        { value: "disable", description: "Disable definition" },
        { value: "remove", description: "Remove definition" },
    ],
    personas: [
        { value: "list", description: "List definitions" },
        { value: "discover", description: "Discover candidates" },
        { value: "add", description: "Add definition" },
        { value: "replace", description: "Replace definition" },
        { value: "enable", description: "Enable definition" },
        { value: "disable", description: "Disable definition" },
        { value: "remove", description: "Remove definition" },
    ],
    members: [
        { value: "list", description: "List definitions" },
        { value: "discover", description: "Discover candidates" },
        { value: "add", description: "Add definition" },
        { value: "enable", description: "Enable definition" },
        { value: "disable", description: "Disable definition" },
        { value: "remove", description: "Remove definition" },
    ],
    env: [
        { value: "list", description: "List variables" },
        { value: "discover", description: "Discover variables" },
        { value: "add", description: "Add variable" },
        { value: "replace", description: "Replace variable" },
        { value: "set", description: "Set NAME=value" },
        { value: "unset", description: "Remove variable" },
        { value: "enable", description: "Enable variable" },
        { value: "disable", description: "Disable variable" },
        { value: "remove", description: "Remove variable" },
        { value: "import", description: "Import dotenv file" },
        { value: "--scope", description: "Select session or workspace scope" },
    ],
    schedule: [
        { value: "list", description: "List schedules and macros" },
        { value: "show", description: "Inspect schedule definition" },
        { value: "inspect", description: "Inspect schedule definition" },
        { value: "discover", description: "Preview occurrences" },
        { value: "add", description: "Add schedule or macro" },
        { value: "replace", description: "Replace schedule or macro" },
        { value: "run", description: "Trigger schedule or macro now" },
        { value: "done", description: "Mark obligation done" },
        { value: "reopen", description: "Reopen obligation" },
        { value: "enable", description: "Enable schedule" },
        { value: "disable", description: "Disable schedule" },
        { value: "remove", description: "Remove schedule" },
    ],
};

export const completeInput = async (
    line: string,
    ctx: CompletionContext,
    options?: AutocompleteQueryOptions,
): Promise<{ suggestions: CompletionSuggestion[]; prefix: string }> => {
    if (line === "" && options?.force === true) {
        const promptSuggestions = ctx.getPromptSuggestions?.() ?? [];
        if (promptSuggestions.length > 0) {
            return {
                suggestions: promptSuggestions.map((value) => ({
                    value,
                    description: "suggested prompt",
                })),
                prefix: "",
            };
        }
    }

    const rootMatch = /^\/([\w:-]*)$/u.exec(line);
    if (rootMatch !== null) {
        const typed = rootMatch[1]!.toLowerCase();
        const builtinNames = new Set<string>();
        const allCommands = INTERACTIVE_COMMANDS.map((c) => {
            const name = c.usage.split(/\s+/u)[0]!.slice(1);
            builtinNames.add(name.toLowerCase());
            return { name, value: `/${name}`, description: c.summary };
        });
        for (const adv of ctx.getAvailableCommands?.() ?? []) {
            const cleanName = adv.name.replace(/^\/+/u, "");
            if (cleanName.length === 0 || builtinNames.has(cleanName.toLowerCase())) continue;
            builtinNames.add(cleanName.toLowerCase());
            allCommands.push({
                name: cleanName,
                value: `/${cleanName}`,
                description: adv.description,
            });
        }
        const commands = allCommands
            .filter((c) => c.name.toLowerCase().startsWith(typed))
            .sort((a, b) => (a.name.toLowerCase() === typed ? 0 : 1) - (b.name.toLowerCase() === typed ? 0 : 1));
        return {
            suggestions: commands.map(({ value, description }) => ({ value, description })),
            prefix: line,
        };
    }

    const helpMatch = /^\/help\s+(\w*)$/u.exec(line);
    if (helpMatch !== null) {
        const typed = helpMatch[1]!.toLowerCase();
        const summaryByVerb = new Map(
            INTERACTIVE_COMMANDS.map((c) => [c.usage.split(/\s+/u)[0]!.slice(1), c.summary]),
        );
        return namespace(
            [...summaryByVerb.keys()],
            typed,
            (value) => summaryByVerb.get(value) ?? "command",
            options,
        );
    }

    const learnScopeMatch = /^\/learn\s+--scope(?:\s+|=)(\w*)$/u.exec(line);
    if (learnScopeMatch !== null) {
        const typed = learnScopeMatch[1]!.toLowerCase();
        const scopes = ctx.getProjectRoot() === null ? ["plurnk"] : ["project", "plurnk"];
        return namespace(scopes, typed, (v) => (v === "plurnk" ? "user-wide Plurnk skills" : "project .agents/skills"), options);
    }

    const envScopeMatch = /^\/env\s+--scope(?:\s+|=)(\w*)$/u.exec(line);
    if (envScopeMatch !== null) {
        const typed = envScopeMatch[1]!.toLowerCase();
        return namespace(
            ["session", "workspace"],
            typed,
            (v) => (v === "workspace" ? "workspace environment defaults" : "session environment overrides"),
            options,
        );
    }

    const familyMatch = /^\/(mcp|skills|personas|members|env|schedule)\s+(?:--scope(?:=|\s+)(?:session|workspace)\s+)?([-\w]*)$/u.exec(line);
    if (familyMatch !== null) {
        const family = familyMatch[1]!;
        const typed = familyMatch[2]!.toLowerCase();
        const subs = typed.startsWith("-")
            ? [...(FAMILY_SUBCOMMANDS_BY_FAMILY[family] ?? []), ...FAMILY_LIST_FLAGS]
            : (FAMILY_SUBCOMMANDS_BY_FAMILY[family] ?? []);
        const summaryBySub = new Map(subs.map((s) => [s.value, s.description]));
        return namespace(
            [...summaryBySub.keys()],
            typed,
            (value) => summaryBySub.get(value) ?? "subcommand",
            options,
        );
    }

    const familyStateMatch = /^\/(mcp|skills|personas|members|env|schedule)\s+(?:--scope(?:=|\s+)(?:service|session|workspace)\s+)?(?:list\s+)?(?:[\s\S]*\s+)?--state(?:\s+|=)([-\w]*)$/u.exec(line);
    if (familyStateMatch !== null) {
        const typed = familyStateMatch[2]!.toLowerCase();
        return namespace(LIST_STATES, typed, () => "definition state", options);
    }

    const familyOriginMatch = /^\/(mcp|skills|personas|members|env|schedule)\s+(?:--scope(?:=|\s+)(?:service|session|workspace)\s+)?(?:list\s+)?(?:[\s\S]*\s+)?--origin(?:\s+|=)([-\w]*)$/u.exec(line);
    if (familyOriginMatch !== null) {
        const typed = familyOriginMatch[2]!.toLowerCase();
        return namespace(LIST_ORIGINS, typed, () => "definition origin", options);
    }

    const familyListFlagMatch = /^\/(mcp|skills|personas|members|env|schedule)\s+(?:--scope(?:=|\s+)(?:service|session|workspace)\s+)?(?:list(?:\s+[\s\S]*)?|(?!--scope\b)--(?:query|state|origin|offset|limit)\b[\s\S]*)\s+(--[-\w]*)$/u.exec(line);
    if (familyListFlagMatch !== null) {
        const typed = familyListFlagMatch[2]!.toLowerCase();
        const descByFlag = new Map(FAMILY_LIST_FLAGS.map((f) => [f.value, f.description]));
        return namespace(
            FAMILY_LIST_FLAGS.map((f) => f.value),
            typed,
            (value) => descByFlag.get(value) ?? "list option",
            options,
        );
    }

    const familyDiscoverFlagMatch = /^\/(mcp|skills|personas|members|env|schedule)\s+(?:--scope(?:=|\s+)(?:service|session|workspace)\s+)?discover(?:\s+[\s\S]*)?\s+(--[-\w]*)$/u.exec(line);
    if (familyDiscoverFlagMatch !== null) {
        const family = familyDiscoverFlagMatch[1]!;
        const typed = familyDiscoverFlagMatch[2]!.toLowerCase();
        const flags = FAMILY_DISCOVER_FLAGS_BY_FAMILY[family] ?? [];
        const descByFlag = new Map(flags.map((f) => [f.value, f.description]));
        return namespace(
            flags.map((f) => f.value),
            typed,
            (value) => descByFlag.get(value) ?? "discover option",
            options,
        );
    }

    const familyAliasMatch = /^\/(mcp|skills|personas|members|env|schedule)\s+(?:--scope(?:=|\s+)(?:session|workspace)\s+)?(show|inspect|replace|enable|disable|remove|unset|oauth|skills|run|done|reopen)\s+(\S*)$/u.exec(line);
    if (familyAliasMatch !== null) {
        const family = familyAliasMatch[1]!;
        const sub = familyAliasMatch[2]!;
        if ((sub === "show" || sub === "inspect") && family !== "schedule") {
            return { suggestions: [], prefix: line };
        }
        const frag = familyAliasMatch[3]!;
        const aliases = ctx.getFamilyAliases?.(family) ?? [];
        return namespace(aliases, frag, () => `${family} definition`, options);
    }

    const scheduleFlagMatch = /^\/schedule\s+(?:add|replace)\s+\S+(?:\s+[\s\S]*)?\s+(--[-\w]*)$/u.exec(line);
    if (scheduleFlagMatch !== null) {
        const typed = scheduleFlagMatch[1]!.toLowerCase();
        const descByFlag = new Map(SCHEDULE_ADD_FLAGS.map((f) => [f.value, f.description]));
        return namespace(
            SCHEDULE_ADD_FLAGS.map((f) => f.value),
            typed,
            (value) => descByFlag.get(value) ?? "schedule option",
            options,
        );
    }

    const gateMatch = /^\/(approve|accept|reject|cancel|edit|answer)\s+@?([0-9a-f]*)$/iu.exec(line);
    if (gateMatch !== null) {
        const typed = gateMatch[2]!.toLowerCase();
        const ids = ctx.getPendingGateIds?.() ?? [];
        const tokenPrefix = line.slice(line.lastIndexOf(" ") + 1);
        const res = namespace(
            ids.filter((id) => id.startsWith(typed)).map((id) => `@${id}`),
            `@${typed}`,
            () => "pending gate",
            options,
        );
        return { suggestions: res.suggestions, prefix: tokenPrefix };
    }

    const sessionMatch = /^\/session\s+(\S*)$/u.exec(line);
    if (sessionMatch !== null) {
        const frag = sessionMatch[1]!;
        const names = ctx.getSessionNames?.() ?? [];
        return namespace(names, frag, () => "session", options);
    }

    const workspaceMatch = /^\/workspace\s+(\S*)$/u.exec(line);
    if (workspaceMatch !== null) {
        const frag = workspaceMatch[1]!;
        const names = ctx.getWorkspaceNames?.() ?? [];
        return namespace(names, frag, () => "workspace", options);
    }

    const modelsFlagMatch = /^\/models(?:\s+[\s\S]*)?\s+(--[-\w]*)$/u.exec(line);
    if (modelsFlagMatch !== null) {
        const typed = modelsFlagMatch[1]!.toLowerCase();
        const descByFlag = new Map(MODELS_LIST_FLAGS.map((f) => [f.value, f.description]));
        return namespace(
            MODELS_LIST_FLAGS.map((f) => f.value),
            typed,
            (value) => descByFlag.get(value) ?? "models option",
            options,
        );
    }

    const modelMatch = /^\/(model|models|child)\s+(\S*)$/u.exec(line);
    if (modelMatch !== null) {
        const verb = modelMatch[1]!;
        const frag = modelMatch[2]!;
        const models = ctx.getModels?.() ?? [];
        const baseCandidates =
            verb === "child" ? ["inherit", ...models.filter((m) => m !== "inherit")] : models;
        const describeModel = (value: string): string => (value === "inherit" ? "inherit parent route" : "model");

        if (frag.length === 0) {
            return namespace(baseCandidates, frag, describeModel, options);
        }

        const slashIdx = frag.indexOf("/");
        const fetched: string[] = [];
        if (ctx.searchModels !== undefined) {
            fetched.push(...(await ctx.searchModels(frag)));
        }
        if (slashIdx > 0 && ctx.getProviderModels !== undefined) {
            const provider = frag.slice(0, slashIdx);
            fetched.push(...(await ctx.getProviderModels(provider)));
        }
        const merged = [...new Set([...baseCandidates, ...fetched])];
        const needle = frag.toLowerCase();
        const prefixHits = merged.filter((c) => c.toLowerCase().startsWith(needle));
        const substringHits = merged.filter(
            (c) => !c.toLowerCase().startsWith(needle) && c.toLowerCase().includes(needle),
        );
        const hits = [...prefixHits, ...substringHits];
        const exactPrefixOnly = hits.length > 0 && hits.every((c) => c.startsWith(frag));
        const lcp = exactPrefixOnly ? longestCommonPrefix(hits) : "";
        const hasStrictLcp = exactPrefixOnly && hits.length > 1 && lcp.length > frag.length;
        if (options?.force && hasStrictLcp) {
            return {
                suggestions: [{ value: lcp, description: describeModel(lcp), lcp }],
                prefix: frag,
            };
        }
        return {
            suggestions: hits.map((value, idx) => ({
                value,
                description: describeModel(value),
                ...(idx === 0 && hasStrictLcp && value !== lcp ? { lcp } : {}),
            })),
            prefix: frag,
        };
    }

    const modelEffortMatch = /^\/model\s+(\S+)\s+(\S*)$/u.exec(line);
    if (modelEffortMatch !== null) {
        const selector = modelEffortMatch[1]!;
        const effortFrag = modelEffortMatch[2]!;
        const modelEfforts = await ctx.getEffortsForModel?.(selector);
        const efforts = modelEfforts ?? ctx.getEfforts?.() ?? [];
        return namespace(efforts, effortFrag, () => "reasoning effort", options);
    }

    const effortMatch = /^\/effort\s+(\S*)$/u.exec(line);
    if (effortMatch !== null) {
        const frag = effortMatch[1]!;
        const efforts = ctx.getEfforts?.() ?? [];
        return namespace(efforts, frag, () => "reasoning effort", options);
    }

    const modeMatch = /^\/mode\s+(\S*)$/u.exec(line);
    if (modeMatch !== null) {
        const frag = modeMatch[1]!.toLowerCase();
        return namespace(PROPOSAL_POLICIES, frag, () => "proposal review mode", options);
    }

    const personaMatch = /^\/persona\s+(\S*)$/u.exec(line);
    if (personaMatch !== null) {
        const frag = personaMatch[1]!;
        const personas = ctx.getPersonas?.() ?? ["none"];
        return namespace(
            personas,
            frag,
            (value) => (value === "none" ? "clear persona role" : "persona"),
            options,
        );
    }

    const op = dslOpPartial(line);
    if (op !== null) {
        const [values, prefix] = completeOps(op);
        return namespace(values, prefix, () => "MCP expression", options);
    }

    const partial = pathPartial(line);
    if (partial !== null) {
        const [values, prefix] = await completeAddressPath(partial, ctx.cwd, ctx.getProjectRoot());
        return namespace(values, prefix, () => "local path", options);
    }

    const skillMatch = /(?:^|[\s([{,])\$(\S*)$/u.exec(line);
    if (skillMatch !== null) {
        const skills = ctx.getSkills?.() ?? [];
        if (skills.length > 0) {
            const descBySkill = new Map(skills.map((s) => [s.name, s.description]));
            return namespace(
                skills.map((s) => s.name),
                skillMatch[1]!,
                (value) => descBySkill.get(value) ?? "skill",
                options,
            );
        }
    }

    return { suggestions: [], prefix: line };
};

export const makeAutocompleteProvider = (ctx: CompletionContext): AutocompleteProvider => ({
    triggerCharacters: ["/", "@", "$"],
    getSuggestions: async (lines, cursorLine, cursorCol, options) => {
        const beforeCursor = lines
            .slice(0, cursorLine)
            .concat(lines[cursorLine]?.slice(0, cursorCol) ?? "")
            .join("\n");
        const { suggestions, prefix } = await completeInput(beforeCursor, ctx, options);
        if (suggestions.length === 0) return null;
        return {
            items: suggestions.map(
                ({ value, description, lcp }): LcpAutocompleteItem => ({
                    value,
                    label: value,
                    description,
                    ...(lcp !== undefined ? { lcp } : {}),
                }),
            ),
            prefix,
        };
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
        const current = lines[cursorLine] ?? "";
        const before = current.slice(0, cursorCol);
        const after = current.slice(cursorCol);
        const replaceFrom = Math.max(0, before.length - prefix.length);
        const lcp = (item as LcpAutocompleteItem).lcp;
        const applied = typeof lcp === "string" && lcp.length > prefix.length ? lcp : item.value;
        const completed = `${before.slice(0, replaceFrom)}${applied}`;
        if (completed.includes("\n")) {
            const parts = completed.split("\n");
            const lastIdx = parts.length - 1;
            const lastPart = parts[lastIdx] ?? "";
            parts[lastIdx] = `${lastPart}${after}`;
            const next = [...lines];
            next.splice(cursorLine, 1, ...parts);
            return { lines: next, cursorLine: cursorLine + lastIdx, cursorCol: lastPart.length };
        }
        const next = [...lines];
        next[cursorLine] = completed + after;
        return { lines: next, cursorLine, cursorCol: completed.length };
    },
});
