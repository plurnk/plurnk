import test from "node:test";
import assert from "node:assert/strict";
import { formatShare, shareFolder } from "./share.ts";

test("share folder: a leading ~/ expands to home; a relative folder resolves against the working directory", () => {
    assert.equal(shareFolder("~/share_this_session_here", "/work", "/home/tester"), "/home/tester/share_this_session_here");
    assert.equal(shareFolder("bug-report", "/work", "/home/tester"), "/work/bug-report");
    assert.equal(shareFolder("/abs/report", "/work", "/home/tester"), "/abs/report");
});

test("share output names the folder and that the share is unredacted", () => {
    assert.equal(formatShare({ folder: "/abs/report" }), [
        "share: /abs/report",
        "share: this holds what the models saw and wrote in this workspace, unredacted; review it before sending.",
    ].join("\n"));
});
