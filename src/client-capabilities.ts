import type { RunAgentInput } from "@ag-ui/core";

// {§cli-worker-ownership} The client's capability set, declared on every Run: the client tools it
// implements, and whether a person attends it. Review is every AG-UI owner's (plurnk-service
// `{§agui-worker-owner}`) and always has a resolver here (a person, --yolo, or fail-closed headless
// review); clarification needs a person and a client that presents questions ({§cli-question-forms}).
export type ClientCapabilities = { readonly tools: RunAgentInput["tools"]; readonly interactive: boolean };

export const clientCapabilities = (interactive: boolean, presentsQuestions: boolean): ClientCapabilities => ({
    tools: interactive && presentsQuestions ? [
        { name: "question", description: "Ask the user for clarification.", parameters: { type: "object" } },
        { name: "mcp_input_required", description: "Request input for an MCP operation.", parameters: { type: "object" } },
    ] : [],
    interactive,
});
