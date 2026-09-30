// Thin TUI projection of the daemon-owned MCP Functionality family: the common
// lifecycle (list | discover | add | enable | disable | remove) plus the MCP
// OAuth continuation. The client composes exact definitions and renders the
// daemon's states; the registry search, the Agent Plugin an added server
// becomes, and its connection are the service's.

import { commandUsage } from "./commands.ts";

interface ActionCaller {
    call(method: string, params?: object): Promise<unknown>;
}

type McpScope = "project" | "plurnk" | "global";

// The McpServerDefinition an add composes: a standard mcp.json server entry with its alias and
// scope. The service records the plugin that carries it.
type McpServerDefinition =
    | { name: string; scope: McpScope; type: "stdio"; command: string; args?: string[] }
    | { name: string; scope: McpScope; type: "streamable-http"; url: string };

// One listed or discovered definition: a stdio or streamable-http server entry.
type Definition = { type?: unknown; command?: unknown; url?: unknown; plugin?: { name?: unknown } };

type DefinitionState = {
    alias?: unknown;
    origin?: unknown;
    state?: unknown;
    definition?: Definition;
    detail?: { tools?: unknown };
    authorization?: { url?: unknown };
    problem?: { detail?: unknown };
};

type Candidate = { alias?: unknown; summary?: unknown; definition?: Definition };

type MutationResult = {
    status?: unknown;
    alias?: unknown;
    definition?: DefinitionState;
};

const HTTP_TARGET = /^https?:\/\//u;
const SCOPE_FLAGS: ReadonlyMap<string, McpScope> = new Map([["--plurnk", "plurnk"], ["--global", "global"]]);

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

// An absolute HTTP(S) target is a Streamable HTTP endpoint; anything else is one executable,
// whose arguments follow verbatim.
export const composeDefinition = (alias: string, scope: McpScope, target: string, args: readonly string[] = []): McpServerDefinition =>
    HTTP_TARGET.test(target)
        ? { name: alias, scope, type: "streamable-http", url: target }
        : { name: alias, scope, type: "stdio", command: target, ...(args.length === 0 ? {} : { args: [...args] }) };

const targetOf = (definition: Definition | undefined): string | null => {
    if (definition?.type === "stdio" && typeof definition.command === "string") return definition.command;
    if (definition?.type === "streamable-http" && typeof definition.url === "string") return definition.url;
    return null;
};

const typeOf = (definition: Definition | undefined): string =>
    typeof definition?.type === "string" ? definition.type : "unknown";

const renderDefinition = (entry: DefinitionState): string => {
    const alias = typeof entry.alias === "string" ? entry.alias : "(unnamed)";
    const state = typeof entry.state === "string" ? entry.state : "unknown";
    const target = targetOf(entry.definition);
    const targetText = target === null ? "" : `  ${target}`;
    // The catalog of an active server; the operator's tool narrowing is the daemon's setting.
    const tools = Array.isArray(entry.detail?.tools) ? `  ${entry.detail.tools.length} tools` : "";
    const plugin = typeof entry.definition?.plugin?.name === "string" ? `  plugin ${entry.definition.plugin.name}` : "";
    const origin = entry.origin === "workspace" ? "  (workspace)" : "";
    const problem = typeof entry.problem?.detail === "string" ? `  — ${entry.problem.detail}` : "";
    return `  ${alias}  ${state}  ${typeOf(entry.definition)}${targetText}${tools}${plugin}${origin}${problem}\n`;
};

const renderCandidate = (candidate: Candidate): string => {
    const alias = typeof candidate.alias === "string" ? candidate.alias : "(unnamed)";
    const target = targetOf(candidate.definition);
    const summary = typeof candidate.summary === "string" ? `  ${candidate.summary}` : "";
    return `  ${alias}  candidate  ${typeOf(candidate.definition)}${target === null ? "" : `  ${target}`}${summary}\n`;
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

const usage = (write: (text: string) => void, subcommand?: string): void => {
    write(`  usage: ${commandUsage("mcp", subcommand)}\n`);
};

export const handleMcp = async (
    input: string | readonly string[],
    rpc: ActionCaller,
    write: (text: string) => void,
): Promise<unknown | null> => {
    if (input.length === 0) {
        const result = await rpc.call("workspace.mcp.list", {}) as { definitions?: unknown };
        if (!Array.isArray(result.definitions)) throw new Error("workspace.mcp.list returned an invalid result.");
        if (result.definitions.length === 0) write("  MCP servers: none\n");
        else for (const definition of result.definitions) write(renderDefinition(definition as DefinitionState));
        return result;
    }

    const args = typeof input === "string" ? argumentsOf(input) : [...input];
    if (args === null || args.length === 0) { usage(write); return null; }
    const [command, alias] = args;

    if (command === "discover") {
        const query = args.slice(1).join(" ");
        if (query.length === 0) {
            usage(write, "discover");
            return null;
        }
        const result = await rpc.call("workspace.mcp.discover", { query }) as { candidates?: unknown };
        if (!Array.isArray(result.candidates)) throw new Error("workspace.mcp.discover returned an invalid result.");
        if (result.candidates.length === 0) write("  candidates: none\n");
        else for (const candidate of result.candidates) write(renderCandidate(candidate as Candidate));
        return result;
    }

    if (command === "add") {
        // The scope flag precedes the alias, so every token after the target is the server's own.
        const scope = SCOPE_FLAGS.get(args[1]);
        const [name, target, ...serverArgs] = args.slice(scope === undefined ? 1 : 2);
        if (name === undefined || name.length === 0 || target === undefined || target.length === 0
            || (HTTP_TARGET.test(target) && serverArgs.length > 0)) {
            usage(write, "add");
            return null;
        }
        const definition = composeDefinition(name, scope ?? "project", target, serverArgs);
        const result = await rpc.call("workspace.mcp.add", { alias: name, definition }) as MutationResult;
        renderMutation(result, "added", name, write);
        return result;
    }

    if (command === "enable" || command === "disable") {
        if (args.length !== 2 || alias.length === 0) {
            usage(write, command);
            return null;
        }
        const result = await rpc.call(`workspace.mcp.${command}`, { alias }) as MutationResult;
        renderMutation(result, command === "enable" ? "enabled" : "disabled", alias, write);
        return result;
    }

    if (command === "remove") {
        if (args.length !== 2 || alias.length === 0) {
            usage(write, "remove");
            return null;
        }
        const result = await rpc.call("workspace.mcp.remove", { alias });
        write(`  removed: ${alias}\n`);
        return result;
    }

    if (command === "oauth") {
        if (args.length !== 3 || alias.length === 0 || args[2].length === 0) {
            usage(write, "oauth");
            return null;
        }
        const result = await rpc.call("workspace.mcp.oauth.complete", {
            alias,
            callbackUrl: args[2],
        }) as MutationResult;
        renderMutation(result, "authorized", alias, write);
        return result;
    }

    usage(write);
    return null;
};
