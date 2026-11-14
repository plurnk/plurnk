import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { createNodeHttpHandler } from "@agentclientprotocol/sdk/experimental/node";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import {
    agent as createAcpAgent,
    methods,
    PROTOCOL_VERSION,
    RequestError,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { AcpClient } from "./acp-client.ts";
import { assembleClientEnv } from "./envdefaults.ts";
import { refuseBelowFloor } from "./runtime-floor.ts";
import {
    createCliElicitationHandler,
    createCliPermissionHandler,
    ensureDaemonConnected,
    formatProposalDiffPreview,
    formatServiceUpdateResult,
    matchesRuntimeAcceptance,
    openCliSession,
    runCliPrompt,
    runReplSession,
    type CliCommonOptions,
} from "./cli-runner.ts";
import Credential from "./credential.ts";
import { hyperlink } from "./color.ts";
import { renderMarkdownDocument, renderMermaid } from "./markdown.ts";
import { main } from "./dispatcher.ts";
import { lifecycleGlyphFor, operationGlyphFor, SessionPresenter } from "./session-presenter.ts";
import { altShortcut, backTabShortcut } from "./term-viewport.ts";
import { completeInput, completeOps, dslOpPartial, pathPartial } from "./term-completion.ts";
import Review, { QuestionForm } from "./term-review.ts";
import { AcpSession } from "./acp-session.ts";
import { extractChronologicalHistory, formatModelsRows, formatWorkspacesRows } from "./repl-commands.ts";
import TermSurface, {
    attention,
    backgroundScheme,
    bell,
    buildHeader,
    colorEnabled,
    colorFgBgScheme,
    concluded,
    learnScheme,
    ModelText,
    paint,
    renderLoopSummary,
    renderModelReply,
    renderNoteBlock,
    renderOperationBlock,
    renderReasoning,
    renderSubmittedInput,
    resumeCommand,
    TailText,
    windowTitle,
    withColorOutput,
} from "./term-surface.ts";
import type { Terminal } from "@earendil-works/pi-tui";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const binPath = path.join(repoRoot, "bin", "plurnk.js");

test("{§cli-invocation} {§cli-configuration-source}: runtime floor check, CLI flag parsing, and family argument forwarding", () => {
    assert.doesNotThrow(() => refuseBelowFloor("plurnk", "26.0.0"));

    const help = spawnSync(process.execPath, [binPath, "--help"], {
        env: { ...process.env, PLURNK_ACP_URL: "http://127.0.0.1:1/acp" },
        encoding: "utf8",
        timeout: 3000,
    });
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--workspace/);
    assert.match(help.stdout, /--session/);
    assert.match(help.stdout, /--persona/);
    assert.match(help.stdout, /--system-prompt/);

    const conflict = spawnSync(
        process.execPath,
        [binPath, "--persona", "reviewer", "--system-prompt", "Be strict.", "hello"],
        {
            env: { ...process.env, PLURNK_ACP_URL: "http://127.0.0.1:1/acp" },
            encoding: "utf8",
            timeout: 3000,
        },
    );
    assert.equal(conflict.status, 64);
    assert.match(conflict.stderr, /--persona and --system-prompt cannot be used together/);

    const configExcess = spawnSync(
        process.execPath,
        [binPath, "config", "model", "fast", "extra"],
        {
            env: { ...process.env, PLURNK_ACP_URL: "http://127.0.0.1:1/acp" },
            encoding: "utf8",
            timeout: 3000,
        },
    );
    assert.equal(configExcess.status, 64);
    assert.match(configExcess.stderr, /plurnk config accepts at most \[<id> \[<value>\]\]/);

    const tmpXdg = fs.mkdtempSync(path.join(os.tmpdir(), "plurnk-xdg-env-"));
    try {
        const plurnkCfg = path.join(tmpXdg, "plurnk");
        fs.mkdirSync(plurnkCfg, { recursive: true });
        fs.writeFileSync(path.join(plurnkCfg, ".env"), "PLURNK_CLIENT_MODEL=from-env\nPLURNK_CLIENT_EFFORT=low\n");
        fs.writeFileSync(path.join(plurnkCfg, ".env.local"), "PLURNK_CLIENT_MODEL=from-env-local\n");
        const assembled = assembleClientEnv({ XDG_CONFIG_HOME: tmpXdg });
        assert.equal(assembled.PLURNK_CLIENT_MODEL, "from-env-local");
        assert.equal(assembled.PLURNK_CLIENT_EFFORT, "low");
    } finally {
        fs.rmSync(tmpXdg, { recursive: true, force: true });
    }
});

test("{§cli-markdown-projection} {§cli-color-policy}: local render filter, markdown projection, OSC 8 hyperlinks, and color policy", () => {
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

test("{§cli-rendering} {§cli-markdown-projection} {§cli-color-policy}: waterfall rendering, operation glyphs, NOTE bodies, reasoning blocks, and summary lines", async () => {
    await main(["node", "plurnk", "--version"]);

    // Operation glyphs ({§cli-rendering})
    assert.equal(operationGlyphFor("read"), "📖");
    assert.equal(operationGlyphFor("edit"), "📝");
    assert.equal(operationGlyphFor("find"), "🔎");
    assert.equal(operationGlyphFor("note"), "🗒️");
    assert.equal(operationGlyphFor("work"), "🐜");
    assert.equal(operationGlyphFor("fork"), "🔱");
    assert.equal(operationGlyphFor("wait"), "⏳");
    assert.equal(operationGlyphFor("send"), "✉️");
    assert.equal(operationGlyphFor("done"), "🐹");
    assert.equal(operationGlyphFor("sh"), "⚙️  sh");

    // Reasoning tail accumulation, line cap, and retirement before tool calls/replies ({§cli-markdown-projection})
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

    // Internal _plurnk emission read (ops://...) and entry materialization edit are never rendered ({§cli-rendering})
    const emittedAnnouncement = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "1/1/0",
        title: "read (ops://x3/1/2)",
        status: "completed",
        locations: [{ path: "ops://x3/1/2" }],
        content: [{ type: "content", content: { type: "text", text: "plurnk.done({ text: \"Hello\" })" } }],
        _meta: { plurnk: { op: "read", origin: "_plurnk", attrs: { kind: "emission" } } },
    });
    assert.equal(emittedAnnouncement.length, 0);

    // Tool call retires reasoning tail and emits operation glyph; read and find show {count} and no receipt body ({§cli-markdown-projection}, {§cli-rendering})
    const t1 = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "1/1/1",
        title: "read",
        status: "completed",
        rawInput: { target: { raw: "plurnk:///session.md" }, lineMarker: { marks: [1, -1] } },
        rawOutput: { range: { returned: [1, 78] } },
        content: [{ type: "content", content: { type: "text", text: "file contents" } }],
        _meta: { plurnk: { op: "read" } },
    });
    assert.equal(presenter.reasoningLines.length, 0);
    assert.equal(t1[0]?.kind, "reasoning_retired");
    assert.equal(t1[1]?.kind, "tool_call");
    if (t1[1]?.kind === "tool_call") {
        assert.equal(t1[1].glyph, "📖");
        assert.equal(t1[1].target, "plurnk:///session.md");
        assert.equal(t1[1].scope, "<1,-1>");
        assert.equal(t1[1].count, 78);
        assert.deepEqual(t1[1].contentLines, []);
    }

    // Model note uses 🗒️ glyph and preserves any aside ({§cli-rendering})
    const noteRow = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "1/1/2",
        title: "note — working memory",
        status: "completed",
        rawInput: { aside: "working memory", body: "Evaluate and react to the Open Message." },
        _meta: { plurnk: { op: "note" } },
    });
    assert.equal(noteRow[0]?.kind, "tool_call");
    if (noteRow[0]?.kind === "tool_call") {
        assert.equal(noteRow[0].glyph, "🗒️");
        assert.equal(noteRow[0].origin, "model");
        assert.equal(noteRow[0].aside, "working memory");
        assert.equal(noteRow[0].noteBody, "Evaluate and react to the Open Message.");
    }

    // Non-distilled note with _plurnk origin is treated identically to model note ({§cli-rendering})
    const harnessNote = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "1/1/3",
        title: "note — review",
        status: "completed",
        rawInput: { aside: "review", body: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6" },
        _meta: { plurnk: { op: "note", origin: "_plurnk" } },
    });
    assert.equal(harnessNote[0]?.kind, "tool_call");
    if (harnessNote[0]?.kind === "tool_call") {
        assert.equal(harnessNote[0].origin, "_plurnk");
        assert.equal(harnessNote[0].noteBody, "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6");
        assert.deepEqual(harnessNote[0].contentLines, []);
    }

    // Concluded runtime execution renders as a single-line receipt and suppresses duplicate obligation READ ({§cli-rendering}, {§cli-problems-and-notices})
    assert.equal(
        presenter.apply({
            sessionUpdate: "tool_call_update",
            toolCallId: "1/1/4",
            title: "brave",
            status: "in_progress",
            rawInput: { target: { raw: "brave_web_search" }, body: '{"query":"weather"}' },
            _meta: { plurnk: { id: 4, op: "brave", origin: "model", coordinate: "1/1/4" } },
        }).length,
        0,
    );
    presenter.apply({
        sessionUpdate: "terminal_output_chunk",
        terminalId: "stream:4",
        data: Buffer.from("Result line 1\nResult line 2\nResult line 3\n", "utf8").toString("base64"),
        _meta: { plurnk: { opId: 4 } },
    });
    presenter.apply({
        sessionUpdate: "terminal_update",
        terminalId: "stream:4",
        status: "completed",
        exitStatus: { exitCode: 0, signal: null },
        _meta: { plurnk: { opId: 4 } },
    });
    const execDone = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "1/1/4",
        title: "brave",
        status: "completed",
        rawInput: { target: { raw: "brave_web_search" }, body: '{"query":"weather"}' },
        _meta: { plurnk: { id: 4, op: "brave", origin: "model", status: 200, coordinate: "1/1/4" } },
    });
    assert.equal(execDone.length, 1);
    if (execDone[0]?.kind === "tool_call") {
        assert.deepEqual(execDone[0].contentLines, []);
        assert.deepEqual(execDone[0].outputLines, []);
        assert.equal(execDone[0].fields, "{query}");
        const renderedExec = renderOperationBlock({
            glyph: execDone[0].glyph,
            op: execDone[0].op,
            target: execDone[0].target,
            scope: execDone[0].scope,
            fields: execDone[0].fields,
            aside: execDone[0].aside,
            count: execDone[0].count,
            outcome: execDone[0].outcome,
            contentLines: execDone[0].contentLines,
            outputLines: execDone[0].outputLines,
            coordinate: execDone[0].toolCallId,
            previewLimit: 2,
            columns: 80,
        });
        assert.doesNotMatch(renderedExec, /\{"query":"weather"\}/u);
        assert.doesNotMatch(renderedExec, /Result line 1/u);
        assert.match(renderedExec, /⚙️\s+brave\s+\(brave_web_search\)\s+\{query\}/u);
        assert.equal(renderedExec.includes("\n"), false);
    }
    const shDone = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "1/1/5",
        title: "sh",
        status: "completed",
        rawInput: { body: "git status --short" },
        _meta: { plurnk: { id: 5, op: "sh", origin: "model", status: 200, coordinate: "1/1/5" } },
    });
    assert.equal(shDone.length, 1);
    if (shDone[0]?.kind === "tool_call") {
        assert.deepEqual(shDone[0].contentLines, []);
        assert.deepEqual(shDone[0].outputLines, []);
    }
    const dupDischarge = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "1/1/4",
        title: "brave",
        status: "completed",
        _meta: { plurnk: { id: 4, op: "brave", origin: "model", status: 200, coordinate: "1/1/4" } },
    });
    assert.equal(dupDischarge.length, 0, "duplicate tool_call_update after obligation discharge must be suppressed");

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

    // Rich Term waterfall formatting: 🐹 model replies, note bodies, operation previews, 💭 reasoning, 🎯 loop summary
    assert.match(renderModelReply("Hello **world**", 80, { op: "done", status: 200 }), /🐹[\s\S]*Hello/);
    assert.match(renderModelReply("Hello **scout**", 80, { op: "done", status: 200, voice: "scoutproxy" }), /\[scoutproxy\][\s\S]*Hello/);
    assert.match(renderModelReply("Cancelled", 80, { op: "fail", status: 200 }), /❌/);
    assert.match(renderModelReply("Waiting", 80, { op: "wait", status: 200 }), /⏳/);
    assert.match(
        renderNoteBlock({ glyph: "💡", aside: null, body: "Full note markdown body", columns: 80 }),
        /💡\n[\s\S]*Full note markdown body/,
    );
    assert.match(
        renderOperationBlock({
            glyph: "📝",
            op: "edit",
            target: "file:///tmp/a.ts",
            scope: "<1,10>",
            aside: "check",
            contentLines: ["l1\nl2\nl3\nl4\nl5\nl6"],
            coordinate: "1/1/1",
            previewLimit: 5,
            columns: 80,
        }),
        /📝[\s\S]*\(file:\/\/\/tmp\/a\.ts\) <1,10>[\s\S]*\+1 line · log:\/\/\/1\/1\/1\/edit/,
    );
    assert.match(renderReasoning("step 1\nstep 2"), /💭 step 1[\s\S]*   step 2/);
    assert.match(
        renderLoopSummary({
            status: 200,
            turns: 1,
            elapsedMs: 1250,
            inputTokens: 1200,
            outputTokens: 300,
            curationWeight: 400,
            curationBudget: 4000,
            contextTokens: 800,
            contextCapacity: 8000,
            costUsd: "0.02",
        }),
        /🎯 done · 1 turn · 1\.25s · ↓1\.2k ↑300 · cur 10%\/4k · ctx 10%\/8k · loop \$0\.02/,
    );

    // Engine turn and workspace notices route to status_update or are suppressed, never waterfall notice ({§cli-rendering})
    const turnAwait = presenter.apply({
        sessionUpdate: "notice",
        severity: "info",
        title: "engine:turn:turn_awaiting_model",
        _meta: { plurnk: { notice: { source: "engine:turn", kind: "turn_awaiting_model" } } },
    });
    assert.equal(turnAwait[0]?.kind, "status_update");
    assert.match(presenter.lastStatusLine, /awaiting model/);

    const continuedWithoutNote = presenter.apply({
        sessionUpdate: "notice",
        severity: "warning",
        title: "engine:turn:continued_without_note",
        description: "The turn continued without a NOTE.",
        _meta: { plurnk: { notice: { source: "engine:turn", kind: "continued_without_note", level: "warn" } } },
    });
    assert.equal(continuedWithoutNote[0]?.kind, "notice");
    if (continuedWithoutNote[0]?.kind === "notice") {
        assert.equal(continuedWithoutNote[0].formatted, "⚠️  The turn continued without a NOTE.");
    }

    const warnNotice = presenter.apply({
        sessionUpdate: "notice",
        severity: "warning",
        title: "client:session:history_lost",
        description: "The daemon holds no history for this session.",
        _meta: { plurnk: { notice: { source: "client:session", kind: "history_lost", level: "warn" } } },
    });
    assert.equal(warnNotice[0]?.kind, "notice");
    if (warnNotice[0]?.kind === "notice") {
        assert.equal(warnNotice[0].formatted, "⚠️  The daemon holds no history for this session.");
    }
});

test("{§cli-session-status} {§cli-model-selection}: session status line formatting for wait deadlines, preparation, disconnection, effort, project root, subagents, gates, inbox, streams, clock, and spend", () => {
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
    assert.match(bar.formattedStatusLine, /mocktest\/default · 150ms · ↓120 ↑45 · \$0\.0125 · 🐜 1 · 🚦 1 · 📨 2/);

    // engine:turn:results_pending is routed to status_update and never emitted as a waterfall notice
    const pendingFrames = presenter.apply({
        sessionUpdate: "notice",
        severity: "info",
        title: "engine:turn:results_pending",
        description: "All Open Work resolved, but 1 tool call delivered unread log receipts. Respond with no tool calls if finished.",
        _meta: {
            plurnk: {
                notice: {
                    source: "engine:turn",
                    kind: "results_pending",
                    message: "All Open Work resolved, but 1 tool call delivered unread log receipts. Respond with no tool calls if finished.",
                },
            },
        },
    });
    assert.equal(pendingFrames.length, 1);
    assert.equal(pendingFrames[0]?.kind, "status_update");

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

test("{§cli-repl-mode} {§cli-inline-review} {§cli-interactive-command-discovery} {§cli-color-policy}: pi-tui TermSurface, TailText, Review, QuestionForm, completion, color scheme, and shortcuts", async () => {
    // ModelText sanitization ({§cli-problems-and-notices})
    assert.equal(ModelText.plain("hello\x1b[31mworld\x1b[0m\x07"), "helloworld");
    assert.deepEqual(ModelText.plainFields({ detail: "a\x1b[2Jb", status: 400 }), { detail: "ab", status: 400 });

    // Color policy and scheme detection ({§cli-color-policy})
    assert.equal(colorEnabled({ isTTY: true }, { PLURNK_CLIENT_COLOR: "never" }), false);
    assert.equal(colorEnabled({ isTTY: false }, { PLURNK_CLIENT_COLOR: "always" }), true);
    assert.equal(colorEnabled({ isTTY: true }, { NO_COLOR: "1" }), false);
    assert.equal(colorFgBgScheme({ COLORFGBG: "15;0" }), "dark");
    assert.equal(colorFgBgScheme({ COLORFGBG: "0;15" }), "light");
    assert.equal(backgroundScheme({ r: 10, g: 10, b: 10 }), "dark");
    assert.equal(backgroundScheme({ r: 245, g: 245, b: 245 }), "light");
    learnScheme("dark");
    const painted = withColorOutput({ isTTY: true }, () => {
        const prevNoColor = process.env.NO_COLOR;
        const prevColor = process.env.PLURNK_CLIENT_COLOR;
        process.env.PLURNK_CLIENT_COLOR = "always";
        delete process.env.NO_COLOR;
        try {
            return paint("ok", "success");
        } finally {
            if (prevNoColor !== undefined) process.env.NO_COLOR = prevNoColor;
            if (prevColor !== undefined) process.env.PLURNK_CLIENT_COLOR = prevColor;
            else delete process.env.PLURNK_CLIENT_COLOR;
        }
    });
    assert.match(painted, /\x1b\[32mok\x1b\[0m/u);

    // Header, title, resumeCommand, attention ({§cli-color-policy})
    assert.equal(windowTitle("ws", "user"), "plurnk · ws · user");
    assert.equal(windowTitle("ws", null), "plurnk · ws");
    assert.match(
        buildHeader({ workspaceName: "ws", sessionName: "user", modelSelector: "fast", effort: "high", yolo: false }),
        /workspace: ws · session: user · model: fast · effort: high · yolo: off \(Shift-Tab\) · \/help/u,
    );
    assert.match(
        buildHeader({ workspaceName: "ws", sessionName: "user", modelSelector: "fast", effort: "high", yolo: true }),
        /workspace: ws · session: user · model: fast · effort: high · yolo: on · \/help/u,
    );
    assert.equal(resumeCommand("ws", "my session"), "plurnk --workspace ws --session 'my session'");
    assert.match(renderSubmittedInput("line 1\nline 2"), /🎤 line 1[\s\S]*line 2/u);
    assert.match(renderSubmittedInput("line 1\nline 2", "scoutproxy"), /\[scoutproxy\] line 1[\s\S]*line 2/u);
    assert.equal(concluded(200, false), "reply");
    assert.equal(concluded(499, false), "stopped");
    assert.equal(concluded(500, false), "failed");
    let bellBeeps = 0;
    const sink = attention([bell({ isTTY: true, write: () => (bellBeeps += 1) })]);
    sink("reply");
    assert.equal(bellBeeps, 1);

    // Shortcuts
    assert.equal(altShortcut("\x1bh"), "/parent");
    assert.equal(altShortcut("\x1bl"), "/enter");
    assert.equal(altShortcut("\x1bj"), "/older");
    assert.equal(altShortcut("\x1bk"), "/newer");
    assert.equal(altShortcut("\x1b?"), "/help");
    assert.equal(backTabShortcut("\x1b[Z"), "/yolo");
    assert.equal(backTabShortcut("\x1b[9;2u"), "/yolo");

    // TailText caps reasoning scroll lines ({§cli-markdown-projection})
    const tail = new TailText(() => 2);
    assert.equal(tail.hasText, false);
    tail.setText("r1\nr2\nr3");
    assert.equal(tail.hasText, true);
    assert.deepEqual(tail.render(40), ["r2", "r3"]);

    // QuestionForm step-by-step and JSON validation ({§cli-inline-review})
    const form = new QuestionForm(
        {
            type: "object",
            properties: {
                choice: { type: "string", enum: ["alpha", "beta", "other"], title: "Pick one" },
                note: { type: "string", description: "Extra details" },
            },
            required: ["choice"],
        },
        "question",
    );
    assert.deepEqual(form.choices, ["alpha", "beta", "other"]);
    assert.equal(form.freeResponseChoice, "other");
    assert.equal(form.submit("").kind, "invalid");
    const fixedDone = form.submit("1");
    assert.deepEqual(fixedDone, { kind: "complete", content: { choice: "alpha" } });

    // TermSurface + Review over fake Terminal ({§cli-inline-review})
    const written: string[] = [];
    const fakeTerminal: Terminal = {
        columns: 80,
        rows: 24,
        kittyProtocolActive: false,
        start() {},
        stop() {},
        async drainInput() {},
        write(data: string) {
            written.push(data);
        },
        moveBy() {},
        hideCursor() {},
        showCursor() {},
        clearLine() {},
        clearFromCursor() {},
        clearScreen() {},
        setTitle(t: string) {
            written.push(`TITLE:${t}`);
        },
        setProgress() {},
        setProgramStatus() {},
    };
    const surface = new TermSurface(fakeTerminal);
    const stdinCommands: string[] = [];
    const review = new Review(surface, {
        sendStdin: (cmd) => stdinCommands.push(cmd),
        editBody: async () => "edited body",
        record: (t) => surface.append(t),
    });
    surface.start();
    surface.setTitle(windowTitle("ws", "user"));
    assert.ok(written.some((w) => w.includes("TITLE:plurnk · ws · user")));

    // When editor is empty, adding a permission gate opens review automatically ({§cli-inline-review})
    review.addPermissionGate({
        id: "deadbeef",
        title: "edit file:///tmp/a.txt",
        _meta: { plurnk: { proposal: { body: "hello" } } },
    });
    assert.equal(surface.reviewing, true);
    assert.equal(review.waiting, 1);
    assert.equal(review.focusedGateId, "deadbeef");

    // Pressing Enter in Review selects the first item ("Accept") and sends /approve @deadbeef to replStdin
    review.handleInput("\r");
    assert.deepEqual(stdinCommands, ["/approve @deadbeef\n"]);

    // Escape leaves review back to editor without losing gate; openReview returns to review
    assert.equal(surface.leaveReview(), true);
    assert.equal(surface.reviewing, false);
    assert.equal(surface.openReview(), true);
    assert.equal(surface.reviewing, true);

    review.remove("deadbeef");
    assert.equal(review.waiting, 0);
    assert.equal(surface.reviewing, false);

    // Mid-turn response followed by append preserves chronological order ({§cli-markdown-projection})
    surface.addResponse(renderModelReply("FIRST_MID_TURN_RESPONSE", 80, { op: "send", status: 200 }), "1/1/2");
    surface.append("SECOND_TRANSCRIPT_ROW");
    // Out-of-order tool call completion anchors at its reserved launch slot and #lastLoopHamster still receives summaryAside
    surface.reserveToolCall("1/1/1");
    surface.upsertToolCall("1/1/1", "ANCHORED_TOOL_CALL_1_1_1");
    assert.equal(surface.archiveTurn("1.25s · 1 turn"), true, "archiveTurn must attach summaryAside to #lastLoopHamster even after a mid-turn append");
    surface.renderNow();
    const surfaceDump = written.join("");
    const toolPos = surfaceDump.lastIndexOf("ANCHORED_TOOL_CALL_1_1_1");
    const firstPos = surfaceDump.lastIndexOf("FIRST_MID_TURN_RESPONSE");
    const secondPos = surfaceDump.lastIndexOf("SECOND_TRANSCRIPT_ROW");
    assert.ok(toolPos >= 0 && firstPos > toolPos, "1/1/1 tool call must sort before 1/1/2 mid-turn response");
    assert.ok(firstPos >= 0 && secondPos > firstPos, "mid-turn response must archive above subsequent transcript row");
    assert.match(surfaceDump, /🐹 1\.25s · 1 turn/u);
    surface.stop();

    // extractChronologicalHistory filters published:false replay chunks and hydrates terminal output ({§cli-rendering})
    const replaySess = new AcpSession("1#user");
    replaySess.applyUpdate({
        sessionUpdate: "user_message_chunk",
        messageId: "m-unpublished",
        content: { type: "text", text: "queued unpublished" },
        _meta: { plurnk: { published: false } },
    });
    replaySess.applyUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "1/1/1",
        name: "sh",
        status: "completed",
        content: [{ type: "terminal", terminalId: "term:7" }],
        _meta: { plurnk: { id: 7, op: "sh", status: 200 } },
    });
    replaySess.applyUpdate({
        sessionUpdate: "terminal_update",
        terminalId: "term:7",
        output: { data: Buffer.from("hydrated-out\n", "utf8").toString("base64") },
    });
    replaySess.applyUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "1/1/2",
        name: "note",
        title: "note",
        status: "completed",
        rawInput: { aside: null, body: "distilled summary" },
        _meta: {
            plurnk: {
                id: 8,
                op: "note",
                origin: "model",
                status: 200,
                attrs: { distilled: "log:///1/1/1/sh" },
            },
        },
    });
    const extracted = extractChronologicalHistory(replaySess);
    assert.equal(extracted.length, 1);
    assert.equal(extracted[0]?.kind, "tool_call");
    if (extracted[0]?.kind === "tool_call") {
        assert.ok(extracted[0].content.some((c) => c.type === "content"));
    }

    // Completion ({§cli-interactive-command-discovery})
    assert.deepEqual(dslOpPartial("plurnk.re"), { prefix: "plurnk.", typed: "re" });
    const [ops] = completeOps({ prefix: "plurnk.", typed: "RE" });
    assert.ok(ops.includes("plurnk.read"));
    assert.deepEqual(dslOpPartial("await plurnk.re"), { prefix: "await plurnk.", typed: "re" });
    const [toleratedOps] = completeOps({ prefix: "await plurnk.", typed: "RE" });
    assert.ok(toleratedOps.includes("await plurnk.read"));
    assert.deepEqual(pathPartial('plurnk.read({ path: "src/'), { kind: "target", partial: "src/" });
    assert.deepEqual(pathPartial('await plurnk.read({ path: "src/'), { kind: "target", partial: "src/" });
    assert.deepEqual(pathPartial("/import src/"), { kind: "local", partial: "src/" });
    assert.deepEqual(pathPartial("check @README"), { kind: "reference", partial: "README" });

    const rootComp = await completeInput("/session", {
        cwd: repoRoot,
        getProjectRoot: () => repoRoot,
        getSessionNames: () => ["user", "helper"],
        getPendingGateIds: () => ["deadbeef"],
    });
    assert.equal(rootComp.suggestions[0]?.value, "/session", "exact match /session must sort before /sessions");

    const gateComp = await completeInput("/approve @de", {
        cwd: repoRoot,
        getProjectRoot: () => repoRoot,
        getPendingGateIds: () => ["deadbeef", "cafebabe"],
    });
    assert.deepEqual(gateComp.suggestions, [{ value: "@deadbeef", description: "pending gate" }]);

    const personaComp = await completeInput("/persona rev", {
        cwd: repoRoot,
        getProjectRoot: () => repoRoot,
        getPersonas: () => ["none", "reviewer", "architect"],
    });
    assert.deepEqual(personaComp.suggestions, [{ value: "reviewer", description: "persona" }]);

    const providerComp = await completeInput("/model deepseek/deepseek-f", {
        cwd: repoRoot,
        getProjectRoot: () => repoRoot,
        getModels: () => [],
        getProviderModels: async (provider) =>
            provider === "deepseek" ? ["deepseek/deepseek-flash", "deepseek/deepseek-v4-pro"] : [],
    });
    assert.deepEqual(providerComp.suggestions, [{ value: "deepseek/deepseek-flash", description: "model" }]);

    assert.equal(
        formatModelsRows({ items: [] }),
        "(no models match; use --all to include models missing local configuration)\n",
    );
    const modelsTable = formatModelsRows({
        items: [
            {
                selector: "deepseek/deepseek-flash",
                modelName: "DeepSeek Flash",
                limits: { contextTokens: 128_000 },
                capabilities: { reasoning: true, efforts: ["low", "medium", "high"] },
                readiness: { ready: true, causes: [] },
            },
        ],
        offset: 0,
        total: 4,
        nextOffset: 1,
    });
    assert.match(modelsTable, /selector\s+name\s+context\s+efforts\s+readiness/u);
    assert.match(modelsTable, /deepseek\/deepseek-flash\s+DeepSeek Flash\s+128k\s+low,medium,high\s+ready/u);
    assert.match(modelsTable, /\(showing 1-1 of 4; next --offset 1\)/u);

    assert.equal(formatWorkspacesRows({ workspaces: [] }), "(no workspaces; run `plurnk` to create one)\n");
    const workspacesTable = formatWorkspacesRows({
        workspaces: [{ id: 1, name: "alpha", project_root: "/tmp/alpha", created_at: "2026-10-31" }],
    });
    assert.match(workspacesTable, /name\s+project_root\s+created/u);
    assert.match(workspacesTable, /alpha\s+\/tmp\/alpha\s+2026-10-31/u);

    // Service and model catalog update formatting ({§cli-subcommands})
    const formattedUpdate = formatServiceUpdateResult({
        catalog: { status: "updated", models: 500, providers: 20, addedModels: 4 },
        service: {
            package: "@plurnk/plurnk-service",
            version: "4.4.0",
            artifact: "dist",
            upgradeCommand: "npm install -g --ignore-scripts @plurnk/plurnk-service@latest @plurnk/plurnk@latest",
        },
    });
    assert.match(formattedUpdate, /catalog: updated \(500 models across 20 providers, \+4 new\)/u);
    assert.match(formattedUpdate, /version: @plurnk\/plurnk-service@4\.4\.0 — to update packages, stop the daemon and run: npm install -g --ignore-scripts @plurnk\/plurnk-service@latest @plurnk\/plurnk@latest/u);
});

test("{§cli-inline-review} {§cli-color-policy} {§cli-markdown-projection}: per-runtime PLURNK_CLIENT_ACCEPT_<runtime> auto-acceptance, interactive TTY permission review menu, colored diff preview, and markdown/color modules", async () => {
    // 1. Per-runtime acceptance ({§cli-inline-review})
    const braveReq = {
        sessionId: "default#user",
        title: "brave (brave_web_search)",
        toolCall: { toolCallId: "tc-1", title: "brave (brave_web_search)" },
        options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" as const },
            { optionId: "reject", name: "Reject", kind: "reject_once" as const },
        ],
        _meta: {
            plurnk: {
                proposal: {
                    op: "brave",
                    target: "brave_web_search",
                    body: "plurnk",
                },
            },
        },
    };
    assert.equal(matchesRuntimeAcceptance(braveReq, {}), false);
    assert.equal(
        matchesRuntimeAcceptance(braveReq, { PLURNK_CLIENT_ACCEPT_brave_TOOLS: '["brave_web_search"]' }),
        false,
        "_TOOLS alone enables nothing without PLURNK_CLIENT_ACCEPT_<runtime>=1",
    );
    assert.equal(
        matchesRuntimeAcceptance(braveReq, { PLURNK_CLIENT_ACCEPT_brave: "1" }),
        true,
        "PLURNK_CLIENT_ACCEPT_brave=1 accepts every call on runtime brave",
    );
    assert.equal(
        matchesRuntimeAcceptance(braveReq, {
            PLURNK_CLIENT_ACCEPT_brave: "1",
            PLURNK_CLIENT_ACCEPT_brave_TOOLS: '["brave_web_search"]',
        }),
        true,
    );
    assert.equal(
        matchesRuntimeAcceptance(braveReq, {
            PLURNK_CLIENT_ACCEPT_brave: "1",
            PLURNK_CLIENT_ACCEPT_brave_TOOLS: '["brave_local_search"]',
        }),
        false,
    );

    // 2. Colored udiff preview ({§cli-inline-review})
    const diffPreview = withColorOutput(
        { isTTY: true },
        () =>
            formatProposalDiffPreview(
                {
                    ...braveReq,
                    _meta: {
                        plurnk: {
                            proposal: {
                                op: "edit",
                                target: "file:///tmp/demo.txt",
                                preview: "@@ -1 +1 @@\n-old line\n+new line",
                            },
                        },
                    },
                },
                { isTTY: true },
            ),
    );
    assert.match(diffPreview, /@@ -1 \+1 @@/u);
    assert.match(diffPreview, /-old line/u);
    assert.match(diffPreview, /\+new line/u);

    // 3. One-shot interactive TTY review menu ([a]ccept / [r]eject / [c]ancel and ? forceReview override) ({§cli-inline-review})
    const stdinAccept = new PassThrough() as PassThrough & { isTTY?: boolean };
    stdinAccept.isTTY = true;
    let stderrOut = "";
    const stderrStream = new PassThrough() as PassThrough & { isTTY?: boolean };
    stderrStream.isTTY = true;
    stderrStream.on("data", (chunk) => {
        stderrOut += String(chunk);
    });

    const handler = createCliPermissionHandler(true, {
        forceReview: true,
        stdin: stdinAccept,
        stderr: stderrStream,
    });
    const acceptPromise = handler(braveReq, new AbortController().signal);
    stdinAccept.write("a\n");
    const acceptRes = await acceptPromise;
    assert.deepEqual(acceptRes, { outcome: { outcome: "selected", optionId: "allow" } });
    assert.match(stderrOut, /\[a\]ccept · \[e\]dit · \[r\]eject · \[c\]ancel \[1\]:/u);

    const stdinReject = new PassThrough() as PassThrough & { isTTY?: boolean };
    stdinReject.isTTY = true;
    const rejectHandler = createCliPermissionHandler(true, {
        forceReview: true,
        stdin: stdinReject,
        stderr: stderrStream,
    });
    const rejectPromise = rejectHandler(braveReq, new AbortController().signal);
    stdinReject.write("r\n");
    const rejectRes = await rejectPromise;
    assert.deepEqual(rejectRes, { outcome: { outcome: "selected", optionId: "reject" } });

    // 4. Direct color.ts and markdown.ts exports ({§cli-color-policy}, {§cli-markdown-projection})
    const prevColor = process.env.PLURNK_CLIENT_COLOR;
    process.env.PLURNK_CLIENT_COLOR = "always";
    try {
        const linked = withColorOutput({ isTTY: true }, () =>
            hyperlink("https://plurnk.xyz", "plurnk"),
        );
        assert.equal(linked, "\x1b]8;;https://plurnk.xyz\x1b\\plurnk\x1b]8;;\x1b\\");
    } finally {
        if (prevColor === undefined) {
            delete process.env.PLURNK_CLIENT_COLOR;
        } else {
            process.env.PLURNK_CLIENT_COLOR = prevColor;
        }
    }
    const mmd = renderMermaid("graph LR\n  A --> B", 60);
    assert.ok(mmd !== null && mmd.length > 0);
    const doc = renderMarkdownDocument("# Title\n\nParagraph text.", 60);
    assert.match(doc, /Title/u);
    assert.match(doc, /Paragraph text\./u);

    // 5. openCliSession deduplicates identical configuration notices across newSession, resumeSession, and live updates ({§cli-rendering})
    const listeners = new Set<(notification: { readonly sessionId: string; readonly update: { readonly sessionUpdate: "notice"; readonly severity: "info"; readonly title: string; readonly description?: string } }) => void>();
    const shadowedNotice = {
        sessionUpdate: "notice" as const,
        severity: "info" as const,
        title: "engine:configuration:plugin_shadowed",
        description: "plugin plurnk-web is shadowed",
    };
    const loopStatusNotice = {
        sessionUpdate: "notice" as const,
        severity: "info" as const,
        title: "engine:loop:loop_status",
    };
    const fakeClient = {
        onSessionUpdate(cb: typeof listeners extends Set<infer T> ? T : never) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        onDisconnect() {
            return () => {};
        },
        async newSession() {
            for (const cb of listeners) cb({ sessionId: "1#user", update: shadowedNotice });
            return { sessionId: "1#user", configOptions: [] };
        },
        async resumeSession() {
            for (const cb of listeners) cb({ sessionId: "1#user", update: shadowedNotice });
            return { configOptions: [] };
        },
    };
    const opened = await openCliSession(
        fakeClient as never,
        { cwd: "/tmp" } as never,
        undefined,
        true,
    );
    for (const cb of listeners) cb({ sessionId: "1#user", update: shadowedNotice });
    for (const cb of listeners) cb({ sessionId: "1#user", update: loopStatusNotice });
    for (const cb of listeners) cb({ sessionId: "1#user", update: loopStatusNotice });
    assert.equal(
        opened.items.filter(
            (item) => item.kind === "notice" && item.title === "engine:configuration:plugin_shadowed",
        ).length,
        1,
    );
    assert.equal(
        opened.items.filter(
            (item) => item.kind === "notice" && item.title === "engine:loop:loop_status",
        ).length,
        2,
    );
    opened.dispose();
});

test("{§cli-invocation} {§cli-configuration-source} {§cli-color-policy} {§cli-output-channels}: CLI dispatcher rejects unknown flags, empty non-TTY stdin, missing --env-file, invalid switches, and invalid --color with exit 64", () => {
    const runBin = (args: readonly string[], extraEnv: Record<string, string> = {}, stdin = "") =>
        spawnSync(process.execPath, ["--", binPath, ...args], {
            cwd: repoRoot,
            input: stdin,
            encoding: "utf8",
            env: {
                ...process.env,
                PLURNK_ACP_URL: "http://127.0.0.1:9/acp",
                PLURNK_CLIENT_AUTOSTART: "0",
                ...extraEnv,
            },
        });

    // Unknown flags exit 64 (both standalone and before subcommands/families without swallowing the subcommand)
    for (const badArgs of [
        ["--bogus-flag", "hello"],
        ["-x", "hello"],
        ["--bogus-flag", "models"],
        ["--bogus-flag", "daemon", "status"],
        ["--bogus-flag", "mcp", "list"],
    ]) {
        const res = runBin(badArgs);
        assert.equal(res.status, 64, `Expected exit 64 for ${badArgs.join(" ")}, got ${String(res.status)}`);
        assert.match(res.stderr, /plurnk:/u);
    }

    const unknownJson = runBin(["--json", "--bogus-flag", "hello"]);
    assert.equal(unknownJson.status, 64);
    const unknownDoc = JSON.parse(unknownJson.stdout) as { schemaVersion: number; problem: { type: string; status: number } };
    assert.equal(unknownDoc.schemaVersion, 6);
    assert.equal(unknownDoc.problem.type, "https://problems.plurnk.xyz/client/usage");
    assert.equal(unknownDoc.problem.status, 400);

    // Empty non-TTY stdin with no positional prompt exits 64 instead of printing USAGE and exiting 0
    const emptyStdin = runBin([]);
    assert.equal(emptyStdin.status, 64);
    assert.equal(emptyStdin.stdout, "");
    assert.match(emptyStdin.stderr, /No prompt provided/u);

    const emptyStdinJson = runBin(["--json"]);
    assert.equal(emptyStdinJson.status, 64);
    assert.equal(
        (JSON.parse(emptyStdinJson.stdout) as { problem: { type: string } }).problem.type,
        "https://problems.plurnk.xyz/client/usage",
    );

    // Missing --env-file exits 64 cleanly (and JSON on --json) instead of raw ENOENT exit 1
    const missingEnvFile = runBin(["--json", "--env-file", "/nonexistent/plurnk-missing.env", "hello"]);
    assert.equal(missingEnvFile.status, 64);
    const envFileDoc = JSON.parse(missingEnvFile.stdout) as { problem: { type: string; detail: string } };
    assert.equal(envFileDoc.problem.type, "https://problems.plurnk.xyz/client/usage");
    assert.match(envFileDoc.problem.detail, /Environment file not found/u);

    // Switch parsing matrix: invalid switch tokens exit 64; 1/true/yes/on and 0/false/no/off are accepted
    for (const [envKey, val] of [
        ["PLURNK_CLIENT_YOLO", "maybe"],
        ["PLURNK_CLIENT_AUTOSTART", "2"],
        ["PLURNK_CLIENT_NO_GIT", "invalid"],
        ["PLURNK_CLIENT_JSON", "sometimes"],
    ] as const) {
        const res = runBin(["hello"], { [envKey]: val });
        assert.equal(res.status, 64, `Expected 64 for ${envKey}=${val}`);
    }
    assert.equal(runBin(["--autostart=invalid", "hello"]).status, 64);

    // Valid falsy switch spellings ("off", "no") pass switch validation (proceeding to connection refusal exit 1, not 64)
    const validSwitch = runBin(["--autostart=off", "hello"], {
        PLURNK_CLIENT_YOLO: "yes",
        PLURNK_CLIENT_NO_GIT: "on",
        PLURNK_CLIENT_BELL: "no",
    });
    assert.equal(validSwitch.status, 1);

    // --color validation: accepts always|auto|never, rejects anything else with exit 64
    assert.equal(runBin(["--color=rainbow", "hello"]).status, 64);
    assert.equal(runBin(["hello"], { PLURNK_CLIENT_COLOR: "1" }).status, 64);
    assert.equal(runBin(["--color=never", "hello"]).status, 1);
});

test("{§cli-invocation} {§cli-workspaces-and-sessions} {§cli-inline-review} {§cli-output-channels} {§cli-problems-and-notices}: --no-git sends settings.git=false, unattended runCliPrompt omits elicitation capability, interactive TTY uses custom stderr, and --share propagates workspace.share errors", async () => {
    const observedInitCapabilities: Array<Record<string, unknown>> = [];
    const observedNewSessionMetas: Array<Record<string, unknown>> = [];
    const observedShareActions: Array<Record<string, unknown>> = [];
    let failShare = false;
    let askElicitation = false;

    const agentApp = createAcpAgent({ name: "cli-runner-defects-mock" })
        .onRequest(methods.agent.initialize, async ({ params }) => {
            observedInitCapabilities.push((params.capabilities ?? {}) as Record<string, unknown>);
            return {
                protocolVersion: PROTOCOL_VERSION,
                info: { name: "@plurnk/plurnk-service", version: "6.0.0" },
                capabilities: { session: { prompt: {} } },
            };
        })
        .onRequest(methods.agent.session.new, async ({ params }) => {
            observedNewSessionMetas.push((params._meta ?? {}) as Record<string, unknown>);
            return {
                sessionId: "1#user",
                configOptions: [],
            };
        })
        .onRequest(
            "_plurnk/action",
            (raw) => raw as { kind: string; params?: Record<string, unknown> },
            async ({ params }) => {
                if (params.kind === "workspace.share") {
                    observedShareActions.push(params.params ?? {});
                    if (failShare) {
                        throw new RequestError(-32000, "Share destination already exists", {
                            type: "https://problems.plurnk.xyz/service/share-exists",
                            title: "Share destination exists",
                            status: 409,
                            detail: "Target share directory is non-empty.",
                        });
                    }
                    return { folder: String(params.params?.folder ?? "") };
                }
                return {};
            },
        )
        .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
            let replyText = "Done";
            if (askElicitation) {
                const res = await client.request(methods.client.elicitation.create, {
                    sessionId: params.sessionId,
                    mode: "form",
                    message: "Provide deployment tag",
                    requestedSchema: {
                        type: "object",
                        properties: {
                            tag: { type: "string", title: "Release tag" },
                        },
                    },
                });
                const acceptedContent =
                    res.action === "accept" ? (res.content as Record<string, unknown> | undefined) : undefined;
                replyText = `Elicited:${res.action}:${String(acceptedContent?.tag ?? "")}`;
            }
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: "m-1",
                    content: { type: "text", text: replyText },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "state_update",
                    state: "idle",
                    stopReason: "end_turn",
                },
            });
            return { stopReason: "end_turn", messageId: "m-1" };
        });

    const acpServer = new AcpServer({ agent: agentApp });
    const httpServer = http.createServer(createNodeHttpHandler(acpServer));
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    const addr = httpServer.address();
    assert.ok(addr && typeof addr === "object");

    const baseOptions = (overrides: Partial<CliCommonOptions> = {}): CliCommonOptions => ({
        url: `http://127.0.0.1:${String(addr.port)}/acp`,
        explicitAcpUrl: true,
        host: "127.0.0.1",
        port: addr.port,
        credential: new Credential({ PLURNK_SECRET: "test-secret" }),
        env: { PLURNK_SECRET: "test-secret", HOME: "/tmp/mock-home" },
        cwd: "/tmp",
        termSession: "user",
        autostart: false,
        daemonTimeoutMs: 2000,
        oauthTimeoutMs: 2000,
        cancelGraceMs: 500,
        yolo: true,
        auto: false,
        bell: false,
        json: false,
        previewLines: 5,
        historyEntries: 5,
        mermaidTimeoutMs: 1000,
        color: "never",
        ...overrides,
    });

    try {
        // 1. --no-git via main() sends settings.git = false (never settings.noGit)
        const prevExit = process.exitCode;
        process.exitCode = 0;
        const origWrite = process.stdout.write.bind(process.stdout);
        let capturedStdout = "";
        process.stdout.write = ((chunk: unknown) => {
            capturedStdout += String(chunk);
            return true;
        }) as typeof process.stdout.write;
        const prevAcpUrl = process.env.PLURNK_ACP_URL;
        const prevSecret = process.env.PLURNK_SECRET;
        const prevStdinIsTTY = process.stdin.isTTY;
        process.env.PLURNK_ACP_URL = `http://127.0.0.1:${String(addr.port)}/acp`;
        process.env.PLURNK_SECRET = "test-secret";
        Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
        try {
            await main(["node", "plurnk", "--no-git", "--json", "check no-git"]);
        } finally {
            Object.defineProperty(process.stdin, "isTTY", { value: prevStdinIsTTY, configurable: true });
            process.stdin.pause();
            process.stdout.write = origWrite;
            if (prevAcpUrl === undefined) delete process.env.PLURNK_ACP_URL;
            else process.env.PLURNK_ACP_URL = prevAcpUrl;
            if (prevSecret === undefined) delete process.env.PLURNK_SECRET;
            else process.env.PLURNK_SECRET = prevSecret;
            assert.equal(process.exitCode ?? 0, 0);
            process.exitCode = prevExit;
        }
        assert.match(capturedStdout, /"response":"Done"/u);
        const sentPlurnkMeta = (observedNewSessionMetas[0]?.plurnk ?? {}) as { settings?: Record<string, unknown> };
        assert.equal(sentPlurnkMeta.settings?.noGit, undefined);
        assert.deepEqual(sentPlurnkMeta.settings, { git: false });
        // --json run must NOT advertise elicitation capability
        assert.equal(observedInitCapabilities[0]?.elicitation, undefined);

        // 2. Non-TTY stdin and --auto runs also omit elicitation capability
        const nonTtyStdin = new PassThrough();
        const nonTtyStdout = new PassThrough();
        await runCliPrompt("hello", baseOptions(), {
            stdin: nonTtyStdin,
            stdout: nonTtyStdout,
            stderr: new PassThrough(),
            events: new PassThrough(),
            reasoning: new PassThrough(),
        });
        assert.equal(observedInitCapabilities[1]?.elicitation, undefined);

        const ttyStdinAuto = Object.assign(new PassThrough(), { isTTY: true });
        await runCliPrompt("hello", baseOptions({ auto: true }), {
            stdin: ttyStdinAuto,
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            events: new PassThrough(),
            reasoning: new PassThrough(),
        });
        assert.equal(observedInitCapabilities[2]?.elicitation, undefined);

        // 3. Interactive TTY (isTTY=true, !auto, !json) advertises elicitation: { form: {} } and writes prompt to streams.stderr
        askElicitation = true;
        const ttyStdin = Object.assign(new PassThrough(), { isTTY: true });
        const customStderr = new PassThrough();
        const customStdout = new PassThrough();
        let stderrText = "";
        let stdoutText = "";
        customStderr.setEncoding("utf8");
        customStderr.on("data", (c: string) => {
            stderrText += c;
            if (stderrText.includes("Release tag:")) {
                ttyStdin.write("v6.1.0\n");
            }
        });
        customStdout.setEncoding("utf8");
        customStdout.on("data", (c: string) => {
            stdoutText += c;
        });
        const elicitCode = await runCliPrompt("deploy", baseOptions(), {
            stdin: ttyStdin,
            stdout: customStdout,
            stderr: customStderr,
            events: new PassThrough(),
            reasoning: new PassThrough(),
        });
        askElicitation = false;
        assert.equal(elicitCode, 0);
        assert.deepEqual(observedInitCapabilities[3]?.elicitation, { form: {} });
        assert.match(stderrText, /\[elicitation\] Provide deployment tag/u);
        assert.equal(stdoutText.trim(), "Elicited:accept:v6.1.0");

        // Direct createCliElicitationHandler returns { action: "cancel" } when !isTTY
        const cancelHandler = createCliElicitationHandler({
            stdin: new PassThrough(),
            stderr: new PassThrough(),
            isTTY: false,
        });
        const cancelledRes = await cancelHandler(
            {
                sessionId: "1#user",
                mode: "form",
                message: "Unattended question",
                requestedSchema: { type: "object", properties: {} },
            },
            new AbortController().signal,
        );
        assert.deepEqual(cancelledRes, { action: "cancel" });

        // 4. --share sends { folder } and propagates errors when workspace.share fails
        const shareOkCode = await runCliPrompt("share ok", baseOptions({ shareFolder: "~/out-share" }), {
            stdin: new PassThrough(),
            stdout: new PassThrough(),
            stderr: new PassThrough(),
            events: new PassThrough(),
            reasoning: new PassThrough(),
        });
        assert.equal(shareOkCode, 0);
        assert.deepEqual(observedShareActions[0], { folder: "/tmp/mock-home/out-share" });

        failShare = true;
        await assert.rejects(
            () =>
                runCliPrompt("share fail", baseOptions({ shareFolder: "/tmp/existing-share" }), {
                    stdin: new PassThrough(),
                    stdout: new PassThrough(),
                    stderr: new PassThrough(),
                    events: new PassThrough(),
                    reasoning: new PassThrough(),
                }),
            (err: unknown) => {
                const cliErr = err as { exitCode?: number; problem?: { type?: string; status?: number; detail?: string } };
                assert.equal(cliErr.exitCode, 1);
                assert.equal(cliErr.problem?.type, "https://problems.plurnk.xyz/service/share-exists");
                assert.equal(cliErr.problem?.status, 409);
                assert.match(String(cliErr.problem?.detail), /non-empty/u);
                return true;
            },
        );
    } finally {
        await acpServer.close();
        httpServer.closeAllConnections();
        await new Promise<void>((r) => httpServer.close(() => r()));
    }
});

test("{§cli-sessions-topology} {§cli-repl-mode}: REPL /fork <name> passes _meta.plurnk.sessionName and binds directly to the forked session without calling session/new or session/delete", async () => {
    let newSessionCalls = 0;
    let deleteSessionCalls = 0;
    const forkCalls: Array<Record<string, unknown>> = [];
    const promptSessionIds: string[] = [];

    const agentApp = createAcpAgent({ name: "repl-fork-mock" })
        .onRequest(methods.agent.initialize, async () => ({
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "@plurnk/plurnk-service", version: "6.0.0" },
            capabilities: { session: { fork: {}, delete: {}, resume: {}, prompt: {} } },
        }))
        .onRequest(methods.agent.session.new, async () => {
            newSessionCalls += 1;
            return {
                sessionId: "1#user",
                configOptions: [],
                _meta: {
                    plurnk: {
                        workspace: { id: 1, name: "ws-fork", projectRoot: "/tmp" },
                        sessionName: "user",
                    },
                },
            };
        })
        .onRequest(methods.agent.session.resume, async () => ({
            configOptions: [],
        }))
        .onRequest(methods.agent.session.delete, async () => {
            deleteSessionCalls += 1;
            return {};
        })
        .onRequest(methods.agent.session.fork, async ({ params }) => {
            forkCalls.push(params as unknown as Record<string, unknown>);
            const plurnk = (params._meta?.plurnk ?? undefined) as { sessionName?: string } | undefined;
            const targetName = plurnk?.sessionName ?? "auto-fork";
            return {
                sessionId: `1#${targetName}`,
                configOptions: [],
                _meta: {
                    plurnk: {
                        workspace: { id: 1, name: "ws-fork", projectRoot: "/tmp" },
                        sessionName: targetName,
                    },
                },
            };
        })
        .onRequest("_plurnk/action", (raw) => raw as { kind: string }, async () => ({}))
        .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
            promptSessionIds.push(params.sessionId);
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: "m-fork",
                    content: { type: "text", text: `Reply on ${params.sessionId}` },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "state_update",
                    state: "idle",
                    stopReason: "end_turn",
                },
            });
            return { stopReason: "end_turn", messageId: "m-fork" };
        });

    const acpServer = new AcpServer({ agent: agentApp });
    const httpServer = http.createServer(createNodeHttpHandler(acpServer));
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    const addr = httpServer.address();
    assert.ok(addr && typeof addr === "object");

    try {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const events = new PassThrough();
        const reasoning = new PassThrough();

        let outText = "";
        let eventsText = "";
        stdout.setEncoding("utf8");
        stdout.on("data", (c: string) => {
            outText += c;
        });
        events.setEncoding("utf8");
        events.on("data", (c: string) => {
            eventsText += c;
        });

        const replPromise = runReplSession(
            {
                url: `http://127.0.0.1:${String(addr.port)}/acp`,
                explicitAcpUrl: true,
                host: "127.0.0.1",
                port: addr.port,
                credential: new Credential({ PLURNK_SECRET: "test-secret" }),
                env: { PLURNK_SECRET: "test-secret" },
                cwd: "/tmp",
                termSession: "user",
                autostart: false,
                daemonTimeoutMs: 2000,
                oauthTimeoutMs: 2000,
                cancelGraceMs: 500,
                yolo: true,
                auto: false,
                bell: false,
                json: false,
                repl: true,
                previewLines: 5,
                historyEntries: 5,
                mermaidTimeoutMs: 1000,
                color: "never",
            },
            { stdin, stdout, stderr, events, reasoning },
        );

        const waitUntil = async (pred: () => boolean) => {
            const deadline = Date.now() + 3000;
            while (!pred() && Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 15));
            }
            assert.ok(pred(), `stdout:\n${outText}\nevents:\n${eventsText}`);
        };

        await waitUntil(() => outText.includes("workspace: ws-fork"));
        assert.equal(newSessionCalls, 1);

        stdin.write("/fork feature-branch\n");
        await waitUntil(() => outText.includes("session: feature-branch (forked)"));

        // Must NOT call session/new or session/delete when forking!
        assert.equal(newSessionCalls, 1);
        assert.equal(deleteSessionCalls, 0);
        assert.equal(forkCalls.length, 1);
        assert.deepEqual(forkCalls[0], {
            sessionId: "1#user",
            cwd: "/tmp",
            _meta: { plurnk: { sessionName: "feature-branch" } },
        });

        // Verify session_bound event updated sessionName and subsequent prompt hits the forked session!
        const boundEvents = eventsText
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as Record<string, unknown>)
            .filter((e) => e.sessionUpdate === "session_bound");
        assert.equal(boundEvents.at(-1)?.sessionId, "1#feature-branch");
        assert.equal(boundEvents.at(-1)?.session, "feature-branch");

        stdin.write("Hello forked session\n");
        await waitUntil(() => outText.includes("Reply on 1#feature-branch"));
        assert.deepEqual(promptSessionIds, ["1#feature-branch"]);

        stdin.write("/quit\n");
        assert.equal(await replPromise, 0);
    } finally {
        await acpServer.close();
        httpServer.closeAllConnections();
        await new Promise<void>((r) => httpServer.close(() => r()));
    }
});

test("{§cli-invocation} {§cli-subcommands} {§cli-conformance}: ensureDaemonConnected rejects PLURNK_PORT=0 autostart with 64 port-unshareable, polls 503 service-starting without duplicate spawns, and install-sandbox packs outside repo root", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plurnk-conn-sandbox-test-"));
    try {
        const markerPath = path.join(tmp, "spawned.txt");
        const fakeServiceBin = path.join(tmp, "fake-service.mjs");
        fs.writeFileSync(
            fakeServiceBin,
            `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(markerPath)}, "spawned");\n`,
            "utf8",
        );

        const baseOpts = (overrides: Partial<CliCommonOptions>): CliCommonOptions => ({
            url: "http://127.0.0.1:0/acp",
            explicitAcpUrl: false,
            host: "127.0.0.1",
            port: 0,
            credential: new Credential({ PLURNK_SECRET: "test-secret" }),
            env: { PLURNK_SECRET: "test-secret", XDG_STATE_HOME: tmp },
            cwd: tmp,
            termSession: "user",
            autostart: true,
            daemonTimeoutMs: 1500,
            oauthTimeoutMs: 1000,
            cancelGraceMs: 500,
            serviceBin: fakeServiceBin,
            yolo: false,
            auto: false,
            bell: false,
            json: false,
            previewLines: 5,
            historyEntries: 5,
            mermaidTimeoutMs: 1000,
            color: "never",
            ...overrides,
        });

        // 1. Missing serviceBin on port 0 exits 127 not-installed; installed serviceBin on port 0 exits 64 port-unshareable
        const missingClient = new AcpClient({ url: "http://127.0.0.1:0/acp", token: "t" });
        await assert.rejects(
            () => ensureDaemonConnected(missingClient, baseOpts({ serviceBin: path.join(tmp, "missing-service.mjs") })),
            (err: unknown) => {
                assert.equal((err as { exitCode?: number }).exitCode, 127);
                assert.equal(
                    (err as { problem?: { type?: string } }).problem?.type,
                    "https://problems.plurnk.xyz/client/daemon/not-installed",
                );
                return true;
            },
        );
        missingClient.close();

        const portZeroClient = new AcpClient({ url: "http://127.0.0.1:0/acp", token: "t" });
        await assert.rejects(
            () => ensureDaemonConnected(portZeroClient, baseOpts({})),
            (err: unknown) => {
                assert.equal((err as { exitCode?: number }).exitCode, 64);
                assert.equal(
                    (err as { problem?: { type?: string } }).problem?.type,
                    "https://problems.plurnk.xyz/client/daemon/port-unshareable",
                );
                return true;
            },
        );
        portZeroClient.close();
        assert.equal(fs.existsSync(markerPath), false);

        // 2. 503 service-starting polls until ready for BOTH !autostart and autostart without spawning a duplicate daemon
        const agentApp = createAcpAgent({ name: "starting-daemon-mock" }).onRequest(
            methods.agent.initialize,
            async () => ({
                protocolVersion: PROTOCOL_VERSION,
                info: { name: "@plurnk/plurnk-service", version: "6.0.0" },
                capabilities: {},
            }),
        );
        const acpServer = new AcpServer({ agent: agentApp });
        const acpHandler = createNodeHttpHandler(acpServer);
        let startingRemaining = 2;
        const httpServer = http.createServer((req, res) => {
            if (startingRemaining > 0) {
                startingRemaining -= 1;
                res.writeHead(503, { "content-type": "application/problem+json" });
                res.end(
                    JSON.stringify({
                        type: "https://problems.plurnk.xyz/service/service-starting",
                        title: "Service starting",
                        status: 503,
                        detail: "Booting modules",
                    }),
                );
                return;
            }
            acpHandler(req, res);
        });
        await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
        const addr = httpServer.address();
        assert.ok(addr && typeof addr === "object");

        try {
            const url = `http://127.0.0.1:${String(addr.port)}/acp`;
            const attachOnlyClient = new AcpClient({ url, token: "t" });
            await ensureDaemonConnected(
                attachOnlyClient,
                baseOpts({ url, port: addr.port, autostart: false }),
            );
            attachOnlyClient.close();

            startingRemaining = 2;
            const autostartClient = new AcpClient({ url, token: "t" });
            await ensureDaemonConnected(
                autostartClient,
                baseOpts({ url, port: addr.port, autostart: true }),
            );
            autostartClient.close();
            assert.equal(fs.existsSync(markerPath), false, "503 starting daemon must not trigger duplicate spawn");
        } finally {
            await acpServer.close();
            httpServer.closeAllConnections();
            await new Promise<void>((r) => httpServer.close(() => r()));
        }

        // 3. install-sandbox.mjs pack(destDir) writes tarball to destDir and never writes a .tgz into repo root
        const packOutDir = path.join(tmp, "pack-dest");
        const sandboxScriptUrl = new URL("../scripts/install-sandbox.mjs", import.meta.url).href;
        const packRun = spawnSync(
            process.execPath,
            [
                "--input-type=module",
                "-e",
                `import { pack } from ${JSON.stringify(sandboxScriptUrl)}; process.stdout.write(pack(${JSON.stringify(packOutDir)}));`,
            ],
            { cwd: repoRoot, encoding: "utf8" },
        );
        assert.equal(packRun.status, 0, packRun.stderr);
        const packedTarball = packRun.stdout.trim();
        assert.equal(path.dirname(packedTarball), packOutDir);
        assert.equal(fs.existsSync(packedTarball), true);
        const rootTarballs = fs.readdirSync(repoRoot).filter((f) => f.endsWith(".tgz"));
        assert.deepEqual(rootTarballs, []);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
