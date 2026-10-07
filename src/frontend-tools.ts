import type { RunAgentInput } from "@ag-ui/core";

// {§cli-worker-ownership} Approval always has a resolver, including fail-closed
// headless review. Clarification requires an interactive input channel.
export const frontendTools = (interactive: boolean): RunAgentInput["tools"] => [
    { name: "request_approval", description: "Review a proposed operation.", parameters: { type: "object" } },
    ...(interactive ? [
        { name: "question", description: "Ask the user for clarification.", parameters: { type: "object" } },
        { name: "mcp_input_required", description: "Request input for an MCP operation.", parameters: { type: "object" } },
    ] : []),
];
