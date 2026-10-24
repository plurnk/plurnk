// RFC 9457 Problems and transient Notice rendering.

import { test } from "node:test";
import assert from "node:assert/strict";

// A developer's terminal may export COLORFGBG; the accents pinned here are the dark ground's.
delete process.env.COLORFGBG;

process.env.NO_COLOR = "1";

const {
    renderDiagnostic,
    clientHistoryLost,
    ProblemError,
    clientConnectionRefused,
    isUnreachable,
    clientFlagInvalid,
    clientFlagMissingDependency,
    clientSubcommandUnknownVerb,
    clientSubcommandMissingArgument,
    clientSubcommandCoordinateInvalid,
    clientSubcommandEntryNotFound,
    clientProposalEditsBlocked,
    clientRuntimeError,
    clientAcpError,
    clientTransportTerminalMissing,
    clientModelUnselected,
} = await import("./diagnostics.ts");

test("[§cli-partial-record] ACP failures preserve exact Problems and distinguish connection refusal from a broken exchange", () => {
    const url = "http://127.0.0.1:1066/acp";
    const problem = clientTransportTerminalMissing();
    assert.strictEqual(clientAcpError(url, new ProblemError(problem)), problem);
    const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
    assert.deepEqual(clientAcpError(url, refused), clientConnectionRefused(url, refused));
    assert.equal(clientAcpError(url, new TypeError("terminated")).type, "https://problems.plurnk.xyz/client/acp/error");
    assert.equal(clientAcpError(url, new TypeError("terminated")).detail, "terminated");
});

test("{§cli-model-selection} missing-model guidance names the key the backend needs, then the selection commands", () => {
    const notice = clientModelUnselected();
    assert.equal(notice.level, "warn");
    const message = notice.message ?? "";
    assert.match(message, /API key to the backend/u);
    assert.ok(message.indexOf("API key") < message.indexOf("/models"), "the key comes before the commands it unlocks");
    assert.match(message, /\/model <selector>/u);
    assert.deepEqual(notice.hints, ["https://github.com/plurnk/plurnk#models"]);
});

test("[§cli-notice-rendering] renderDiagnostic renders a Notice as an inline row titled by its discriminator", () => {
    assert.equal(renderDiagnostic({ source: "engine:rail", kind: "strike", level: "info" }), "📌 engine:rail:strike");
});

test("renderDiagnostic puts a Notice message on the same row", () => {
    const out = renderDiagnostic({
        source: "engine:rail",
        kind: "recovery",
        level: "info",
        message: "trying again",
    });
    assert.equal(out, "📌 engine:rail:recovery — trying again");
});

test("renderDiagnostic renders ContentOffset and LogCoordinate positions", () => {
    assert.match(
        renderDiagnostic({
            source: "grammar",
            kind: "parse_advisory",
            level: "warn",
            position: { type: "content-offset", line: 12, column: 3 },
        }),
        /L12 col3/,
    );
    assert.match(
        renderDiagnostic({
            source: "engine:rail",
            kind: "retry",
            level: "info",
            position: { type: "log-coordinate", coordinate: "log:///1/2/3", op: "EDIT" },
        }),
        /log:\/\/\/1\/2\/3 \(EDIT\)/,
    );
});

test("renderDiagnostic renders producer snippets and hints below the message", () => {
    const out = renderDiagnostic({
        source: "grammar",
        kind: "parse_advisory",
        level: "warn",
        snippet: "2:\t### EDIT_ (worker://foo\n3:\t               ^",
        hints: ["close the EDIT target"],
    });
    assert.deepEqual(out.split("\n"), [
        "⚠️ grammar:parse_advisory",
        "  2:\t### EDIT_ (worker://foo",
        "  3:\t               ^",
        "close the EDIT target",
    ]);
});

const colored = <T>(render: () => T): T => {
    const saved = process.env.PLURNK_CLIENT_COLOR;
    process.env.PLURNK_CLIENT_COLOR = "always";
    try { return render(); } finally {
        if (saved === undefined) delete process.env.PLURNK_CLIENT_COLOR;
        else process.env.PLURNK_CLIENT_COLOR = saved;
    }
};

test("{§cli-notice-rendering} Problems and notices share the operation-row glyph vocabulary: ❌, ⛔, ⚠️, 📌", () => {
    const [problem, error, warn, info] = colored(() => [
        renderDiagnostic(clientRuntimeError("failed")),
        renderDiagnostic({ source: "engine", kind: "fatal", level: "error", message: "stopped" }),
        renderDiagnostic({ source: "client:worker", kind: "history_lost", level: "warn", message: "update available" }),
        renderDiagnostic({ source: "engine", kind: "graceful", level: "info", message: "done" }),
    ]);
    assert.match(problem, /^\x1b\[1;31m❌\x1b\[0m/u);
    assert.match(problem, / — \x1b\[31mfailed\x1b\[0m$/u);
    assert.match(error, /^\x1b\[1;31m⛔\x1b\[0m/u);
    assert.match(warn, /^\x1b\[1;31m⚠️\x1b\[0m/u);
    assert.match(info, /^\x1b\[1;38;5;145m📌\x1b\[0m/u);
    assert.match(error, / — \x1b\[31mstopped\x1b\[0m$/u);
    assert.match(warn, / — \x1b\[31mupdate available\x1b\[0m$/u);
    assert.match(info, / — \x1b\[38;5;145mdone\x1b\[0m$/u);
});

test("renderDiagnostic renders a Problem's producer-owned recovery once", () => {
    const out = renderDiagnostic({
        ...clientRuntimeError("The request failed."),
        recovery: "Retry after restoring the connection.",
    });
    assert.deepEqual(out.split("\n"), [
        "❌ client:runtime:error — The request failed.",
        "Retry after restoring the connection.",
    ]);
});

test("{§cli-notice-rendering} notice kinds and teaching never override declared severity or change the payload", () => {
    const kinds = [
        "output_unaccounted", "parse_advisory", "search_progress", "git_inspection_refused",
        "continued_without_note", "outside_text", "invalid_emission", "output_truncated",
        "provider_warning", "provider_retry", "provider_unavailable", "path_normalized",
        "read_fanout_bounded", "parse_issues_unavailable", "metadata_ignored", "scope_normalized",
        "edit_merged", "unknown_kind",
    ];
    for (const kind of kinds) {
        for (const level of ["warn", "error", "info"] as const) {
            const notice = Object.freeze({
                source: "fixture", kind, level, message: "Exact message.",
                directive: "Model-facing teaching.",
            });
            const before = JSON.stringify(notice);
            const glyph = level === "warn" ? "⚠️" : level === "error" ? "⛔" : "📌";
            assert.equal(renderDiagnostic(notice), `${glyph} fixture:${kind} — Exact message.`);
            assert.equal(JSON.stringify(notice), before);
        }
    }
});

test("[§cli-problem-control-flow] ProblemError carries exact Problem Details and exit code", () => {
    const problem = clientFlagInvalid("--project-root", "./relative", "must be absolute");
    const error = new ProblemError(problem);
    assert.equal(error.exitCode, 64);
    assert.equal(error.problem, problem);
    assert.equal(error.message, problem.detail);
    assert.equal(error.name, "ProblemError");
});

test("ProblemError exit code can be overridden", () => {
    const error = new ProblemError(clientConnectionRefused("http://localhost", "refused"), 1);
    assert.equal(error.exitCode, 1);
});

test("ProblemError rejects a typed but invalid Problem at the control-flow boundary", () => {
    assert.throws(
        () => new ProblemError({
            type: "relative",
            title: "",
            status: 200,
            detail: "",
        }),
        /invalid RFC 9457 Problem Details/,
    );
});

test("[§cli-connection-onboarding] isUnreachable only classifies connection-level failures", () => {
    const refused = new TypeError("fetch failed");
    (refused as { cause?: unknown }).cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1066"), { code: "ECONNREFUSED" });
    assert.equal(isUnreachable(refused), true);
    assert.equal(isUnreachable(new TypeError("fetch failed")), true);
    assert.equal(isUnreachable(new Error("ACP run failed: 500 — runLoop exploded")), false);
    assert.equal(isUnreachable("not even an error"), false);
});

test("[§cli-problems-and-notices] clientConnectionRefused is an RFC 9457 Problem", () => {
    const problem = clientConnectionRefused("http://127.0.0.1:1066", new Error("ECONNREFUSED"));
    assert.equal(problem.type, "https://problems.plurnk.xyz/client/connection/refused");
    assert.equal(problem.title, "Refused");
    assert.equal(problem.status, 503);
    assert.equal(problem.detail, "ECONNREFUSED");
    assert.equal(problem.source, "client:connection");
    assert.equal(problem.kind, "refused");
    assert.equal(problem.url, "http://127.0.0.1:1066");
    assert.ok(Array.isArray(problem.hints) && problem.hints.length > 0);
});

test("clientFlagInvalid preserves actionable extensions on its Problem", () => {
    const problem = clientFlagInvalid("--project-root", "./relative", "must be absolute");
    assert.equal(problem.status, 400);
    assert.equal(problem.flag, "--project-root");
    assert.equal(problem.value, "./relative");
    assert.equal(problem.detail, "must be absolute");
});

test("clientFlagMissingDependency names both flags", () => {
    const problem = clientFlagMissingDependency("--worker", "--workspace");
    assert.equal(problem.kind, "missing-dependency");
    assert.match(problem.detail, /--worker requires --workspace/);
});

test("[§cli-subcommands] subcommand Problems preserve recovery facts", () => {
    const unknown = clientSubcommandUnknownVerb("workspace foo", ["list", "workers"]);
    const missing = clientSubcommandMissingArgument("plurnk workspace workers", "<name>");
    const coordinate = clientSubcommandCoordinateInvalid("bad");
    const entry = clientSubcommandEntryNotFound("3/1/2", 9);
    assert.match(unknown.detail, /Available: list, workers/);
    assert.deepEqual(unknown.available, ["list", "workers"]);
    assert.equal(missing.path, "plurnk workspace workers");
    assert.equal(missing.argument, "<name>");
    assert.equal(coordinate.coordinate, "bad");
    assert.match(coordinate.recovery as string, /<loop>\/<turn>\/<sequence>/);
    assert.equal(entry.coordinate, "3/1/2");
    assert.equal(entry.workerId, 9);
    assert.match(entry.recovery as string, /worker/);
});

test("clientProposalEditsBlocked remains a transient Notice", () => {
    const notice = clientProposalEditsBlocked();
    assert.equal(notice.source, "client:proposal");
    assert.equal(notice.kind, "edits_blocked");
    assert.equal(notice.level, "warn");
    assert.match(notice.message ?? "", /no review channel/);
    assert.equal("status" in notice, false);
});

test("runtime failures are Problems", () => {
    const runtime = clientRuntimeError("a string");
    assert.equal(runtime.status, 500);
    assert.equal(runtime.detail, "a string");
});

test("a missing terminal cannot recommend replaying a possibly completed run", () => {
    const problem = clientTransportTerminalMissing();
    assert.equal(problem.status, 502);
    assert.equal(problem.retryable, false);
});

test("[§cli-history-lost] a lost history renders as a warning naming the workspace and the worker", () => {
    const notice = clientHistoryLost("dogfood", "plurnk");
    assert.equal(notice.kind, "history_lost");
    assert.equal(notice.level, "warn");
    const [title] = renderDiagnostic(notice).split("\n");
    assert.match(title!, /^⚠️ /u);
    assert.match(title!, /\bdogfood\b/u, "the workspace is named");
    assert.match(title!, /\bplurnk\b/u, "the worker is named");
});
