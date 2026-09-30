// Client-local file-path completion for the terminal editor.
//
// Co-location law: the client and daemon share one filesystem, so "what files
// exist" is the CLIENT's question — completion reads the local fs directly, no
// daemon round-trip. Feeds the editor completion provider.

import { readdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { PLURNK_FENCE, PLURNK_OPS } from "@plurnk/plurnk-contracts";
import { projectRelativePath } from "./openpaths.ts";

export interface PathPartial {
    kind: "local" | "reference" | "member" | "target";
    partial: string;
}

// {§cli-path-completion}: retain the address owner, not just the path fragment.
export const pathPartial = (line: string): PathPartial | null => {
    const verb = line.match(/^\/(?:import|script)\s+(\S*)$/);
    if (verb) return { kind: "local", partial: verb[1] };
    const members = line.match(/^\/members\s+(?:discover|add\s+\S+)\s+(\S*)$/);
    if (members) return { kind: "member", partial: members[1] };
    const envImport = line.match(/^\/env\s+(?:--scope(?:=|\s+)(?:worker|workspace)\s+)?import\s+(\S*)$/);
    if (envImport) return { kind: "local", partial: envImport[1] };
    // @file: a path reference anywhere in a prompt (word-boundary @ to dodge
    // emails). The leading @ stays; only the path part completes.
    const at = line.match(/(?:^|\s)@(\S*)$/);
    if (at) return { kind: "reference", partial: at[1] };
    const target = line.slice(line.lastIndexOf("\n") + 1).match(DSL_TARGET_PARTIAL);
    if (target) return { kind: "target", partial: target[1] };
    return null;
};

const OPS: readonly string[] = [...PLURNK_OPS, "LOOK"];
const DSL_TARGET_PARTIAL = /^`{3,}[A-Za-z0-9_.+-]+[ \t]*\(([^)\n]*)$/;

// Coarse dispatch classification only. The daemon remains the grammar owner
// and owns name registration and diagnostics for malformed fences/modifiers/bodies.
export const dslStatement = (text: string): string | null =>
    /^`{3,}[A-Za-z0-9_.+-]+/.test(text) ? text : null;

export interface DslOpPartial {
    fence: string;
    typed: string;
}

// Complete native names without guessing the available runtime/tool registry.
export const dslOpPartial = (line: string): DslOpPartial | null => {
    const match = line.match(/^(`{3,})([A-Za-z]*)$/);
    return match ? { fence: match[1], typed: match[2] } : null;
};

// {§operation-fences}: completion uses at least the canonical width, preserving longer authored fences.
export const completeOps = ({ fence, typed }: DslOpPartial): [string[], string] => {
    const up = typed.toUpperCase();
    const opener = fence.length >= PLURNK_FENCE.length ? fence : PLURNK_FENCE;
    return [
        OPS.filter((operation) => operation.startsWith(up)).map((operation) => `${opener}${operation}`),
        `${opener}${typed}`,
    ];
};

// Complete a filesystem path partial against the local fs. Returns
// [completions, partial] for the completion adapter: full-path tokens (directories suffixed
// with `/`), and the partial they replace. Unreadable directory → no hits.
// Dotfiles are hidden unless the prefix itself starts with `.` (shell habit).
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
    { kind, partial }: PathPartial, cwd: string, projectRoot: string | null,
): Promise<[string[], string]> => {
    if (kind === "local") return completePath(partial, cwd);
    if (projectRoot === null) return [[], partial];
    if (kind === "reference") {
        return projectRelativePath(partial, projectRoot) === null ? [[], partial] : completePath(partial, projectRoot);
    }
    if (kind === "member") return completePath(partial, projectRoot);
    const scheme = partial.startsWith("file:///") ? "file://" : "";
    const path = partial.slice(scheme.length);
    if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return [[], partial];
    // {§fs-namei}: a file OP's leading slash is the workspace root, not the host root.
    const leading = path.match(/^\/+/)?.[0] ?? "";
    const [hits] = await completePath(path.slice(leading.length), projectRoot);
    return [hits.map((hit) => `${scheme}${leading}${hit}`), partial];
};
