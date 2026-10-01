import assert from "node:assert/strict";
import { test } from "node:test";
import ToolAcceptance from "./tool-acceptance.ts";
import type { Notice } from "./diagnostics.ts";
import type { ProposalParams } from "./proposal.ts";

const proposal = (op = "brave", target = "brave_web_search"): ProposalParams => ({
    logEntryId: 1, loopId: 1, turnId: 1, op,
    target: { scheme: "worker", pathname: "/output" },
    body: '{"query":"example"}', attrs: { runtime: op, target },
    policy: { proposals: "review", attended: true },
});
const policy = (environment: NodeJS.ProcessEnv) => new ToolAcceptance((notice) => assert.fail(notice.message ?? "Unexpected diagnostic"), environment);
const manual = { yolo: false };
const piped = { yolo: false, noReviewChannel: true };

test("[§cli-tool-acceptance]: runtime switches and exact tool restrictions never grant implicit acceptance", () => {
    for (const environment of [
        {},
        { PLURNK_CLIENT_ACCEPT_brave: "0" },
        { PLURNK_CLIENT_ACCEPT_brave_TOOLS: '["brave_web_search"]' },
        { PLURNK_CLIENT_ACCEPT_brave: "1", PLURNK_CLIENT_ACCEPT_brave_TOOLS: "[]" },
    ]) {
        const configured = policy(environment);
        assert.equal(configured.enabled, false);
        assert.equal(configured.resolve(proposal(), manual), null);
        assert.deepEqual(configured.resolve(proposal(), piped), { decision: "reject", outcome: "client_no_review_channel" });
    }
    const all = policy({ PLURNK_CLIENT_ACCEPT_brave: "1" });
    assert.equal(all.enabled, true);
    assert.deepEqual(all.resolve(proposal(), manual), { decision: "accept", outcome: "auto: brave" });
    assert.deepEqual(all.resolve(proposal("brave", "other"), piped), { decision: "accept", outcome: "auto: brave" });
    assert.equal(all.resolve(proposal("sh"), manual), null);

    const restricted = policy({ PLURNK_CLIENT_ACCEPT_brave: "yes", PLURNK_CLIENT_ACCEPT_brave_TOOLS: '["brave_web_search"]' });
    assert.equal(restricted.enabled, true);
    assert.deepEqual(restricted.resolve(proposal(), piped), { decision: "accept", outcome: "auto: brave (brave_web_search)" });
    for (const target of ["BRAVE_WEB_SEARCH", "brave_web_search extra", "brave_news_search", ""]) {
        assert.equal(restricted.resolve(proposal("brave", target), manual), null);
    }
    assert.equal(policy({ PLURNK_CLIENT_ACCEPT_brave: "1", PLURNK_CLIENT_ACCEPT_brave_TOOLS: '["*"]' }).resolve(proposal(), manual), null);
});

test("[§cli-tool-acceptance]: matching uses execution identity, never displayed paths, bodies or resource scripts", () => {
    const configured = policy({ PLURNK_CLIENT_ACCEPT_brave: "1", PLURNK_CLIENT_ACCEPT_brave_TOOLS: '["brave_web_search"]' });
    for (const attrs of [null, {}, { runtime: "other", target: "brave_web_search" }, { runtime: "brave", target: 1 },
        { runtime: "brave", target: "brave_web_search", resourceSource: "file:///script" }]) {
        assert.equal(configured.resolve({ ...proposal(), attrs }, manual), null);
    }
    assert.equal(configured.resolve({ ...proposal(), op: "EDIT" }, manual), null);
    assert.deepEqual(policy({ PLURNK_CLIENT_ACCEPT_web_search: "1" }).resolve(proposal("web-search"), manual), {
        decision: "accept", outcome: "auto: web-search",
    });
});

test("[§cli-tool-acceptance]: explicit review overrides YOLO and selective acceptance", () => {
    const configured = policy({ PLURNK_CLIENT_ACCEPT_brave: "1" });
    assert.deepEqual(configured.resolve(proposal("EDIT"), { yolo: true }), { decision: "accept", outcome: "client_yolo" });
    for (const yolo of [false, true]) {
        assert.equal(configured.resolve(proposal(), { yolo, reviewRequested: true }), null);
        assert.deepEqual(configured.resolve(proposal(), { yolo, reviewRequested: true, noReviewChannel: true }), {
            decision: "reject", outcome: "client_no_review_channel",
        });
    }
});

test("[§cli-tool-acceptance]: malformed configuration diagnoses and disables selective acceptance without preventing repair", () => {
    for (const [key, value] of [
        ["PLURNK_CLIENT_ACCEPT_brave", "maybe"],
        ["PLURNK_CLIENT_ACCEPT_brave_TOOLS", "broken"],
        ["PLURNK_CLIENT_ACCEPT_brave_TOOLS", '"brave_web_search"'],
        ["PLURNK_CLIENT_ACCEPT_brave_TOOLS", '[1]'],
        ["PLURNK_CLIENT_ACCEPT_brave_TOOLS", '[""]'],
        ["PLURNK_CLIENT_ACCEPT_BRAVE", "1"],
        ["PLURNK_CLIENT_ACCEPT_web-search", "1"],
        ["PLURNK_CLIENT_ACCEPT_", "1"],
    ]) {
        const notices: Notice[] = [];
        const configured = new ToolAcceptance((notice) => notices.push(notice), { PLURNK_CLIENT_ACCEPT_brave: "1", [key]: value });
        assert.equal(configured.enabled, false, key);
        assert.equal(configured.resolve(proposal(), manual), null, key);
        assert.deepEqual(configured.resolve(proposal(), { yolo: true }), { decision: "accept", outcome: "client_yolo" });
        assert.equal(notices.length, 1);
        assert.equal(notices[0].kind, "acceptance-unavailable");
        assert.equal(notices[0].knob, key);
        assert.match(notices[0].message ?? "", /Configured tool acceptance is disabled/);
        assert.ok(notices[0].cause instanceof Error);
    }
});
