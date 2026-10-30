// Editor tab-completion provider for TUI mode ({§cli-interactive-command-discovery}).

import { readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { PLURNK_FENCE, PLURNK_OPS } from "@plurnk/plurnk-contracts";
import { INTERACTIVE_COMMANDS } from "./commands.ts";

export interface PathPartial {
    readonly kind: "local" | "reference" | "member" | "target";
    readonly partial: string;
}

const DSL_TARGET_PARTIAL = /^`{3,}[A-Za-z0-9_.+-]+[ \t]*\(([^)\n]*)$/u;

export const pathPartial = (line: string): PathPartial | null => {
    const verb = line.match(/^\/(?:import|script)\s+(\S*)$/u);
    if (verb) return { kind: "local", partial: verb[1]! };
    const members = line.match(/^\/members\s+(?:discover|add(?:\s+\S+)*)\s+(\S*)$/u);
    if (members) return { kind: "member", partial: members[1]! };
    const envImport = line.match(/^\/env\s+(?:--scope(?:=|\s+)(?:session|workspace)\s+)?import\s+(\S*)$/u);
    if (envImport) return { kind: "local", partial: envImport[1]! };
    const at = line.match(/(?:^|\s)@(\S*)$/u);
    if (at) return { kind: "reference", partial: at[1]! };
    const target = line.slice(line.lastIndexOf("\n") + 1).match(DSL_TARGET_PARTIAL);
    if (target) return { kind: "target", partial: target[1]! };
    return null;
};

export interface DslOpPartial {
    readonly fence: string;
    readonly typed: string;
}

export const dslOpPartial = (line: string): DslOpPartial | null => {
    const match = line.match(/^(`{3,})([A-Za-z]*)$/u);
    return match ? { fence: match[1]!, typed: match[2]! } : null;
};

export const completeOps = ({ fence, typed }: DslOpPartial): [string[], string] => {
    const up = typed.toUpperCase();
    const opener = fence.length >= PLURNK_FENCE.length ? fence : PLURNK_FENCE;
    return [
        PLURNK_OPS.filter((operation) => operation.startsWith(up)).map((operation) => `${opener}${operation}`),
        `${opener}${typed}`,
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
}

export interface CompletionContext {
    readonly cwd: string;
    readonly getProjectRoot: () => string | null;
    readonly getModels?: () => readonly string[];
    readonly getEfforts?: () => readonly string[];
    readonly getPersonas?: () => readonly string[];
    readonly getSessionNames?: () => readonly string[];
    readonly getWorkspaceNames?: () => readonly string[];
    readonly getPendingGateIds?: () => readonly string[];
}

const FAMILY_SUBCOMMANDS = [
    { value: "list", description: "List definitions" },
    { value: "discover", description: "Discover candidates" },
    { value: "add", description: "Add definition" },
    { value: "replace", description: "Replace definition" },
    { value: "enable", description: "Enable definition" },
    { value: "disable", description: "Disable definition" },
    { value: "remove", description: "Remove definition" },
];

export const completeInput = async (
    line: string,
    ctx: CompletionContext,
): Promise<{ suggestions: CompletionSuggestion[]; prefix: string }> => {
    const rootMatch = /^\/(\w*)$/u.exec(line);
    if (rootMatch !== null) {
        const typed = rootMatch[1]!.toLowerCase();
        const commands = INTERACTIVE_COMMANDS.map((c) => {
            const name = c.usage.split(/\s+/u)[0]!.slice(1);
            return { name, value: `/${name}`, description: c.summary };
        })
            .filter((c) => c.name.startsWith(typed))
            .sort((a, b) => (a.name === typed ? 0 : 1) - (b.name === typed ? 0 : 1));
        return {
            suggestions: commands.map(({ value, description }) => ({ value, description })),
            prefix: line,
        };
    }

    const helpMatch = /^\/help\s+(\w*)$/u.exec(line);
    if (helpMatch !== null) {
        const typed = helpMatch[1]!.toLowerCase();
        const commands = INTERACTIVE_COMMANDS.map((c) => {
            const name = c.usage.split(/\s+/u)[0]!.slice(1);
            return { value: name, description: c.summary };
        }).filter((c) => c.value.startsWith(typed));
        return { suggestions: commands, prefix: helpMatch[1]! };
    }

    const familyMatch = /^\/(mcp|skills|members|env|schedule)\s+(\w*)$/u.exec(line);
    if (familyMatch !== null) {
        const typed = familyMatch[2]!.toLowerCase();
        const subs =
            familyMatch[1] === "env"
                ? [...FAMILY_SUBCOMMANDS, { value: "import", description: "Import dotenv file" }]
                : FAMILY_SUBCOMMANDS;
        return {
            suggestions: subs.filter((s) => s.value.startsWith(typed)),
            prefix: familyMatch[2]!,
        };
    }

    const gateMatch = /^\/(approve|accept|reject|cancel|edit|answer)\s+@?([0-9a-f]*)$/iu.exec(line);
    if (gateMatch !== null) {
        const typed = gateMatch[2]!.toLowerCase();
        const ids = ctx.getPendingGateIds?.() ?? [];
        return {
            suggestions: ids
                .filter((id) => id.startsWith(typed))
                .map((id) => ({ value: `@${id}`, description: "pending gate" })),
            prefix: line.slice(line.lastIndexOf(" ") + 1),
        };
    }

    const sessionMatch = /^\/session\s+(\S*)$/u.exec(line);
    if (sessionMatch !== null) {
        const frag = sessionMatch[1]!;
        const names = ctx.getSessionNames?.() ?? [];
        return {
            suggestions: names
                .filter((n) => n.startsWith(frag))
                .map((value) => ({ value, description: "session" })),
            prefix: frag,
        };
    }

    const workspaceMatch = /^\/workspace\s+(\S*)$/u.exec(line);
    if (workspaceMatch !== null) {
        const frag = workspaceMatch[1]!;
        const names = ctx.getWorkspaceNames?.() ?? [];
        return {
            suggestions: names
                .filter((n) => n.startsWith(frag))
                .map((value) => ({ value, description: "workspace" })),
            prefix: frag,
        };
    }

    const modelMatch = /^\/(model|child)\s+(\S*)$/u.exec(line);
    if (modelMatch !== null) {
        const frag = modelMatch[2]!;
        const models = ctx.getModels?.() ?? [];
        const candidates =
            modelMatch[1] === "child" ? ["inherit", ...models.filter((m) => m !== "inherit")] : models;
        return {
            suggestions: candidates
                .filter((m) => m.startsWith(frag))
                .map((value) => ({
                    value,
                    description: value === "inherit" ? "inherit parent route" : "model",
                })),
            prefix: frag,
        };
    }

    const effortMatch = /^\/effort\s+(\S*)$/u.exec(line);
    if (effortMatch !== null) {
        const frag = effortMatch[1]!;
        const efforts = ctx.getEfforts?.() ?? [];
        return {
            suggestions: efforts
                .filter((e) => e.startsWith(frag))
                .map((value) => ({ value, description: "reasoning effort" })),
            prefix: frag,
        };
    }

    const personaMatch = /^\/persona\s+(\S*)$/u.exec(line);
    if (personaMatch !== null) {
        const frag = personaMatch[1]!;
        const personas = ctx.getPersonas?.() ?? ["none"];
        return {
            suggestions: personas
                .filter((p) => p.startsWith(frag))
                .map((value) => ({
                    value,
                    description: value === "none" ? "clear persona role" : "persona",
                })),
            prefix: frag,
        };
    }

    const op = dslOpPartial(line);
    if (op !== null) {
        const [values, prefix] = completeOps(op);
        return {
            suggestions: values.map((value) => ({ value, description: "Plurnk operation" })),
            prefix,
        };
    }

    const partial = pathPartial(line);
    if (partial !== null) {
        const [values, prefix] = await completeAddressPath(partial, ctx.cwd, ctx.getProjectRoot());
        return {
            suggestions: values.map((value) => ({ value, description: "local path" })),
            prefix,
        };
    }

    return { suggestions: [], prefix: line };
};

export const makeAutocompleteProvider = (ctx: CompletionContext): AutocompleteProvider => ({
    triggerCharacters: ["/", "@"],
    getSuggestions: async (lines, cursorLine, cursorCol) => {
        const beforeCursor = lines
            .slice(0, cursorLine)
            .concat(lines[cursorLine]?.slice(0, cursorCol) ?? "")
            .join("\n");
        const { suggestions, prefix } = await completeInput(beforeCursor, ctx);
        if (suggestions.length === 0) return null;
        return {
            items: suggestions.map(
                ({ value, description }): AutocompleteItem => ({
                    value,
                    label: value,
                    description,
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
        const completed = `${before.slice(0, replaceFrom)}${item.value}`;
        const next = [...lines];
        next[cursorLine] = completed + after;
        return { lines: next, cursorLine, cursorCol: completed.length };
    },
});
