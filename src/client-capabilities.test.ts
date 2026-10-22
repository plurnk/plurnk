import test from "node:test";
import assert from "node:assert/strict";
import { clientCapabilities } from "./client-capabilities.ts";

test("[§cli-worker-ownership] the capability set states the tools the client implements and whether a person attends", () => {
    const rows: Array<[boolean, boolean, string[], string]> = [
        [true, true, ["question", "mcp_input_required"], "a person at a client that presents questions is offered them"],
        [true, false, [], "a person at a client with no question forms is offered none"],
        [false, true, [], "approval needs no person; clarification does"],
        [false, false, [], "nobody attends"],
    ];
    for (const [interactive, presents, tools, why] of rows) {
        const declared = clientCapabilities(interactive, presents);
        assert.deepEqual([declared.tools.map(({ name }) => name), declared.interactive], [tools, interactive], why);
    }
});
