// Thin TUI projection of the daemon-owned MCP Functionality family: the common
// lifecycle (list | discover | add | enable | disable | remove) plus the MCP
// OAuth continuation. The client composes exact definitions and renders the
// daemon's states; configuration persistence, registry search and connections
// belong to the service.

import { commandUsage } from "./commands.ts";
import { configurationSource } from "./functionality-source.ts";
import Knobs, { KnobError } from "./knobs.ts";
import { receiveAuthorization } from "./oauth.ts";
import type { McpServerDefinition, FunctionalityListResult, FunctionalityMutationResult } from "@plurnk/plurnk-contracts";

interface ActionCaller {
    call(method: string, params?: object): Promise<unknown>;
}

// One listed or discovered definition: a stdio or streamable-http server entry.
type Definition = { type?: unknown; command?: unknown; url?: unknown };

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
export const composeDefinition = (alias: string, target: string, args: readonly string[] = []): McpServerDefinition =>
    HTTP_TARGET.test(target)
        ? { name: alias, type: "streamable-http", url: target }
        : { name: alias, type: "stdio", command: target, ...(args.length === 0 ? {} : { args: [...args] }) };

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
    const origin = entry.origin === "workspace" ? "  (workspace)" : "";
    const problem = typeof entry.problem?.detail === "string" ? `  — ${entry.problem.detail}` : "";
    return `  ${alias}  ${state}  ${typeOf(entry.definition)}${targetText}${tools}${origin}${configurationSource(entry)}${problem}\n`;
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
        write(`  authorization required: ${typeof url === "string" ? url : alias}\n`);
        write(`  authorize: /mcp oauth ${alias} [callback-url]\n`);
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
    options: { signal?: AbortSignal } = {},
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
        const [name, target, ...serverArgs] = args.slice(1);
        if (name === undefined || name.length === 0 || name.startsWith("--") || target === undefined || target.length === 0
            || (HTTP_TARGET.test(target) && serverArgs.length > 0)) {
            usage(write, "add");
            return null;
        }
        const definition = composeDefinition(name, target, serverArgs);
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
        if ((args.length !== 2 && args.length !== 3) || alias.length === 0 || args[2] === "") {
            usage(write, "oauth");
            return null;
        }
        const complete = (callbackUrl: string) => rpc.call("workspace.mcp.oauth.complete", { alias, callbackUrl }) as Promise<FunctionalityMutationResult>;
        let result: MutationResult;
        if (args[2] !== undefined) result = await complete(args[2]);
        else {
            const timeout = Knobs.count("PLURNK_CLIENT_OAUTH_TIMEOUT_MS");
            if (timeout === 0) throw new KnobError("PLURNK_CLIENT_OAUTH_TIMEOUT_MS", String(timeout), "must be positive.");
            const listed = await rpc.call("workspace.mcp.list", {}) as FunctionalityListResult;
            const entry = listed.definitions.find((item) => item.alias === alias);
            if (entry === undefined || entry.state === "disabled") throw new Error(`MCP server '${alias}' is not enabled in this workspace.`);
            if (entry.state === "active") result = { status: 200, alias, definition: entry };
            else {
                const definition = entry.definition as McpServerDefinition;
                const redirectUrl = definition.type === "streamable-http" && definition.authorization?.type === "oauth"
                    ? definition.authorization.redirectUrl : undefined;
                const deadline = AbortSignal.timeout(timeout);
                result = await receiveAuthorization({
                    ...(redirectUrl === undefined ? {} : { redirectUrl }),
                    begin: (redirectUrl) => rpc.call("workspace.mcp.oauth.begin", { alias, redirectUrl }) as Promise<FunctionalityMutationResult>,
                }, complete, {
                    signal: options.signal === undefined ? deadline : AbortSignal.any([options.signal, deadline]), write,
                });
            }
        }
        renderMutation(result, "authorized", alias, write);
        return result;
    }

    usage(write);
    return null;
};
