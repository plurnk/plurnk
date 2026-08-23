// Thin TUI projection of the daemon-owned outbound A2A agents Functionality
// family: the common lifecycle (list | discover | add | enable | disable |
// remove) over the Worker's `agents` actions. The client composes exact
// A2aAgentDefinitions and renders the daemon's states; card discovery,
// connection, and enablement policy live in the service.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

interface ActionCaller {
    call(method: string, params?: object): Promise<unknown>;
}

type Definition = Record<string, unknown> & { name?: unknown; url?: unknown };

type DefinitionState = {
    alias?: unknown;
    origin?: unknown;
    state?: unknown;
    definition?: Definition;
    detail?: { name?: unknown; version?: unknown; description?: unknown; skills?: unknown };
    problem?: { detail?: unknown };
};

type Candidate = { alias?: unknown; summary?: unknown; definition?: Definition; provenance?: { kind?: unknown; source?: unknown; reference?: unknown } };

type MutationResult = { status?: unknown; alias?: unknown; removed?: unknown; definition?: DefinitionState };

const readOptions = async (path: string): Promise<Record<string, unknown>> => {
    const absolute = resolve(path);
    let text: string;
    try {
        text = await readFile(absolute, "utf8");
    } catch (cause) {
        throw new Error(`agent options not readable: ${absolute}`, { cause });
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text) as unknown;
    } catch (cause) {
        throw new Error(`agent options are not valid JSON: ${absolute}`, { cause });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error(`agent options must be a JSON object: ${absolute}`);
    return parsed as Record<string, unknown>;
};

const argumentsOf = (source: string): string[] | null => {
    const values: string[] = [];
    let value = "";
    let quote: "\"" | "'" | null = null;
    let escaped = false;
    let started = false;
    for (const character of source) {
        if (escaped) {
            value += character;
            escaped = false;
            started = true;
            continue;
        }
        if (character === "\\") {
            escaped = true;
            started = true;
            continue;
        }
        if (quote !== null) {
            if (character === quote) quote = null;
            else value += character;
            started = true;
            continue;
        }
        if (character === "\"" || character === "'") {
            quote = character;
            started = true;
            continue;
        }
        if (/\s/u.test(character)) {
            if (started) {
                values.push(value);
                value = "";
                started = false;
            }
            continue;
        }
        value += character;
        started = true;
    }
    if (escaped || quote !== null) return null;
    if (started) values.push(value);
    return values;
};

// The alias is the definition's name and `a2a://` authority; options supply
// the remaining A2aAgentDefinition members (cardPath, headers, authorization).
export const composeDefinition = (alias: string, url: string, options: Record<string, unknown> = {}): Definition =>
    ({ name: alias, url, ...options });

const renderDefinition = (entry: DefinitionState): string => {
    const alias = typeof entry.alias === "string" ? entry.alias : "(unnamed)";
    const state = typeof entry.state === "string" ? entry.state : "unknown";
    const url = typeof entry.definition?.url === "string" ? `  ${entry.definition.url}` : "";
    const name = typeof entry.detail?.name === "string" ? `  ${entry.detail.name}` : "";
    const version = typeof entry.detail?.version === "string" && entry.detail.version.length > 0 ? ` v${entry.detail.version}` : "";
    const skills = Array.isArray(entry.detail?.skills) ? `  ${entry.detail.skills.length} skills` : "";
    const origin = entry.origin === "service" ? "  (service)" : "";
    const problem = typeof entry.problem?.detail === "string" ? `  — ${entry.problem.detail}` : "";
    return `  ${alias}  ${state}${url}${name}${version}${skills}${origin}${problem}\n`;
};

const renderCandidate = (candidate: Candidate): string => {
    const alias = typeof candidate.alias === "string" ? candidate.alias : "(unnamed)";
    const url = typeof candidate.definition?.url === "string" ? `  ${candidate.definition.url}` : "";
    const summary = typeof candidate.summary === "string" ? `  ${candidate.summary}` : "";
    return `  ${alias}  candidate${url}${summary}\n`;
};

const renderMutation = (result: MutationResult, verb: "added" | "enabled" | "disabled", aliasHint: string, write: (text: string) => void): void => {
    const alias = typeof result.alias === "string" ? result.alias : aliasHint;
    const state = typeof result.definition?.state === "string" ? ` (${result.definition.state})` : "";
    const problem = typeof result.definition?.problem?.detail === "string" ? `  — ${result.definition.problem.detail}` : "";
    write(`  ${verb}: ${alias}${state}${problem}\n`);
};

const usage = (write: (text: string) => void): void => {
    write("  usage: /agents [discover <url> | add <alias> <url> [options.json] | enable|disable|remove <alias>]\n");
};

export const handleAgents = async (
    input: string | readonly string[],
    rpc: ActionCaller,
    write: (text: string) => void,
): Promise<unknown | null> => {
    if (input.length === 0) {
        const result = await rpc.call("worker.agents.list", {}) as { definitions?: unknown };
        if (!Array.isArray(result.definitions)) throw new Error("worker.agents.list returned an invalid result.");
        if (result.definitions.length === 0) write("  A2A agents: none\n");
        else for (const definition of result.definitions) write(renderDefinition(definition as DefinitionState));
        return result;
    }

    const args = typeof input === "string" ? argumentsOf(input) : [...input];
    if (args === null || args.length === 0) { usage(write); return null; }
    const [command, alias] = args;

    if (command === "discover") {
        if (args.length !== 2 || alias.length === 0) {
            write("  usage: /agents discover <url>\n");
            return null;
        }
        const result = await rpc.call("worker.agents.discover", { source: alias }) as { candidates?: unknown };
        if (!Array.isArray(result.candidates)) throw new Error("worker.agents.discover returned an invalid result.");
        if (result.candidates.length === 0) write("  candidates: none\n");
        else for (const candidate of result.candidates) write(renderCandidate(candidate as Candidate));
        return result;
    }

    if (command === "add") {
        if (args.length < 3 || args.length > 4 || alias.length === 0 || args[2].length === 0) {
            write("  usage: /agents add <alias> <url> [options.json]\n");
            return null;
        }
        const [, , url, path] = args;
        const options = path === undefined ? {} : await readOptions(path);
        const result = await rpc.call("worker.agents.add", { alias, definition: composeDefinition(alias, url, options) }) as MutationResult;
        renderMutation(result, "added", alias, write);
        return result;
    }

    if (command === "enable" || command === "disable") {
        if (args.length !== 2 || alias.length === 0) {
            write(`  usage: /agents ${command} <alias>\n`);
            return null;
        }
        const result = await rpc.call(`worker.agents.${command}`, { alias }) as MutationResult;
        renderMutation(result, command === "enable" ? "enabled" : "disabled", alias, write);
        return result;
    }

    if (command === "remove") {
        if (args.length !== 2 || alias.length === 0) {
            write("  usage: /agents remove <alias>\n");
            return null;
        }
        const result = await rpc.call("worker.agents.remove", { alias });
        write(`  removed: ${alias}\n`);
        return result;
    }

    usage(write);
    return null;
};
