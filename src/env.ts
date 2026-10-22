// {§cli-environment} Scope selects the daemon action; composition stays server-side.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { commandUsage } from "./commands.ts";
import { configurationSource } from "./functionality-source.ts";
import { ProblemError } from "./diagnostics.ts";

interface ActionCaller {
    call(method: string, params?: object): Promise<unknown>;
}

const CLIENT_ENV_PREFIX = "PLURNK_CLIENT_ENV_";
const CLIENT_ENV_INHERIT_KEY = "PLURNK_CLIENT_ENV_INHERIT";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

// {§cli-environment} Resolve the worker environment entries declared across the client cascade:
// PLURNK_CLIENT_ENV_INHERIT (--env-inherit) < PLURNK_CLIENT_ENV_<NAME> < --env.
// Invalid or reserved names are carried through so the daemon's own admission refuses them.
export const resolveClientWorkerEnv = (
    options: {
        readonly envInherit?: string;
        readonly env?: readonly string[];
    } = {},
    environment: NodeJS.ProcessEnv = process.env,
): Map<string, string> => {
    const out = new Map<string, string>();
    const rawInherit = options.envInherit ?? environment[CLIENT_ENV_INHERIT_KEY];
    const patterns = rawInherit === undefined
        ? []
        : rawInherit.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
    for (const pattern of patterns) {
        if (pattern.endsWith("*")) {
            const prefix = pattern.slice(0, -1);
            if (prefix.length > 0 && !ENV_NAME.test(prefix)) {
                out.set(pattern, "");
                continue;
            }
            for (const [key, value] of Object.entries(environment)) {
                if (value === undefined || key.startsWith("PLURNK_") || !ENV_NAME.test(key)) continue;
                if (key.startsWith(prefix)) out.set(key, value);
            }
            continue;
        }
        if (!ENV_NAME.test(pattern) || pattern.startsWith("PLURNK_")) {
            out.set(pattern, environment[pattern] ?? "");
            continue;
        }
        const inherited = environment[pattern];
        if (inherited !== undefined) out.set(pattern, inherited);
    }
    for (const [key, value] of Object.entries(environment)) {
        if (value === undefined || !key.startsWith(CLIENT_ENV_PREFIX) || key === CLIENT_ENV_INHERIT_KEY) continue;
        out.set(key.slice(CLIENT_ENV_PREFIX.length), value);
    }
    for (const entry of options.env ?? []) {
        const eq = entry.indexOf("=");
        if (eq === -1) {
            const inherited = environment[entry];
            if (inherited !== undefined) out.set(entry, inherited);
            else if (!ENV_NAME.test(entry) || entry.startsWith("PLURNK_")) out.set(entry, "");
            continue;
        }
        out.set(entry.slice(0, eq), entry.slice(eq + 1));
    }
    return out;
};

// {§cli-environment} Persist each resolved worker environment entry onto the bound worker at admission.
export const applyWorkerEnv = async (
    rpc: ActionCaller,
    env: ReadonlyMap<string, string>,
): Promise<void> => {
    for (const [alias, value] of env) {
        const result = await rpc.call("worker.env.replace", { alias, definition: { value } }) as MutationResult;
        if (result.definition?.state === "disabled") {
            await rpc.call("worker.env.enable", { alias });
        }
    }
};

type EnvDefinition = { value: string };

type DefinitionState = {
    alias?: unknown;
    origin?: unknown;
    state?: unknown;
    inherited?: unknown;
    definition?: Partial<EnvDefinition>;
    problem?: { detail?: unknown };
};

type Candidate = { alias?: unknown; summary?: unknown; definition?: Partial<EnvDefinition>; provenance?: { source?: unknown } };

type MutationResult = { status?: unknown; alias?: unknown; removed?: unknown; definition?: DefinitionState };

const renderDefinition = (entry: DefinitionState): string => {
    const alias = typeof entry.alias === "string" ? entry.alias : "(unnamed)";
    const origin = typeof entry.origin === "string" ? entry.origin : "unknown";
    const state = typeof entry.state === "string" ? entry.state : "unknown";
    const value = typeof entry.definition?.value === "string" ? `  ${entry.definition.value}` : "";
    const inherited = typeof entry.inherited === "string" ? `  (from ${entry.inherited})` : "";
    const problem = typeof entry.problem?.detail === "string" ? `  — ${entry.problem.detail}` : "";
    return `  ${alias}  ${origin}  ${state}${value}${inherited}${configurationSource(entry)}${problem}\n`;
};

const renderCandidate = (candidate: Candidate): string => {
    const alias = typeof candidate.alias === "string" ? candidate.alias : "(unnamed)";
    const source = typeof candidate.provenance?.source === "string" ? `  ${candidate.provenance.source}` : "";
    const value = typeof candidate.definition?.value === "string" && candidate.definition.value.length > 0 ? `  =${candidate.definition.value}` : "";
    const summary = typeof candidate.summary === "string" ? `  ${candidate.summary}` : "";
    return `  ${alias}${source}${value}${summary}\n`;
};

const renderMutation = (result: MutationResult, verb: "added" | "replaced" | "enabled" | "disabled", aliasHint: string, write: (text: string) => void): void => {
    const alias = typeof result.alias === "string" ? result.alias : aliasHint;
    const state = typeof result.definition?.state === "string" ? ` (${result.definition.state})` : "";
    const problem = typeof result.definition?.problem?.detail === "string" ? `  — ${result.definition.problem.detail}` : "";
    write(`  ${verb}: ${alias}${state}${problem}\n`);
};

const usage = (write: (text: string) => void, subcommand?: string): void => {
    write(`  usage: ${commandUsage("env", subcommand)}\n`);
};

const list = async (rpc: ActionCaller, write: (text: string) => void, scope: string): Promise<unknown> => {
    const result = await rpc.call(`${scope}.env.list`, {}) as { definitions?: unknown };
    if (!Array.isArray(result.definitions)) throw new Error(`${scope}.env.list returned an invalid result.`);
    if (result.definitions.length === 0) write("  environment: none\n");
    else for (const definition of result.definitions) write(renderDefinition(definition as DefinitionState));
    return result;
};

// A value is used verbatim by the daemon, so the client hands it over verbatim
// too: `add/replace NAME <value>` takes the rest of the line as typed, never tokenized.
const definitionArguments = (input: string | readonly string[]): { name: string; value: string } | null => {
    if (typeof input === "string") {
        const match = /^\s*(?:add|replace)\s+(\S+)\s+([\s\S]+?)\s*$/u.exec(input);
        return match === null ? null : { name: match[1]!, value: match[2]! };
    }
    const [, name, ...rest] = input;
    if (name === undefined || name.length === 0 || rest.length === 0) return null;
    return { name, value: rest.join(" ") };
};

// `import <path>` takes the rest of the line as the path, as /import does.
const importPath = (input: string | readonly string[]): string | null => {
    if (typeof input === "string") {
        const match = /^\s*import\s+([\s\S]+?)\s*$/u.exec(input);
        return match === null ? null : match[1]!;
    }
    const [, ...rest] = input;
    return rest.length === 0 ? null : rest.join(" ");
};

// An import is one add per variable of the file: each lands or is refused on its own, exactly as it
// would typed, and the summary names the scope that received them.
const importFile = async (path: string, rpc: ActionCaller, write: (text: string) => void, scope: string): Promise<unknown | null> => {
    let text: string;
    try { text = await readFile(resolve(process.cwd(), path), "utf8"); }
    catch (cause) { write(`  not readable: ${cause instanceof Error ? cause.message : String(cause)}\n`); return null; }
    const entries = Object.entries(parseEnv(text));
    const added: MutationResult[] = [];
    for (const [alias, value] of entries) {
        try {
            const result = await rpc.call(`${scope}.env.add`, { alias, definition: { value: String(value) } }) as MutationResult;
            renderMutation(result, "added", alias, write);
            added.push(result);
        } catch (cause) {
            if (!(cause instanceof ProblemError)) throw cause;
            write(`  refused: ${alias}  — ${cause.problem.detail}\n`);
        }
    }
    const target = scope === "workspace" ? "the workspace defaults" : "this worker only (--scope workspace imports workspace defaults)";
    write(`  imported ${added.length} of ${entries.length} into ${target}\n`);
    return added;
};

export const handleEnv = async (
    input: string | readonly string[],
    rpc: ActionCaller,
    write: (text: string) => void,
): Promise<unknown | null> => {
    let scope = "worker";
    const tokens = typeof input === "string" ? input.trim().split(/\s+/u) : input;
    if (tokens[0] === "--scope" || tokens[0]?.startsWith("--scope=")) {
        const selected = tokens[0] === "--scope" ? tokens[1] : tokens[0].slice("--scope=".length);
        if (selected !== "worker" && selected !== "workspace") { usage(write); return null; }
        scope = selected;
        input = typeof input === "string"
            ? input.trimStart().replace(/^--scope(?:=\S+|\s+\S+)\s*/u, "")
            : input.slice(tokens[0] === "--scope" ? 2 : 1);
    }
    if (input.length === 0) return list(rpc, write, scope);

    const args = typeof input === "string" ? input.trim().split(/\s+/u) : [...input];
    if (args.length === 0 || args[0]!.length === 0) { usage(write); return null; }
    const [command, name] = args;

    if (command === "list" && args.length === 1) return list(rpc, write, scope);

    if (command === "discover") {
        const query = args.slice(1).join(" ");
        const result = await rpc.call(`${scope}.env.discover`, query.length === 0 ? {} : { query }) as { candidates?: unknown };
        if (!Array.isArray(result.candidates)) throw new Error(`${scope}.env.discover returned an invalid result.`);
        if (result.candidates.length === 0) write("  candidates: none\n");
        else for (const candidate of result.candidates) write(renderCandidate(candidate as Candidate));
        return result;
    }

    if (command === "add" || command === "replace") {
        const parsed = definitionArguments(input);
        if (parsed === null) {
            usage(write, command);
            return null;
        }
        const definition: EnvDefinition = { value: parsed.value };
        const result = await rpc.call(`${scope}.env.${command}`, { alias: parsed.name, definition }) as MutationResult;
        renderMutation(result, command === "add" ? "added" : "replaced", parsed.name, write);
        return result;
    }

    if (command === "enable" || command === "disable") {
        if (args.length !== 2 || name === undefined || name.length === 0) {
            usage(write, command);
            return null;
        }
        const result = await rpc.call(`${scope}.env.${command}`, { alias: name }) as MutationResult;
        renderMutation(result, command === "enable" ? "enabled" : "disabled", name, write);
        return result;
    }

    if (command === "import") {
        const path = importPath(input);
        if (path === null) {
            usage(write, "import");
            return null;
        }
        return importFile(path, rpc, write, scope);
    }

    if (command === "remove") {
        if (args.length !== 2 || name === undefined || name.length === 0) {
            usage(write, "remove");
            return null;
        }
        const result = await rpc.call(`${scope}.env.remove`, { alias: name });
        write(`  removed: ${name}\n`);
        return result;
    }

    usage(write);
    return null;
};
