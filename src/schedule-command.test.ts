import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { AcpClient, ScheduleActionInput, ScheduleRunResult } from "./acp-client.ts";
import { executeFamilyCommand } from "./repl-commands.ts";
import { dispatchSlashCommand, type ReplSlashCommandContext } from "./repl-slash-commands.ts";
import {
    formatScheduleInspect,
    formatScheduleRows,
    formatScheduleRunResult,
    formatScheduleStatusResult,
    parseScheduleCommand,
    ScheduleCommandUsageError,
    tokenizeSlashArgs,
} from "./schedule-command.ts";
import { completeInput } from "./term-completion.ts";

const captureStream = (): { stream: PassThrough; text: () => string } => {
    const stream = new PassThrough();
    let buf = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
        buf += chunk;
    });
    return { stream, text: () => buf };
};

test("{§cli-configuration-source} tokenizeSlashArgs preserves quoted rules, JSON payloads, and escapes while refusing unclosed quotes", () => {
    assert.deepEqual(
        tokenizeSlashArgs('add daily session1 "0 9 * * 1-5" Check morning status'),
        ["add", "daily", "session1", "0 9 * * 1-5", "Check", "morning", "status"],
    );
    assert.deepEqual(
        tokenizeSlashArgs(`add smoke --manual --step plurnk.sh '{"text":"echo \\"hi\\""}' --aside "Run check"`),
        ["add", "smoke", "--manual", "--step", "plurnk.sh", '{"text":"echo \\"hi\\""}', "--aside", "Run check"],
    );
    assert.deepEqual(
        tokenizeSlashArgs('add greet --target session1 --prompt "Say \\"hello\\" now"'),
        ["add", "greet", "--target", "session1", "--prompt", 'Say "hello" now'],
    );
    assert.throws(
        () => tokenizeSlashArgs("add broken --manual --step plurnk.sh '{\"text\":\"unterminated}"),
        ScheduleCommandUsageError,
    );
});

test("{§cli-configuration-source} parseScheduleCommand supports manual/once/timed prompts, --step/--run macros, show/inspect, and rejects conflicting flags", () => {
    assert.deepEqual(parseScheduleCommand([]), {
        kind: "action",
        sub: "list",
        actionName: "workspace.schedule.list",
        params: {},
    });
    assert.deepEqual(parseScheduleCommand(["show", "nightly"]), { kind: "inspect", alias: "nightly" });
    assert.deepEqual(parseScheduleCommand(["inspect", "nightly"]), { kind: "inspect", alias: "nightly" });
    assert.deepEqual(parseScheduleCommand(["discover", "0 9 * * 1-5"]), {
        kind: "action",
        sub: "discover",
        actionName: "workspace.schedule.discover",
        params: { rule: "0 9 * * 1-5" },
    });

    // Backward-compatible positional prompt schedule
    assert.deepEqual(parseScheduleCommand(["add", "standup", "session1", "0 9 * * 1-5", "Summarize", "PRs"]), {
        kind: "action",
        sub: "add",
        actionName: "workspace.schedule.add",
        params: {
            alias: "standup",
            rule: "0 9 * * 1-5",
            target: "session://session1",
            prompt: "Summarize PRs",
        },
    });

    // Prompt schedule with --once, --persona, --no-catchup
    assert.deepEqual(
        parseScheduleCommand([
            "replace", "audit", "--once", "--target", "review", "--persona", "auditor", "--no-catchup",
            "--prompt", "Audit release notes.",
        ]),
        {
            kind: "action",
            sub: "replace",
            actionName: "workspace.schedule.replace",
            params: {
                alias: "audit",
                rule: "once",
                target: "session://review",
                prompt: "Audit release notes.",
                persona: "auditor",
                catchup: false,
            },
        },
    );

    // Multi-step macro using repeatable --step + --aside
    assert.deepEqual(
        parseScheduleCommand([
            "add", "smoke", "--manual",
            "--step", "plurnk.edit", '{"path":"workspace:///probe.txt","text":"ok"}', "--aside", "Write probe",
            "--step", "plurnk.sh", '{"text":"echo live-ok"}',
        ]),
        {
            kind: "action",
            sub: "add",
            actionName: "workspace.schedule.add",
            params: {
                alias: "smoke",
                rule: "manual",
                run: [
                    {
                        server: "plurnk",
                        tool: "edit",
                        arguments: { path: "workspace:///probe.txt", text: "ok" },
                        aside: "Write probe",
                    },
                    {
                        server: "plurnk",
                        tool: "sh",
                        arguments: { text: "echo live-ok" },
                    },
                ],
            },
        },
    );

    // Macro via --run JSON (omitting timing lets daemon default to manual)
    assert.deepEqual(
        parseScheduleCommand([
            "add", "quick",
            "--run", '[{"server":"gitea","tool":"list_issues","arguments":{"owner":"plurnk","repo":"plurnk"}}]',
        ]),
        {
            kind: "action",
            sub: "add",
            actionName: "workspace.schedule.add",
            params: {
                alias: "quick",
                run: [
                    {
                        server: "gitea",
                        tool: "list_issues",
                        arguments: { owner: "plurnk", repo: "plurnk" },
                    },
                ],
            },
        },
    );

    assert.deepEqual(parseScheduleCommand(["run", "smoke"]), {
        kind: "action",
        sub: "run",
        actionName: "workspace.schedule.run",
        params: { alias: "smoke" },
    });
    assert.deepEqual(parseScheduleCommand(["done", "todo-1"]), {
        kind: "action",
        sub: "status",
        actionName: "workspace.schedule.status",
        params: { alias: "todo-1", status: "done" },
    });
    assert.deepEqual(parseScheduleCommand(["reopen", "todo-1"]), {
        kind: "action",
        sub: "status",
        actionName: "workspace.schedule.status",
        params: { alias: "todo-1", status: "open" },
    });

    // Matrix of invalid forms refused with structured usage errors
    const invalidInputs: readonly (readonly string[])[] = [
        ["show"],
        ["run"],
        ["done"],
        ["reopen"],
        ["add"],
        ["add", "x", "--manual", "--once", "--step", "plurnk.sh"],
        ["add", "x", "--step", "plurnk.sh", "--run", '[{"server":"plurnk","tool":"sh"}]'],
        ["add", "x", "--step", "plurnk.sh", "--prompt", "no mixing"],
        ["add", "x", "--aside", "orphan", "--step", "plurnk.sh"],
        ["add", "x", "--step", "notdot"],
        ["add", "x", "--step", "plurnk.sh", "{bad-json"],
        ["add", "x", "--run", "not-json"],
        ["add", "x", "--run", "[]"],
        ["add", "x", "--manual", "--target", "session1"],
        ["bogus"],
    ];
    for (const args of invalidInputs) {
        assert.throws(() => parseScheduleCommand(args), ScheduleCommandUsageError, `expected refusal for ${JSON.stringify(args)}`);
    }
});

test("{§cli-configuration-source} formatScheduleRows, formatScheduleInspect, formatScheduleRunResult, and formatScheduleStatusResult project macros, prompts, and step receipts", () => {
    assert.equal(formatScheduleRows({ definitions: [] }), "schedule: none\n");
    const listed = formatScheduleRows({
        definitions: [
            {
                alias: "nightly",
                state: "active",
                origin: "workspace",
                definition: {
                    rule: "0 9 * * 1-5",
                    target: "session://session1",
                    persona: "auditor",
                    prompt: "Check overnight CI failures.",
                },
                detail: {
                    kind: "prompt",
                    status: "open",
                    rule: "0 9 * * 1-5",
                    text: "every weekday at 09:00",
                    next: "2026-11-24T09:00:00Z",
                },
                provenance: { source: "PLURNK_SCHEDULE_nightly" },
            },
            {
                alias: "smoke",
                state: "active",
                origin: "workspace",
                definition: {
                    rule: "manual",
                    run: [
                        { server: "plurnk", tool: "edit", arguments: { path: "workspace:///a.txt", text: "ok" }, aside: "Seed file" },
                        { server: "plurnk", tool: "sh", arguments: { text: "echo hi" } },
                    ],
                },
                detail: {
                    kind: "run",
                    status: "open",
                    rule: "manual",
                    text: "manual trigger",
                    next: null,
                    lastFiredAt: "2026-11-23T12:00:00Z",
                    loopId: 4,
                },
            },
        ],
    });
    assert.match(listed, /nightly\s+active\s+prompt\s+status=open\s+0 9 \* \* 1-5 \(next 2026-11-24T09:00:00Z\)\s+session:\/\/session1 \(auditor\) · Check overnight CI failures\.\s+source=PLURNK_SCHEDULE_nightly/u);
    assert.match(listed, /smoke\s+active\s+macro\s+status=open\s+manual\s+2 steps: plurnk\.edit → plurnk\.sh/u);

    const inspectedMacro = formatScheduleInspect({
        alias: "smoke",
        state: "active",
        origin: "workspace",
        definition: {
            rule: "manual",
            run: [
                { server: "plurnk", tool: "edit", arguments: { path: "workspace:///a.txt", text: "ok" }, aside: "Seed file" },
                { server: "plurnk", tool: "sh", arguments: { text: "echo hi" } },
            ],
        },
        detail: {
            kind: "run",
            status: "open",
            rule: "manual",
            text: "manual trigger",
            lastFiredAt: "2026-11-23T12:00:00Z",
            loopId: 4,
        },
    });
    assert.match(inspectedMacro, /alias:\s+smoke/u);
    assert.match(inspectedMacro, /kind:\s+macro \(run\)/u);
    assert.match(inspectedMacro, /steps \(2\):/u);
    assert.match(inspectedMacro, /#0\s+plurnk\.edit\s+\{"path":"workspace:\/\/\/a\.txt","text":"ok"\}\s+\(Seed file\)/u);
    assert.match(inspectedMacro, /#1\s+plurnk\.sh\s+\{"text":"echo hi"\}/u);

    const runOut = formatScheduleRunResult("smoke", {
        alias: "smoke",
        status: "done",
        loopId: 9,
        doneAt: "2026-11-23T12:05:00Z",
        results: [
            { index: 0, server: "plurnk", tool: "edit", status: 201, uri: "log:///9/1/1/edit" },
            { index: 1, server: "plurnk", tool: "sh", status: 200, uri: "exec:///sh/abc123", preview: "live-macro-ok" },
            {
                index: 2,
                server: "gitea",
                tool: "issue_read",
                status: 404,
                problem: { detail: "Issue #999 does not exist." },
            },
        ],
    });
    assert.match(runOut, /^smoke\s+done\s+\(3 steps · loop 9 · done 2026-11-23T12:05:00Z\)/u);
    assert.match(runOut, /#0\s+plurnk\.edit\s+201\s+log:\/\/\/9\/1\/1\/edit/u);
    assert.match(runOut, /#1\s+plurnk\.sh\s+200\s+exec:\/\/\/sh\/abc123\s+— live-macro-ok/u);
    assert.match(runOut, /#2\s+gitea\.issue_read\s+404\n\s+! Issue #999 does not exist\./u);

    assert.equal(
        formatScheduleStatusResult("todo-1", { alias: "todo-1", status: "done", doneAt: "2026-11-23T12:05:00Z" }),
        "todo-1  done  (done 2026-11-23T12:05:00Z)\n",
    );
});

test("{§cli-configuration-source} {§cli-interactive-command-discovery} executeFamilyCommand, dispatchSlashCommand, and completeInput handle macro runs, 409 conflicts, show/inspect, and schedule completions", async () => {
    const calls: Array<{ kind: string; params: Record<string, unknown> }> = [];
    let runMode: "ok" | "already-done" | "already-running" = "ok";

    const fakeClient = {
        action: async (kind: string, params: Record<string, unknown>) => {
            calls.push({ kind, params });
            if (kind === "workspace.schedule.list") {
                return {
                    family: "schedule",
                    definitions: [
                        {
                            alias: "smoke",
                            state: "active",
                            origin: "workspace",
                            definition: {
                                rule: "once",
                                run: [{ server: "plurnk", tool: "sh", arguments: { text: "echo hi" } }],
                            },
                            detail: { kind: "run", status: "open", rule: "once", text: "unscheduled single-shot obligation" },
                        },
                    ],
                };
            }
            if (kind === "workspace.schedule.run") {
                if (runMode === "already-done") {
                    throw Object.assign(new Error("Schedule 'smoke' is already done."), {
                        code: -32000,
                        data: {
                            type: "https://problems.plurnk.xyz/schedule/already-done",
                            title: "Schedule already done",
                            status: 409,
                            detail: "Schedule 'smoke' is already done.",
                        },
                    });
                }
                if (runMode === "already-running") {
                    throw Object.assign(new Error("Schedule 'smoke' is already running."), {
                        code: -32000,
                        data: {
                            type: "https://problems.plurnk.xyz/schedule/already-running",
                            title: "Schedule already running",
                            status: 409,
                            detail: "Schedule 'smoke' is already running.",
                        },
                    });
                }
                const typedRunRes: ScheduleRunResult = {
                    alias: "smoke",
                    status: "done",
                    loopId: 5,
                    doneAt: "2026-11-23T13:00:00Z",
                    results: [
                        { index: 0, server: "plurnk", tool: "sh", status: 200, uri: "exec:///sh/1", preview: "hi" },
                    ],
                };
                return typedRunRes;
            }
            return { alias: params.alias, status: params.status ?? "open" };
        },
    } as unknown as AcpClient;

    // Compile-time type witness for ScheduleActionInput union
    const _promptDef: ScheduleActionInput = { alias: "a", target: "session://s", prompt: "hi", persona: "rev" };
    const _scriptDef: ScheduleActionInput = { alias: "b", rule: "manual", run: [{ server: "plurnk", tool: "sh", arguments: { text: "true" } }] };
    assert.ok(_promptDef.alias && _scriptDef.alias);

    const out1 = captureStream();
    const errs1: Array<Record<string, unknown>> = [];
    await executeFamilyCommand(fakeClient, "schedule", ["show", "smoke"], { workspace: "alpha" }, "/tmp", {
        surface: "cli",
        stdout: out1.stream,
        onError: (p) => errs1.push(p),
    });
    assert.equal(errs1.length, 0);
    assert.match(out1.text(), /alias:\s+smoke[\s\S]*#0\s+plurnk\.sh/u);

    const outMissing = captureStream();
    const errsMissing: Array<Record<string, unknown>> = [];
    await executeFamilyCommand(fakeClient, "schedule", ["inspect", "missing"], { workspace: "alpha" }, "/tmp", {
        surface: "cli",
        stdout: outMissing.stream,
        onError: (p) => errsMissing.push(p),
    });
    assert.equal(errsMissing[0]?.status, 404);

    // Run success formats per-step receipts
    const outRun = captureStream();
    const errsRun: Array<Record<string, unknown>> = [];
    await executeFamilyCommand(fakeClient, "schedule", ["run", "smoke"], { workspace: "alpha" }, "/tmp", {
        surface: "repl",
        stdout: outRun.stream,
        onError: (p) => errsRun.push(p),
    });
    assert.equal(errsRun.length, 0);
    assert.match(outRun.text(), /smoke\s+done[\s\S]*#0\s+plurnk\.sh\s+200\s+exec:\/\/\/sh\/1\s+— hi/u);

    // 409 already-done adds reopen hint for REPL & CLI
    runMode = "already-done";
    const errsDone: Array<Record<string, unknown>> = [];
    await executeFamilyCommand(fakeClient, "schedule", ["run", "smoke"], { workspace: "alpha" }, "/tmp", {
        surface: "repl",
        stdout: captureStream().stream,
        onError: (p) => errsDone.push(p),
    });
    assert.equal(errsDone[0]?.status, 409);
    assert.match(String(errsDone[0]?.detail), /\/schedule reopen smoke/u);

    // 409 already-running preserves exact status & detail
    runMode = "already-running";
    const errsRunning: Array<Record<string, unknown>> = [];
    await executeFamilyCommand(fakeClient, "schedule", ["run", "smoke"], { workspace: "alpha" }, "/tmp", {
        surface: "cli",
        stdout: captureStream().stream,
        onError: (p) => errsRunning.push(p),
    });
    assert.equal(errsRunning[0]?.status, 409);
    assert.match(String(errsRunning[0]?.detail), /already running/u);

    // Interactive slash command dispatch preserves quoted JSON & aside arguments
    const slashOut = captureStream();
    const slashErr = captureStream();
    const slashCtx = {
        client: fakeClient,
        options: { cwd: "/tmp", oauthTimeoutMs: 5000 } as ReplSlashCommandContext["options"],
        streams: {
            stdin: new PassThrough(),
            stdout: slashOut.stream,
            stderr: slashErr.stream,
            events: new PassThrough(),
            reasoning: new PassThrough(),
        },
        hasCustomEventsStream: false,
        pendingGates: new Map(),
        getSession: () => ({ sessionId: "1#session1", configOptions: [] }) as unknown as ReturnType<ReplSlashCommandContext["getSession"]>,
        setSession: () => undefined,
        getWorkspace: () => "alpha",
        setWorkspace: () => undefined,
        getSessionName: () => "session1",
        getProjectRoot: () => "/tmp",
        getLifecycle: () => "idle",
        getYolo: () => false,
        setYolo: () => undefined,
        clearForceReviewNextRun: () => undefined,
        getStagedComposerText: () => "",
        setStagedComposerText: () => undefined,
        beginLocalOAuth: () => ({ signal: new AbortController().signal, finish: () => undefined }),
        bindSession: async () => {
            throw new Error("unused");
        },
        adoptForkedSession: async () => {
            throw new Error("unused");
        },
        emitSessionBound: () => undefined,
        dispatchLine: async () => "continue" as const,
    } satisfies ReplSlashCommandContext;

    await dispatchSlashCommand(
        `/schedule add probe --manual --step plurnk.sh '{"text":"echo ok"}' --aside "Probe run"`,
        slashCtx,
    );
    assert.equal(slashErr.text(), "");
    const addCall = calls.find((c) => c.kind === "workspace.schedule.add");
    assert.deepEqual(addCall?.params, {
        alias: "probe",
        rule: "manual",
        run: [{ server: "plurnk", tool: "sh", arguments: { text: "echo ok" }, aside: "Probe run" }],
    });

    // Tab completion covers show/inspect subcommands, schedule aliases, and add/replace flags
    const compCtx = {
        cwd: "/tmp",
        getProjectRoot: () => "/tmp",
        getFamilyAliases: (f: string) => (f === "schedule" ? ["smoke", "standup"] : []),
    };
    const subComp = await completeInput("/schedule sh", compCtx);
    assert.deepEqual(subComp.suggestions.map((s) => s.value), ["show"]);
    const inspectComp = await completeInput("/schedule inspect s", compCtx);
    assert.deepEqual(inspectComp.suggestions.map((s) => s.value), ["smoke", "standup"]);
    const showComp = await completeInput("/schedule show sm", compCtx);
    assert.deepEqual(showComp.suggestions.map((s) => s.value), ["smoke"]);
    const replaceAliasComp = await completeInput("/schedule replace st", compCtx);
    assert.deepEqual(replaceAliasComp.suggestions.map((s) => s.value), ["standup"]);
    const flagComp = await completeInput("/schedule add smoke --st", compCtx);
    assert.deepEqual(flagComp.suggestions.map((s) => s.value), ["--step"]);
});
