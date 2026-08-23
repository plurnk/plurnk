// Thin TUI projection of the daemon-owned MCP Functionality family: one common
// lifecycle (list | discover | add | enable | disable | remove) plus the MCP
// OAuth continuation. The client composes exact definitions and renders the
// daemon's states; it owns no lifecycle policy.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

interface ActionCaller {
    call(method: string, params?: object): Promise<unknown>;
}

export interface McpClientConfiguration {
    // The client's own PLURNK_MCP_* environment, offered to the daemon as
    // discovery configuration; it contributes candidates, never durable state.
    readonly overlay?: Readonly<Record<string, string>>;
}

type Definition = Record<string, unknown> & { transport?: unknown; command?: unknown; url?: unknown; tools?: unknown };

type DefinitionState = {
    alias?: unknown;
    origin?: unknown;
    state?: unknown;
    definition?: Definition;
    detail?: { tools?: unknown };
    authorization?: { url?: unknown };
    problem?: { detail?: unknown };
};

type Candidate = { alias?: unknown; definition?: Definition; provenance?: { kind?: unknown; source?: unknown } };

type MutationResult = {
    status?: unknown;
    alias?: unknown;
    removed?: unknown;
    definition?: DefinitionState;
};

const readOptions = async (path: string): Promise<Record<string, unknown>> => {
    const absolute = resolve(path);
    let text: string;
    try {
        text = await readFile(absolute, "utf8");
    } catch (cause) {
        throw new Error(`MCP options not readable: ${absolute}`, { cause });
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text) as unknown;
    } catch (cause) {
        throw new Error(`MCP options are not valid JSON: ${absolute}`, { cause });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error(`MCP options must be a JSON object: ${absolute}`);
    }
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

// An absolute HTTP(S) target selects Streamable HTTP; anything else is one
// exact stdio executable. Options are the closed McpServerOptions supplement.
export const composeDefinition = (alias: string, target: string, options: Record<string, unknown> = {}): Definition =>
    /^https?:\/\//u.test(target)
        ? { name: alias, transport: "http", url: target, ...options }
        : { name: alias, transport: "stdio", command: target, ...options, args: Array.isArray(options.args) ? options.args : [] };

const targetOf = (definition: Definition | undefined): string | null => {
    if (definition === undefined) return null;
    if (definition.transport === "http" && typeof definition.url === "string") return definition.url;
    if (definition.transport === "stdio" && typeof definition.command === "string") return definition.command;
    return null;
};

const renderDefinition = (entry: DefinitionState): string => {
    const alias = typeof entry.alias === "string" ? entry.alias : "(unnamed)";
    const state = typeof entry.state === "string" ? entry.state : "unknown";
    const transport = typeof entry.definition?.transport === "string" ? entry.definition.transport : "unknown";
    const target = targetOf(entry.definition);
    const targetText = target === null ? "" : `  ${target}`;
    const enabledTools = Array.isArray(entry.definition?.tools) ? entry.definition.tools.length : null;
    const available = Array.isArray(entry.detail?.tools) ? entry.detail.tools.length : null;
    const count = enabledTools === null
        ? available === null ? null : String(available)
        : available === null ? String(enabledTools) : `${enabledTools}/${available}`;
    const tools = count === null ? "" : `  ${count} tools`;
    const origin = entry.origin === "service" ? "  (service)" : "";
    const problem = typeof entry.problem?.detail === "string" ? `  — ${entry.problem.detail}` : "";
    return `  ${alias}  ${state}  ${transport}${targetText}${tools}${origin}${problem}\n`;
};

const renderCandidate = (candidate: Candidate): string => {
    const alias = typeof candidate.alias === "string" ? candidate.alias : "(unnamed)";
    const transport = typeof candidate.definition?.transport === "string" ? candidate.definition.transport : "unknown";
    const target = targetOf(candidate.definition);
    return `  ${alias}  candidate  ${transport}${target === null ? "" : `  ${target}`}\n`;
};

const renderMutation = (
    result: MutationResult,
    verb: "added" | "enabled" | "disabled" | "authorized",
    aliasHint: string,
    write: (text: string) => void,
): void => {
    const alias = typeof result.alias === "string" ? result.alias : aliasHint;
    if (result.status === 202) {
        const url = result.definition?.authorization?.url;
        if (typeof url !== "string") throw new Error("MCP authorization response omitted its URL.");
        write(`  authorization required: ${url}\n`);
        write(`  complete: /mcp oauth ${alias} <callback-url>\n`);
        return;
    }
    const state = typeof result.definition?.state === "string" ? ` (${result.definition.state})` : "";
    write(`  ${verb}: ${alias}${state}\n`);
};

const usage = (write: (text: string) => void): void => {
    write("  usage: /mcp [discover <url|command> | add <alias> <target> [options.json] | enable <alias> [options.json] | disable|remove <alias> | oauth <alias> <callback-url>]\n");
};

const candidatesFrom = async (rpc: ActionCaller, overlay: Readonly<Record<string, string>>): Promise<Candidate[]> => {
    if (Object.keys(overlay).length === 0) return [];
    const discovered = await rpc.call("worker.mcp.discover", { configuration: overlay }) as { candidates?: unknown };
    if (!Array.isArray(discovered.candidates)) throw new Error("worker.mcp.discover returned an invalid result.");
    return discovered.candidates as Candidate[];
};

export const handleMcp = async (
    input: string | readonly string[],
    rpc: ActionCaller,
    write: (text: string) => void,
    configuration: McpClientConfiguration = {},
): Promise<unknown | null> => {
    const overlay = { ...configuration.overlay };
    if (input.length === 0) {
        const result = await rpc.call("worker.mcp.list", {}) as { definitions?: unknown };
        if (!Array.isArray(result.definitions)) throw new Error("worker.mcp.list returned an invalid result.");
        if (result.definitions.length === 0) write("  MCP servers: none\n");
        else for (const definition of result.definitions) write(renderDefinition(definition as DefinitionState));
        const candidates = await candidatesFrom(rpc, overlay);
        if (candidates.length > 0) {
            write("  from your configuration (not added):\n");
            for (const candidate of candidates) write(renderCandidate(candidate));
        }
        return result;
    }

    const args = typeof input === "string" ? argumentsOf(input) : [...input];
    if (args === null || args.length === 0) { usage(write); return null; }
    const [command, alias] = args;

    if (command === "discover") {
        if (args.length !== 2 || alias.length === 0) {
            write("  usage: /mcp discover <url|command>\n");
            return null;
        }
        const result = await rpc.call("worker.mcp.discover", { source: alias }) as { candidates?: unknown };
        if (!Array.isArray(result.candidates)) throw new Error("worker.mcp.discover returned an invalid result.");
        if (result.candidates.length === 0) write("  candidates: none\n");
        else for (const candidate of result.candidates) write(renderCandidate(candidate as Candidate));
        return result;
    }

    if (command === "add") {
        if (args.length < 3 || args.length > 4 || alias.length === 0 || args[2].length === 0) {
            write("  usage: /mcp add <alias> <target> [options.json]\n");
            return null;
        }
        const [, , target, path] = args;
        const options = path === undefined ? {} : await readOptions(path);
        const result = await rpc.call("worker.mcp.add", { alias, definition: composeDefinition(alias, target, options) }) as MutationResult;
        renderMutation(result, "added", alias, write);
        return result;
    }

    if (command === "enable") {
        if (args.length < 2 || args.length > 3 || alias.length === 0) {
            write("  usage: /mcp enable <alias> [options.json]\n");
            return null;
        }
        if (args[2] === undefined) {
            // A candidate from the client's own configuration is added; an
            // available definition is enabled.
            const candidate = (await candidatesFrom(rpc, overlay)).find((entry) => entry.alias === alias);
            const result = candidate?.definition === undefined
                ? await rpc.call("worker.mcp.enable", { alias }) as MutationResult
                : await rpc.call("worker.mcp.add", { alias, definition: candidate.definition }) as MutationResult;
            renderMutation(result, candidate === undefined ? "enabled" : "added", alias, write);
            return result;
        }
        // Options specialize the alias's current definition into this Worker's own.
        const options = await readOptions(args[2]);
        const listed = await rpc.call("worker.mcp.list", {}) as { definitions?: DefinitionState[] };
        const current = listed.definitions?.find((entry) => entry.alias === alias)?.definition
            ?? (await candidatesFrom(rpc, overlay)).find((entry) => entry.alias === alias)?.definition;
        if (current === undefined) throw new Error(`MCP server '${alias}' is not available to this Worker or your configuration.`);
        const result = await rpc.call("worker.mcp.add", { alias, definition: { ...current, ...options } }) as MutationResult;
        renderMutation(result, "added", alias, write);
        return result;
    }

    if (command === "disable") {
        if (args.length !== 2 || alias.length === 0) {
            write("  usage: /mcp disable <alias>\n");
            return null;
        }
        const result = await rpc.call("worker.mcp.disable", { alias }) as MutationResult;
        renderMutation(result, "disabled", alias, write);
        return result;
    }

    if (command === "remove") {
        if (args.length !== 2 || alias.length === 0) {
            write("  usage: /mcp remove <alias>\n");
            return null;
        }
        const result = await rpc.call("worker.mcp.remove", { alias });
        write(`  removed: ${alias}\n`);
        return result;
    }

    if (command === "oauth") {
        if (args.length !== 3 || alias.length === 0 || args[2].length === 0) {
            write("  usage: /mcp oauth <alias> <callback-url>\n");
            return null;
        }
        const result = await rpc.call("worker.mcp.oauth.complete", {
            alias,
            callbackUrl: args[2],
        }) as MutationResult;
        renderMutation(result, "authorized", alias, write);
        return result;
    }

    usage(write);
    return null;
};
