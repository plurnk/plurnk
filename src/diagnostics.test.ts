// RFC 9457 Problems and transient Notice rendering.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NO_COLOR = "1";

const {
    renderDiagnostic,
    ProblemError,
    clientConnectionRefused,
    isUnreachable,
    clientConnectionClosed,
    clientFlagInvalid,
    clientFlagMissingDependency,
    clientSubcommandWorkspaceNotFound,
    clientSubcommandWorkspaceAmbiguous,
    clientSubcommandUnknownVerb,
    clientSubcommandMissingArgument,
    clientSubcommandCoordinateInvalid,
    clientSubcommandEntryNotFound,
    clientProposalEditsBlocked,
    clientRuntimeError,
    clientRpcError,
    clientTransportTerminalMissing,
} = await import("./diagnostics.ts");

test("[§cli-notice-rendering] renderDiagnostic renders a minimal Notice discriminator", () => {
    const out = renderDiagnostic({ source: "engine:rail", kind: "strike", level: "info" });
    assert.match(out, /📡 engine:rail:strike/);
    assert.match(out, /^📡/);
});

test("renderDiagnostic renders a Notice message in quotes", () => {
    const out = renderDiagnostic({
        source: "engine:rail",
        kind: "recovery",
        level: "info",
        message: "trying again",
    });
    assert.match(out, /"trying again"/);
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

test("renderDiagnostic renders producer snippets and hints below the headline", () => {
    const out = renderDiagnostic({
        source: "grammar",
        kind: "parse_advisory",
        level: "warn",
        snippet: "2:\t## EDIT0 (worker://foo\n3:\t               ^",
        hints: ["close the EDIT target"],
    });
    const lines = out.split("\n");
    assert.equal(lines.length, 4);
    assert.match(lines[1], /^   2:/);
    assert.match(lines[2], /^   3:/);
    assert.match(lines[3], /^   close the EDIT target/);
});

const freshDiagnostics = async (tag: string): Promise<typeof import("./diagnostics.ts")> =>
    await import(`./diagnostics.ts?${tag}`) as typeof import("./diagnostics.ts");

test("renderDiagnostic colors Problems red", async () => {
    delete process.env.NO_COLOR; // any non-empty value disables (no-color.org, plurnk#29)
    const module = await freshDiagnostics("problem-color");
    process.env.NO_COLOR = "1";
    const out = module.renderDiagnostic(clientRuntimeError("failed"));
    assert.match(out, /\x1b\[31m/);
    assert.doesNotMatch(out, /\x1b\[2m"failed"/);
});

test("renderDiagnostic renders a Problem's producer-owned recovery once", () => {
    const out = renderDiagnostic({
        ...clientRuntimeError("The request failed."),
        recovery: "Retry after restoring the connection.",
    });
    assert.match(out, /"The request failed\."/);
    assert.match(out, /^   Retry after restoring the connection\.$/m);
});

test("renderDiagnostic uses producer-owned Notice severity", async () => {
    delete process.env.NO_COLOR; // any non-empty value disables (no-color.org, plurnk#29)
    const module = await freshDiagnostics("notice-colors");
    process.env.NO_COLOR = "1";
    const warn = module.renderDiagnostic({
        source: "client:connection",
        kind: "daemon_stale",
        level: "warn",
        message: "update available",
    });
    const info = module.renderDiagnostic({
        source: "engine",
        kind: "graceful",
        level: "info",
        message: "done",
    });
    assert.match(warn, /\x1b\[33m/);
    assert.doesNotMatch(warn, /\x1b\[31m/);
    assert.doesNotMatch(info, /\x1b\[31m|\x1b\[33m/);
    assert.match(info, /\x1b\[2m"done"/);
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
    (refused as { cause?: unknown }).cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3044"), { code: "ECONNREFUSED" });
    assert.equal(isUnreachable(refused), true);
    assert.equal(isUnreachable(new TypeError("fetch failed")), true);
    assert.equal(isUnreachable(new Error("bridge run failed: 500 — runLoop exploded")), false);
    assert.equal(isUnreachable("not even an error"), false);
});

test("[§cli-problems-and-notices] clientConnectionRefused is an RFC 9457 Problem", () => {
    const problem = clientConnectionRefused("http://127.0.0.1:3044", new Error("ECONNREFUSED"));
    assert.equal(problem.type, "https://problems.plurnk.xyz/client/connection/refused");
    assert.equal(problem.title, "Refused");
    assert.equal(problem.status, 503);
    assert.equal(problem.detail, "ECONNREFUSED");
    assert.equal(problem.source, "client:connection");
    assert.equal(problem.kind, "refused");
    assert.equal(problem.url, "http://127.0.0.1:3044");
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

test("workspace lookup Problems carry their structured facts", () => {
    const missing = clientSubcommandWorkspaceNotFound("alpha");
    const ambiguous = clientSubcommandWorkspaceAmbiguous("dup", 3);
    assert.equal(missing.status, 404);
    assert.equal(missing.name, "alpha");
    assert.match(missing.detail, /"alpha"/);
    assert.equal(ambiguous.status, 409);
    assert.equal(ambiguous.count, 3);
    assert.match(ambiguous.detail, /3 workspaces/);
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

test("RPC, runtime, and connection failures are Problems", () => {
    const rpc = clientRpcError("loop.run", new Error("method not found"));
    const runtime = clientRuntimeError("a string");
    const closed = clientConnectionClosed(new Error("connection closed before response"));
    assert.equal(rpc.status, 502);
    assert.equal(rpc.method, "loop.run");
    assert.match(rpc.detail, /method not found/);
    assert.equal(runtime.status, 500);
    assert.equal(runtime.detail, "a string");
    assert.equal(closed.status, 502);
    assert.match(closed.detail, /connection closed/);
});

test("a missing terminal cannot recommend replaying a possibly completed run", () => {
    const problem = clientTransportTerminalMissing();
    assert.equal(problem.status, 502);
    assert.equal(problem.retryable, false);
});
