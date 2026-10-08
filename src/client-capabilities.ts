import type { RunAgentInput } from "@ag-ui/core";

// {§cli-worker-ownership} The client's capability set, declared on every Run: the client tools it
// implements, and whether a person attends it. Approval always has a resolver (a person, --yolo,
// or fail-closed headless review); clarification needs a person.
export type ClientCapabilities = { readonly tools: RunAgentInput["tools"]; readonly interactive: boolean };

export const clientCapabilities = (interactive: boolean): ClientCapabilities => ({
    tools: [
        { name: "request_approval", description: "Review a proposed operation.", parameters: { type: "object" } },
        ...(interactive ? [
            { name: "question", description: "Ask the user for clarification.", parameters: { type: "object" } },
            { name: "mcp_input_required", description: "Request input for an MCP operation.", parameters: { type: "object" } },
        ] : []),
    ],
    interactive,
});
