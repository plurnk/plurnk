// Unit tests for src/telemetry.ts. Run with NO_COLOR=1 so ANSI codes
// collapse to empty and assertions stay textual.

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NO_COLOR = "1";

const {
    renderTelemetryEvent,
    TelemetryError,
    clientConnectionRefused,
    isUnreachable,
    clientConnectionClosed,
    clientFlagInvalid,
    clientFlagMissingDependency,
    clientSubcommandWorkspaceNotFound,
    clientSubcommandWorkspaceAmbiguous,
    clientSubcommandUnknownVerb,
    clientSubcommandMissingArgument,
    clientProposalEditsBlocked,
    clientRuntimeError,
    clientRpcError,
} = await import("./telemetry.ts");

// ─── Rendering: discriminator + position + message ───────────────────

test("[§cli-daemon-telemetry-event-notification][§cli-telemetry-rendering] renderTelemetryEvent: minimal event → '📡 source:kind' on indented line", () => {
    const out = renderTelemetryEvent({ source: "engine:rail", kind: "strike" });
    assert.match(out, /📡 engine:rail:strike/);
    assert.match(out, /^  /);
});

test("renderTelemetryEvent: message rendered in quotes after discriminator", () => {
    const out = renderTelemetryEvent({
        source: "client:flag",
        kind: "invalid",
        message: "must be an absolute path",
    });
    assert.match(out, /"must be an absolute path"/);
});

test("renderTelemetryEvent: ContentOffset position renders as 'L<n> col<n>'", () => {
    const out = renderTelemetryEvent({
        source: "grammar",
        kind: "parse_error",
        message: "unmatched tag",
        position: { type: "content-offset", line: 12, column: 3 },
    });
    assert.match(out, /L12 col3/);
});

test("renderTelemetryEvent: LogCoordinate position renders bare", () => {
    const out = renderTelemetryEvent({
        source: "engine:rail",
        kind: "action_failure",
        position: { type: "log-coordinate", coordinate: "log://1/2/3" },
    });
    assert.match(out, /log:\/\/1\/2\/3/);
});

test("renderTelemetryEvent: LogCoordinate with op renders 'coord (op)'", () => {
    const out = renderTelemetryEvent({
        source: "engine:rail",
        kind: "action_failure",
        position: { type: "log-coordinate", coordinate: "log://1/2/3", op: "EDIT" },
    });
    assert.match(out, /log:\/\/1\/2\/3 \(EDIT\)/);
});

test("renderTelemetryEvent: snippet rendered as indented block below headline", () => {
    const out = renderTelemetryEvent({
        source: "grammar",
        kind: "parse_error",
        snippet: "2:\t<<EDIT(worker://foo:\n3:\t^",
    });
    const lines = out.split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /grammar:parse_error/);
    assert.match(lines[1], /^     2:/);
    assert.match(lines[2], /^     3:/);
});

test("renderTelemetryEvent: hints rendered as indented continuation lines", () => {
    const out = renderTelemetryEvent({
        source: "client:connection",
        kind: "refused",
        message: "ECONNREFUSED",
        hints: ["Is the daemon running?", "Start it from plurnk-service"],
    });
    const lines = out.split("\n");
    assert.match(lines[0], /client:connection:refused/);
    assert.match(lines[1], /^     Is the daemon running\?/);
    assert.match(lines[2], /^     Start it from plurnk-service/);
});

// ─── Severity coloring (color-enabled import) ────────────────────────
// The main import runs under NO_COLOR; severity color needs a color-enabled
// instance. Query-suffixed dynamic import busts the ESM cache.
const freshTel = async (tag: string): Promise<typeof import("./telemetry.ts")> =>
    await import(`./telemetry.ts?${tag}`) as typeof import("./telemetry.ts");

test("renderTelemetryEvent: level 'error' headline is RED (not dim)", async () => {
    process.env.NO_COLOR = "0";
    const m = await freshTel("sev-err");
    process.env.NO_COLOR = "1";
    const out = m.renderTelemetryEvent({ source: "client:connection", kind: "refused", level: "error", message: "no daemon" });
    assert.match(out, /\x1b\[31m/);          // red
    assert.doesNotMatch(out, /\x1b\[2m"no daemon"/);  // message not dim
});

test("renderTelemetryEvent: level 'warn' headline is YELLOW", async () => {
    process.env.NO_COLOR = "0";
    const m = await freshTel("sev-warn");
    process.env.NO_COLOR = "1";
    const out = m.renderTelemetryEvent({ source: "client:connection", kind: "daemon_stale", level: "warn", message: "update available" });
    assert.match(out, /\x1b\[33m/);          // yellow
    assert.doesNotMatch(out, /\x1b\[31m/);   // not red
});

test("renderTelemetryEvent: level 'info' (or absent) stays uncolored, message dim", async () => {
    process.env.NO_COLOR = "0";
    const m = await freshTel("sev-neutral");
    process.env.NO_COLOR = "1";
    const out = m.renderTelemetryEvent({ source: "engine", kind: "graceful", level: "info", message: "done" });
    assert.doesNotMatch(out, /\x1b\[31m|\x1b\[33m/);  // not red/yellow
    assert.match(out, /\x1b\[2m"done"/);              // dim message
});

test("renderTelemetryEvent: snippet + hints both rendered in order", () => {
    const out = renderTelemetryEvent({
        source: "grammar",
        kind: "parse_error",
        snippet: "1:\toopsie",
        hints: ["fix the dsl"],
    });
    const lines = out.split("\n");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /grammar:parse_error/);
    assert.match(lines[1], /1:\toopsie/);
    assert.match(lines[2], /fix the dsl/);
});

test("renderTelemetryEvent: empty message → no quoted segment in headline", () => {
    const out = renderTelemetryEvent({
        source: "engine:rail",
        kind: "strike",
        message: "",
    });
    assert.doesNotMatch(out, /""/);
});

test("renderTelemetryEvent: null message handled the same as undefined", () => {
    const out = renderTelemetryEvent({
        source: "engine:rail",
        kind: "strike",
        message: null,
    });
    assert.doesNotMatch(out, /"null"|""/);
});

// ─── TelemetryError ───────────────────────────────────────────────────

test("[§cli-telemetryerror-for-control-flow] TelemetryError: defaults to exit code 64 (usage)", () => {
    const e = new TelemetryError({ source: "client:flag", kind: "invalid", message: "bad" });
    assert.equal(e.exitCode, 64);
    assert.equal(e.event.source, "client:flag");
});

test("TelemetryError: exit code can be overridden (e.g. 1 for runtime)", () => {
    const e = new TelemetryError({ source: "client:connection", kind: "refused" }, 1);
    assert.equal(e.exitCode, 1);
});

test("TelemetryError: message bubbles up as Error.message for stack traces", () => {
    const e = new TelemetryError({ source: "client:flag", kind: "invalid", message: "bad value" });
    assert.equal(e.message, "bad value");
    assert.equal(e.name, "TelemetryError");
});

test("TelemetryError: falls back to 'source:kind' when no message", () => {
    const e = new TelemetryError({ source: "engine:rail", kind: "strike" });
    assert.equal(e.message, "engine:rail:strike");
});

// ─── Client-side emitters: shape correctness ─────────────────────────

test("[§cli-connection-onboarding] isUnreachable: nothing-listening classes route to onboarding; an answering bridge's error does not", () => {
    const refused = new TypeError("fetch failed");
    (refused as { cause?: unknown }).cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3044"), { code: "ECONNREFUSED" });
    assert.equal(isUnreachable(refused), true, "ECONNREFUSED under fetch failed → onboarding");
    assert.equal(isUnreachable(new TypeError("fetch failed")), true, "bare fetch failed (undici wrap) → onboarding");
    assert.equal(isUnreachable(new Error("bridge run failed: 500 — runLoop exploded")), false, "an ANSWERING bridge surfaces its real cause");
    assert.equal(isUnreachable("not even an error"), false, "non-Error never classifies");
});

test("[§cli-errors-and-telemetry][§cli-shape] clientConnectionRefused includes URL + hints + cause message", () => {
    const ev = clientConnectionRefused("ws://127.0.0.1:3044", new Error("ECONNREFUSED"));
    assert.equal(ev.source, "client:connection");
    assert.equal(ev.kind, "refused");
    assert.equal(ev.url, "ws://127.0.0.1:3044");
    assert.equal(ev.message, "ECONNREFUSED");
    assert.ok(Array.isArray(ev.hints) && ev.hints.length > 0);
});

test("[§cli-client-source-events] clientFlagInvalid carries flag + value + reason", () => {
    const ev = clientFlagInvalid("--project-root", "./relative", "must be absolute");
    assert.equal(ev.source, "client:flag");
    assert.equal(ev.kind, "invalid");
    assert.equal(ev.flag, "--project-root");
    assert.equal(ev.value, "./relative");
    assert.equal(ev.message, "must be absolute");
});

test("clientFlagMissingDependency message names both flags", () => {
    const ev = clientFlagMissingDependency("--worker", "--workspace");
    assert.equal(ev.kind, "missing_dependency");
    assert.match(ev.message as string, /--worker requires --workspace/);
});

test("clientSubcommandWorkspaceNotFound quotes the name in message", () => {
    const ev = clientSubcommandWorkspaceNotFound("alpha");
    assert.equal(ev.kind, "workspace_not_found");
    assert.equal(ev.name, "alpha");
    assert.match(ev.message as string, /"alpha"/);
});

test("clientSubcommandWorkspaceAmbiguous carries count + name", () => {
    const ev = clientSubcommandWorkspaceAmbiguous("dup", 3);
    assert.equal(ev.kind, "workspace_ambiguous");
    assert.equal(ev.count, 3);
    assert.match(ev.message as string, /3 workspaces/);
});

test("[§cli-subcommands] clientSubcommandUnknownVerb lists available verbs when provided", () => {
    const ev = clientSubcommandUnknownVerb("workspace foo", ["list", "runs"]);
    assert.equal(ev.kind, "unknown_verb");
    assert.match(ev.message as string, /Available: list, runs/);
    assert.deepEqual(ev.available, ["list", "runs"]);
});

test("clientSubcommandMissingArgument names path + argument", () => {
    const ev = clientSubcommandMissingArgument("plurnk workspace runs", "<name>");
    assert.equal(ev.kind, "missing_argument");
    assert.equal(ev.path, "plurnk workspace runs");
    assert.equal(ev.argument, "<name>");
});

test("clientProposalEditsBlocked names the source/kind and the why", () => {
    const ev = clientProposalEditsBlocked();
    assert.equal(ev.source, "client:proposal");
    assert.equal(ev.kind, "edits_blocked");
    assert.match(ev.message ?? "", /no review channel/);
});

test("clientRpcError carries method + cause", () => {
    const ev = clientRpcError("loop.run", new Error("rpc error -32601: method not found"));
    assert.equal(ev.source, "client:rpc");
    assert.equal(ev.method, "loop.run");
    assert.match(ev.message as string, /method not found/);
});

test("clientRuntimeError catches non-Error throws too", () => {
    const ev = clientRuntimeError("a string");
    assert.equal(ev.source, "client:runtime");
    assert.equal(ev.message, "a string");
});

test("clientConnectionClosed shape", () => {
    const ev = clientConnectionClosed(new Error("connection closed before response"));
    assert.equal(ev.kind, "closed");
    assert.match(ev.message as string, /connection closed/);
});
