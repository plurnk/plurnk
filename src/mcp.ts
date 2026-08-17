// Thin TUI projection of daemon-owned workspace MCP management.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

interface ActionCaller {
    call(method: string, params?: object): Promise<unknown>;
}

export interface McpClientConfiguration {
    readonly overlay?: Readonly<Record<string, string>>;
}

type McpServerSummary = {
    alias?: unknown;
    state?: unknown;
    transport?: unknown;
    target?: unknown;
    enabledTools?: unknown;
    tools?: unknown;
};

type McpMutationResult = {
    status?: unknown;
    authorization?: { url?: unknown };
    server?: McpServerSummary;
};

const readOptions = async (path: string): Promise<unknown> => {
    const absolute = resolve(path);
    let text: string;
    try {
        text = await readFile(absolute, "utf8");
    } catch (cause) {
        throw new Error(`MCP options not readable: ${absolute}`, { cause });
    }
    try {
        return JSON.parse(text) as unknown;
    } catch (cause) {
        throw new Error(`MCP options are not valid JSON: ${absolute}`, { cause });
    }
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

const renderServer = (server: McpServerSummary): string => {
    const alias = typeof server.alias === "string" ? server.alias : "(unnamed)";
    const state = typeof server.state === "string" ? server.state : "unknown";
    const transport = typeof server.transport === "string" ? server.transport : "unknown";
    const target = typeof server.target === "string" ? `  ${server.target}` : "";
    const available = Array.isArray(server.tools) ? server.tools.length : null;
    const enabled = Array.isArray(server.enabledTools) ? server.enabledTools.length : null;
    const count = enabled === null
        ? available === null ? null : String(available)
        : available === null ? String(enabled) : `${enabled}/${available}`;
    const tools = count === null ? "" : `  ${count} tools`;
    return `  ${alias}  ${state}  ${transport}${target}${tools}\n`;
};

const renderMutation = (
    result: McpMutationResult,
    verb: "added" | "enabled" | "disabled" | "authorized",
    aliasHint: string,
    write: (text: string) => void,
): void => {
    if (result.status === 202) {
        const url = result.authorization?.url;
        if (typeof url !== "string") throw new Error("MCP authorization response omitted its URL.");
        write(`  authorization required: ${url}\n`);
        write(`  complete: /mcp oauth ${aliasHint} <callback-url>\n`);
        return;
    }
    const alias = typeof result.server?.alias === "string" ? result.server.alias : aliasHint;
    const state = typeof result.server?.state === "string" ? ` (${result.server.state})` : "";
    write(`  ${verb}: ${alias}${state}\n`);
};

const usage = (write: (text: string) => void): void => {
    write("  usage: /mcp [add <alias> <target> [options.json] | enable <alias> [options.json] | disable|remove <alias> | oauth <alias> <callback-url>]\n");
};

export const handleMcp = async (
    input: string | readonly string[],
    rpc: ActionCaller,
    write: (text: string) => void,
    configuration: McpClientConfiguration = {},
): Promise<unknown | null> => {
    const overlay = { ...configuration.overlay };
    if (input.length === 0) {
        const result = await rpc.call("workspace.mcp.list", { overlay }) as { servers?: unknown };
        if (!Array.isArray(result.servers)) throw new Error("workspace.mcp.list returned an invalid result.");
        if (result.servers.length === 0) write("  MCP servers: none\n");
        else for (const server of result.servers) write(renderServer(server as McpServerSummary));
        return result;
    }

    const args = typeof input === "string" ? argumentsOf(input) : [...input];
    if (args === null || args.length === 0) { usage(write); return null; }
    const [command, alias] = args;

    if (command === "add") {
        if (args.length < 3 || args.length > 4 || alias.length === 0 || args[2].length === 0) {
            write("  usage: /mcp add <alias> <target> [options.json]\n");
            return null;
        }
        const [, , target, path] = args;
        const options = path === undefined ? undefined : await readOptions(path);
        const result = await rpc.call("workspace.mcp.add", {
            alias,
            target,
            ...(options === undefined ? {} : { options }),
        }) as McpMutationResult;
        renderMutation(result, "added", alias, write);
        return result;
    }

    if (command === "enable") {
        if (args.length < 2 || args.length > 3 || alias.length === 0) {
            write("  usage: /mcp enable <alias> [options.json]\n");
            return null;
        }
        const options = args[2] === undefined ? undefined : await readOptions(args[2]);
        const result = await rpc.call("workspace.mcp.enable", {
            alias,
            overlay,
            ...(options === undefined ? {} : { options }),
        }) as McpMutationResult;
        renderMutation(result, "enabled", alias, write);
        return result;
    }

    if (command === "disable") {
        if (args.length !== 2 || alias.length === 0) {
            write("  usage: /mcp disable <alias>\n");
            return null;
        }
        const result = await rpc.call("workspace.mcp.disable", { alias }) as McpMutationResult;
        renderMutation(result, "disabled", alias, write);
        return result;
    }

    if (command === "remove") {
        if (args.length !== 2 || alias.length === 0) {
            write("  usage: /mcp remove <alias>\n");
            return null;
        }
        const result = await rpc.call("workspace.mcp.remove", { alias });
        write(`  removed: ${alias}\n`);
        return result;
    }

    if (command === "oauth") {
        if (args.length !== 3 || alias.length === 0 || args[2].length === 0) {
            write("  usage: /mcp oauth <alias> <callback-url>\n");
            return null;
        }
        const result = await rpc.call("workspace.mcp.oauth.complete", {
            alias,
            callbackUrl: args[2],
        }) as McpMutationResult;
        renderMutation(result, "authorized", alias, write);
        return result;
    }

    usage(write);
    return null;
};
