import test from "node:test";
import assert from "node:assert/strict";
import { clientCapabilities } from "./client-capabilities.ts";

test("{§cli-worker-ownership} the capability set states the tools the client implements and whether a person attends", () => {
    const attended = clientCapabilities(true);
    assert.deepEqual([attended.tools.map(({ name }) => name), attended.interactive], [["request_approval", "question", "mcp_input_required"], true]);
    const unattended = clientCapabilities(false);
    assert.deepEqual([unattended.tools.map(({ name }) => name), unattended.interactive], [["request_approval"], false],
        "approval needs no person; clarification does");
});
