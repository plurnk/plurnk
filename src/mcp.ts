// Thin TUI projection of daemon-owned workspace MCP management.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

interface ActionCaller {
    call(method: string, params?: object): Promise<unknown>;
}

type McpServerSummary = {
    name?: unknown;
    state?: unknown;
    transport?: unknown;
    enabledTools?: unknown;
    tools?: unknown;
};

type McpMutationResult = {
    status?: unknown;
    authorization?: { url?: unknown };
    server?: McpServerSummary;
};

const readDefinition = async (path: string): Promise<unknown> => {
    const absolute = resolve(path);
    let text: string;
    try {
        text = await readFile(absolute, "utf8");
    } catch (cause) {
        throw new Error(`MCP definition not readable: ${absolute}`, { cause });
    }
    try {
        return JSON.parse(text) as unknown;
    } catch (cause) {
        throw new Error(`MCP definition is not valid JSON: ${absolute}`, { cause });
    }
};

const definitionName = (definition: unknown): string =>
    typeof definition === "object"
        && definition !== null
        && "name" in definition
        && typeof definition.name === "string"
        ? definition.name
        : "<name>";

const renderServer = (server: McpServerSummary): string => {
    const name = typeof server.name === "string" ? server.name : "(unnamed)";
    const state = typeof server.state === "string" ? server.state : "unknown";
    const transport = typeof server.transport === "string" ? server.transport : "unknown";
    const available = Array.isArray(server.tools) ? server.tools.length : null;
    const enabled = Array.isArray(server.enabledTools) ? server.enabledTools.length : null;
    const count = enabled === null ? available : available === null ? String(enabled) : `${enabled}/${available}`;
    const tools = count === null ? "" : `  ${count} tool${count === 1 ? "" : "s"}`;
    return `  ${name}  ${state}  ${transport}${tools}\n`;
};

const renderMutation = (
    result: McpMutationResult,
    verb: "attached" | "replaced" | "reconnected" | "authorized",
    nameHint: string,
    write: (text: string) => void,
): void => {
    if (result.status === 202) {
        const url = result.authorization?.url;
        if (typeof url !== "string") throw new Error("MCP authorization response omitted its URL.");
        write(`  authorization required: ${url}\n`);
        write(`  complete: /mcp oauth ${nameHint} <callback-url>\n`);
        return;
    }
    const name = typeof result.server?.name === "string" ? result.server.name : nameHint;
    const state = typeof result.server?.state === "string" ? ` (${result.server.state})` : "";
    write(`  ${verb}: ${name}${state}\n`);
};

export const handleMcp = async (
    rest: string,
    rpc: ActionCaller,
    write: (text: string) => void,
): Promise<void> => {
    if (rest.length === 0) {
        const result = await rpc.call("workspace.mcp.list") as { servers?: unknown };
        if (!Array.isArray(result.servers)) throw new Error("workspace.mcp.list returned an invalid result.");
        if (result.servers.length === 0) write("  MCP servers: none\n");
        else for (const server of result.servers) write(renderServer(server as McpServerSummary));
        return;
    }

    if (rest === "replace" || rest.startsWith("replace ")) {
        const path = rest.slice("replace".length).trim();
        if (path.length === 0) { write("  usage: /mcp replace <definition.json>\n"); return; }
        const server = await readDefinition(path);
        const result = await rpc.call("workspace.mcp.replace", { server }) as McpMutationResult;
        renderMutation(result, "replaced", definitionName(server), write);
        return;
    }

    for (const action of ["detach", "reconnect"] as const) {
        if (rest === action || rest.startsWith(`${action} `)) {
            const name = rest.slice(action.length).trim();
            if (!/^\S+$/.test(name)) { write(`  usage: /mcp ${action} <name>\n`); return; }
            const result = await rpc.call(`workspace.mcp.${action}`, { name }) as McpMutationResult;
            if (action === "detach") write(`  detached: ${name}\n`);
            else renderMutation(result, "reconnected", name, write);
            return;
        }
    }

    if (rest === "oauth" || rest.startsWith("oauth ")) {
        const match = rest.match(/^oauth\s+(\S+)\s+(\S+)$/);
        if (!match) { write("  usage: /mcp oauth <name> <callback-url>\n"); return; }
        const [, name, callbackUrl] = match;
        const result = await rpc.call("workspace.mcp.oauth.complete", { name, callbackUrl }) as McpMutationResult;
        renderMutation(result, "authorized", name, write);
        return;
    }

    const server = await readDefinition(rest);
    const result = await rpc.call("workspace.mcp.attach", { server }) as McpMutationResult;
    renderMutation(result, "attached", definitionName(server), write);
};
