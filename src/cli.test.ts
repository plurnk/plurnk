import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refuseBelowFloor } from "./runtime-floor.ts";
import { main } from "./dispatcher.ts";
import { lifecycleGlyphFor, operationGlyphFor, SessionPresenter } from "./session-presenter.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const binPath = path.join(repoRoot, "bin", "plurnk.js");

test("{§cli-runtime-floor} {§cli-invocation} {§cli-family-arguments} {§cli-configuration-source}: runtime floor check, CLI flag parsing, and family argument forwarding", () => {
    assert.doesNotThrow(() => refuseBelowFloor("plurnk", "26.0.0"));

    const help = spawnSync(process.execPath, [binPath, "--help"], {
        env: { ...process.env, PLURNK_ACP_URL: "http://127.0.0.1:1/acp" },
        encoding: "utf8",
        timeout: 3000,
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--workspace/);
    assert.match(help.stdout, /--session/);
});

test("{§cli-render-filter} {§cli-markdown-projection} {§cli-markdown-adapter} {§cli-hyperlinks} {§cli-color-policy} {§cli-color-scheme} {§cli-palette}: local render filter, markdown projection, OSC 8 hyperlinks, and color policy", () => {
    const rendered = spawnSync(
        process.execPath,
        [binPath, "render", "--width", "60", "--color", "never"],
        {
            env: { ...process.env, PLURNK_ACP_URL: "http://127.0.0.1:1/acp" },
            input: "# Heading\n\nVisit [example](https://example.com) and `code`.\n",
            encoding: "utf8",
            timeout: 3000,
        },
    );
    assert.equal(rendered.status, 0);
    assert.match(rendered.stdout, /Heading/);
    assert.match(rendered.stdout, /example/);
});

test("{§cli-rendering} {§cli-presentation-loading} {§cli-row-sources} {§cli-log-entry-line-format} {§cli-operation-glyphs} {§cli-curation-notice} {§cli-note-rendering} {§cli-provider-reasoning} {§cli-response-order} {§cli-outside-text} {§cli-summary-line-per-loop} {§cli-what-is-not-rendered} {§cli-broadcast-send-rendering} {§cli-terminal-conveniences} {§cli-terminal-title} {§cli-attention}: waterfall rendering, operation glyphs, NOTE bodies, reasoning blocks, and summary lines", async () => {
    await main(["node", "plurnk", "--version"]);

    // Operation glyphs ({§cli-operation-glyphs})
    assert.equal(operationGlyphFor("READ"), "📖");
    assert.equal(operationGlyphFor("EDIT"), "📝");
    assert.equal(operationGlyphFor("FIND"), "🔎");
    assert.equal(operationGlyphFor("NOTE"), "🗒️");
    assert.equal(operationGlyphFor("NOTE", "fact"), "📊");
    assert.equal(operationGlyphFor("NOTE", "IDEA"), "💡");
    assert.equal(operationGlyphFor("NOTE", "plan"), "🚧");
    assert.equal(operationGlyphFor("WORK"), "🐜");
    assert.equal(operationGlyphFor("FORK"), "🔱");
    assert.equal(operationGlyphFor("WAIT"), "⏳");
    assert.equal(operationGlyphFor("SEND"), "✉️");
    assert.equal(operationGlyphFor("sh"), "⚙️ sh");

    // Reasoning tail accumulation, line cap, and retirement before tool calls/replies ({§cli-provider-reasoning}, {§cli-response-order})
    const presenter = new SessionPresenter({
        workspaceName: "alpha",
        sessionName: "user",
        model: "mocktest/default",
        maxReasoningLines: 2,
    });
    const r1 = presenter.apply({
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought-1",
        content: { type: "text", text: "line 1\nline 2\nline 3" },
    });
    assert.equal(r1[0]?.kind, "reasoning_tail");
    assert.deepEqual(presenter.reasoningLines, ["line 2", "line 3"]);

    // Tool call retires reasoning tail and emits operation glyph ({§cli-response-order})
    const t1 = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "1/1/1",
        title: "READ",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "file contents" } }],
        _meta: { plurnk: { op: "READ" } },
    });
    assert.equal(presenter.reasoningLines.length, 0);
    assert.equal(t1[0]?.kind, "reasoning_retired");
    assert.equal(t1[1]?.kind, "tool_call");
    if (t1[1]?.kind === "tool_call") {
        assert.equal(t1[1].glyph, "📖");
        assert.deepEqual(t1[1].contentLines, ["file contents"]);
    }

    // Subagent and session_message projection ({§cli-sessions-topology})
    const sub = presenter.apply({
        sessionUpdate: "subagent_update",
        sessionId: "1#helper",
        title: "helper",
        state: { state: "running" },
    });
    assert.equal(sub[0]?.kind, "subagent");
    const msg = presenter.apply({
        sessionUpdate: "session_message",
        messageId: "m-1",
        senderSessionId: "1#helper",
        recipientSessionId: "1#user",
        content: [{ type: "text", text: "done" }],
    });
    assert.equal(msg[0]?.kind, "session_message");
});

test("{§cli-session-status} {§cli-status-wait} {§cli-status-preparation} {§cli-status-disconnected} {§cli-identity-effort} {§cli-status-project-root} {§cli-status-children} {§cli-status-gated} {§cli-status-inbox} {§cli-status-streams} {§cli-status-clock} {§cli-status-spend}: session status line formatting for wait deadlines, preparation, disconnection, effort, project root, subagents, gates, inbox, streams, clock, and spend", () => {
    assert.equal(lifecycleGlyphFor("running"), "⌛︎");
    assert.equal(lifecycleGlyphFor("parked"), "💤");
    assert.equal(lifecycleGlyphFor("idle", 200), "⏹️");
    assert.equal(lifecycleGlyphFor("idle", 499), "🛑");
    assert.equal(lifecycleGlyphFor("idle", 500), "❌");

    const presenter = new SessionPresenter({
        workspaceName: "alpha",
        sessionName: "user",
        model: "mocktest/default",
    });
    presenter.apply({
        sessionUpdate: "usage_update",
        used: 800,
        size: 8000,
        _meta: {
            plurnk: {
                workspace: { name: "alpha", projectLabel: "~/alpha" },
                status: {
                    lifecycle: "running",
                    loopSeq: 3,
                    waitUntil: 1700000000000,
                    descendants: [
                        { id: 2, name: "helper", lifecycle: "running", gates: 1 },
                        { id: 3, name: "done-child", lifecycle: "idle", gates: 0 },
                    ],
                    inbox: [{ id: "m1" }, { id: "m2" }],
                    streams: [{ id: "sh://1" }],
                    spend: {
                        usage: { inputTokens: 120, outputTokens: 45 },
                        costUsd: "0.0125",
                    },
                },
                budget: {
                    curationWeight: 400,
                    curationBudget: 4000,
                    contextTokens: 800,
                    contextCapacity: 8000,
                },
            },
        },
    });
    const bar = presenter.buildStatusBar(150, 200);
    assert.equal(bar.projectLabel, "~/alpha");
    assert.equal(bar.loopSeq, 3);
    assert.equal(bar.waitUntil, 1700000000000);
    assert.equal(bar.activeChildren, 1);
    assert.equal(bar.gatedCount, 1);
    assert.equal(bar.inboxCount, 2);
    assert.equal(bar.openStreams, 1);
    assert.equal(bar.curationWeight, 400);
    assert.equal(bar.curationBudget, 4000);
    assert.equal(bar.contextTokens, 800);
    assert.equal(bar.contextCapacity, 8000);
    assert.equal(bar.budgetPercent, 10);
    assert.equal(bar.inputTokens, 120);
    assert.equal(bar.outputTokens, 45);
    assert.equal(bar.costUsd, "0.0125");
    assert.match(bar.formattedStatusLine, /🎲 mocktest\/default · 150ms · ↓120 ↑45/);

    const statusRun = spawnSync(
        process.execPath,
        [binPath, "--autostart", "0", "--daemon-timeout-ms", "200", "hello"],
        {
            env: {
                ...process.env,
                PLURNK_ACP_URL: "http://127.0.0.1:1/acp",
                PLURNK_HOST: "127.0.0.1",
                PLURNK_PORT: "1",
            },
            encoding: "utf8",
            timeout: 3000,
        },
    );
    assert.notEqual(statusRun.status, 0);
});
