import { test } from "node:test";
import assert from "node:assert/strict";
import { attention, bell, concluded, type AttentionReason } from "./attention.ts";

test("[§cli-attention] a concluded loop is a reply at 200, a stop at 499, and a failure at any other end", () => {
    assert.equal(concluded(200, false), "reply");
    assert.equal(concluded(200, true), "failed", "a loop at its turn budget gave no reply");
    assert.equal(concluded(499, false), "stopped");
    for (const status of [400, 404, 409, 500, 503]) assert.equal(concluded(status, false), "failed", `status ${status}`);
});

test("[§cli-attention] the bell writes one BEL to a terminal and nothing to any other stream", () => {
    const written: string[] = [];
    const sink = (isTTY?: boolean) => ({ ...(isTTY === undefined ? {} : { isTTY }), write: (chunk: string) => written.push(chunk) });
    bell(sink(true))("reply");
    assert.deepEqual(written, ["\x07"]);
    bell(sink(false))("review");
    bell(sink())("question");
    assert.deepEqual(written, ["\x07"], "a pipe or a file hears nothing");
});

test("[§cli-attention] one raise reaches every sink with its reason", () => {
    const heard: string[] = [];
    const attend = attention([(reason: AttentionReason) => heard.push(`first:${reason}`), (reason) => heard.push(`second:${reason}`)]);
    attend("question");
    assert.deepEqual(heard, ["first:question", "second:question"]);
    assert.doesNotThrow(() => attention([])("reply"), "with no sink the signal reaches nobody");
});
