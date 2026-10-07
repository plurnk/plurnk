import test from "node:test";
import assert from "node:assert/strict";
import { frontendTools } from "./frontend-tools.ts";

test("{§cli-worker-ownership} frontend tools describe handlers, not message-carried policy", () => {
    assert.deepEqual(frontendTools(false).map(({ name }) => name), ["request_approval"]);
    assert.deepEqual(frontendTools(true).map(({ name }) => name), ["request_approval", "question", "mcp_input_required"]);
});
