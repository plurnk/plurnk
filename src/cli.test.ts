import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import { assembleClientEnv } from "./envdefaults.ts";
import { refuseBelowFloor } from "./runtime-floor.ts";
import {
    createCliPermissionHandler,
    formatProposalDiffPreview,
    formatServiceUpdateResult,
    matchesRuntimeAcceptance,
} from "./cli-runner.ts";
import { hyperlink } from "./color.ts";
import { renderMarkdownDocument, renderMermaid } from "./markdown.ts";
import { main } from "./dispatcher.ts";
import { lifecycleGlyphFor, operationGlyphFor, SessionPresenter } from "./session-presenter.ts";
import { altShortcut, backTabShortcut } from "./tui-viewport.ts";
import { completeInput, completeOps, dslOpPartial, pathPartial } from "./tui-completion.ts";
import Review, { QuestionForm } from "./tui-review.ts";
import TuiSurface, {
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
} from "./tui-surface.ts";
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

    // Internal _plurnk emission READ (ops://...) and entry materialization EDIT are never rendered ({§cli-rendering})
    const emittedAnnouncement = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "1/1/0",
        title: "READ (ops://x3/1/2)",
        status: "completed",
        locations: [{ path: "ops://x3/1/2" }],
        content: [{ type: "content", content: { type: "text", text: "```SEND [200]\nHello\n```" } }],
        _meta: { plurnk: { op: "READ", origin: "_plurnk", attrs: { kind: "emission" } } },
    });
    assert.equal(emittedAnnouncement.length, 0);

    // Tool call retires reasoning tail and emits operation glyph; READ and FIND show {count} and no receipt body ({§cli-markdown-projection}, {§cli-rendering})
    const t1 = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "1/1/1",
        title: "READ",
        status: "completed",
        rawInput: { target: { raw: "plurnk:///session.md" }, lineMarker: { marks: [1, -1] } },
        rawOutput: { range: { returned: [1, 78] } },
        content: [{ type: "content", content: { type: "text", text: "file contents" } }],
        _meta: { plurnk: { op: "READ" } },
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

    // NOTE category asides (plan/idea/fact/note) use category glyph and consume the category word ({§cli-rendering})
    const notePlan = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "1/1/2",
        title: "NOTE — plan",
        status: "completed",
        rawInput: { aside: "plan", body: "Evaluate and react to the Open Message." },
        _meta: { plurnk: { op: "NOTE" } },
    });
    assert.equal(notePlan[0]?.kind, "tool_call");
    if (notePlan[0]?.kind === "tool_call") {
        assert.equal(notePlan[0].glyph, "🚧");
        assert.equal(notePlan[0].origin, "model");
        assert.equal(notePlan[0].aside, null);
        assert.equal(notePlan[0].noteBody, "Evaluate and react to the Open Message.");
    }

    // Harness NOTE (_plurnk origin) sets contentLines and renders all lines indented 4 spaces ({§cli-rendering})
    const harnessNote = presenter.apply({
        sessionUpdate: "tool_call_update",
        toolCallId: "1/1/3",
        title: "NOTE — review",
        status: "completed",
        rawInput: { aside: "review", body: "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6" },
        _meta: { plurnk: { op: "NOTE", origin: "_plurnk" } },
    });
    assert.equal(harnessNote[0]?.kind, "tool_call");
    if (harnessNote[0]?.kind === "tool_call") {
        assert.equal(harnessNote[0].origin, "_plurnk");
        assert.equal(harnessNote[0].noteBody, "Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6");
        assert.deepEqual(harnessNote[0].contentLines, ["Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6"]);
        const renderedHarnessNote = renderOperationBlock({
            glyph: harnessNote[0].glyph,
            op: harnessNote[0].op,
            target: harnessNote[0].target,
            scope: harnessNote[0].scope,
            aside: harnessNote[0].aside,
            count: harnessNote[0].count,
            outcome: harnessNote[0].outcome,
            contentLines: harnessNote[0].contentLines,
            outputLines: harnessNote[0].outputLines,
            coordinate: harnessNote[0].toolCallId,
            previewLimit: 2,
            columns: 80,
        });
        assert.match(renderedHarnessNote, /    Line 6/u);
        assert.doesNotMatch(renderedHarnessNote, /\+\d+ line/u);
    }

    // Concluded runtime execution previews streamed output under the operation row and suppresses duplicate obligation READ ({§cli-rendering}, {§cli-problems-and-notices})
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
        assert.deepEqual(execDone[0].outputLines, ["Result line 1\nResult line 2\nResult line 3"]);
        const renderedExec = renderOperationBlock({
            glyph: execDone[0].glyph,
            op: execDone[0].op,
            target: execDone[0].target,
            scope: execDone[0].scope,
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
        assert.match(renderedExec, /⚙️\s+brave[\s\S]*Result line 1[\s\S]*Result line 2[\s\S]*\+1 line/u);
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
        assert.deepEqual(shDone[0].contentLines, ["git status --short"]);
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

    // Rich TUI waterfall formatting: 🐹 model replies, NOTE bodies, operation previews, 💭 reasoning, 🎯 loop summary
    assert.match(renderModelReply("Hello **world**", 80, { op: "SEND", status: 200 }), /🐹[\s\S]*Hello/);
    assert.match(renderModelReply("Cancelled", 80, { op: "SEND", status: 499 }), /❌/);
    assert.match(renderModelReply("Waiting", 80, { op: "WAIT", status: 200 }), /⏳/);
    assert.match(
        renderNoteBlock({ glyph: "💡", aside: null, body: "Full note markdown body", columns: 80 }),
        /💡\n[\s\S]*Full note markdown body/,
    );
    assert.match(
        renderOperationBlock({
            glyph: "📝",
            op: "EDIT",
            target: "file:///tmp/a.ts",
            scope: "<1,10>",
            aside: "check",
            contentLines: ["l1\nl2\nl3\nl4\nl5\nl6"],
            coordinate: "1/1/1",
            previewLimit: 5,
            columns: 80,
        }),
        /📝[\s\S]*\(file:\/\/\/tmp\/a\.ts\) <1,10>[\s\S]*\+1 line · log:\/\/\/1\/1\/1\/EDIT/,
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
        description: "All Open Messages resolved. Review new results; emit no OPs if finished.",
        _meta: {
            plurnk: {
                notice: {
                    source: "engine:turn",
                    kind: "results_pending",
                    message: "All Open Messages resolved. Review new results; emit no OPs if finished.",
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

test("{§cli-repl-mode} {§cli-inline-review} {§cli-interactive-command-discovery} {§cli-color-policy}: pi-tui TuiSurface, TailText, Review, QuestionForm, completion, color scheme, and shortcuts", async () => {
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
        /workspace: ws · session: user · model: fast · effort: high · yolo: off · \/help/u,
    );
    assert.equal(resumeCommand("ws", "my session"), "plurnk --workspace ws --session 'my session'");
    assert.match(renderSubmittedInput("line 1\nline 2"), /🎤 line 1[\s\S]*line 2/u);
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

    // TuiSurface + Review over fake Terminal ({§cli-inline-review})
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
    const surface = new TuiSurface(fakeTerminal);
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
        title: "EDIT file:///tmp/a.txt",
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
    surface.stop();

    // Completion ({§cli-interactive-command-discovery})
    assert.deepEqual(dslOpPartial("```re"), { fence: "```", typed: "re" });
    const [ops] = completeOps({ fence: "````", typed: "RE" });
    assert.ok(ops.includes("````READ"));
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

    // Service and model catalog update formatting ({§cli-subcommands})
    const formattedUpdate = formatServiceUpdateResult({
        catalog: { status: "updated", models: 500, providers: 20, addedModels: 4 },
        service: {
            package: "@plurnk/plurnk-service",
            version: "4.4.0",
            artifact: "dist",
            upgradeCommand: "npm install -g @plurnk/plurnk-service@latest @plurnk/plurnk@latest",
        },
    });
    assert.match(formattedUpdate, /catalog: updated \(500 models across 20 providers, \+4 new\)/u);
    assert.match(formattedUpdate, /version: @plurnk\/plurnk-service@4\.4\.0 — to update packages, stop the daemon and run: npm install -g @plurnk\/plurnk-service@latest @plurnk\/plurnk@latest/u);
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
                                op: "EDIT",
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
});
