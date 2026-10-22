import { test, before, after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { stripVTControlCharacters } from "node:util";
import { bootDaemon, locateDaemon, type Daemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";
import type { LogEntryWire } from "../../src/render.ts";
import { messagesOf, partsOf } from "../agui-parts.ts";

let daemon: Daemon;
before(async () => {
    const service = await locateDaemon();
    assert.ok(service);
    daemon = await bootDaemon(service, { readyTimeoutMs: 30_000 });
});
after(async () => { await daemon?.cleanup(); });

const receipt = (op: string, index: number, status = 200): LogEntryWire => ({
    id: index + 1, worker_id: 1, op, origin: "model", signal: null,
    target: `file://receipt-${index}.txt`,
    lineMarker: null, status_rx: status, tx: { op, target: { kind: "local", raw: `receipt-${index}.txt` } },
    rx: status >= 400 ? { status, problem: {
        type: "https://example.test/conflict", title: "Entry changed", status, diagnostic: "Retained conflict detail",
    } } : { status },
    loop_seq: 1, turn_seq: 1, sequence: index + 1,
    attrs: { fanout: { target: "receipt-*.txt", matched: 3, index, count: 3 } },
});

// Real startup/control actions; scripted run-plane frames exercise the installed
// TUI without relying on a model or inducing a daemon storage failure.
const fixture = async (t: TestContext) => {
    const entries: LogEntryWire[] = [];
    const active = Promise.withResolvers<{ response: ServerResponse; threadId: string; runId: string }>();
    const frame = (event: object): string => `data: ${JSON.stringify(event)}\n\n`;
    const authorization = (request: { headers: { authorization?: string } }): Record<string, string> =>
        request.headers.authorization === undefined ? {} : { authorization: request.headers.authorization };
    const relay = createServer((request, response) => {
        void (async () => {
            // {§cli-credential} — discovery and anything that is not a Run reach the daemon untouched.
            if (request.method !== "POST") {
                const result = await fetch(new URL(request.url ?? "/", daemon.url), { headers: authorization(request) });
                response.writeHead(result.status, { "content-type": result.headers.get("content-type") ?? "application/json" });
                response.end(await result.text());
                return;
            }
            let raw = "";
            for await (const chunk of request) raw += chunk;
            const input = JSON.parse(raw);
            const action = input.forwardedProps?.plurnk?.action;
            if (action !== undefined) {
                const result = await fetch(new URL(request.url ?? "/", daemon.url), {
                    method: "POST", headers: { "content-type": "application/json", ...authorization(request) }, body: raw,
                });
                response.writeHead(result.status, { "content-type": result.headers.get("content-type")! });
                response.end(await result.text());
                return;
            }
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(frame({ type: "RUN_STARTED", threadId: input.threadId, runId: input.runId }));
            // plurnk-service {§agui-run-input}: a Run that carries nothing new observes.
            if (input.messages.length === 0 && input.resume === undefined) {
                response.write(frame({ type: "MESSAGES_SNAPSHOT", messages: entries.flatMap((entry) => messagesOf(entry)) }));
            } else {
                active.resolve({ response, threadId: input.threadId, runId: input.runId });
            }
        })().catch((cause) => { active.reject(cause); response.destroy(cause); });
    });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    t.after(() => { relay.closeAllConnections(); return new Promise<void>((resolve) => relay.close(() => resolve())); });
    const address = relay.address();
    assert.ok(address !== null && typeof address === "object");
    const tui = spawnTui(`http://127.0.0.1:${address.port}`, ["--workspace", "fanout", "--worker", "main"], {
        HOME: daemon.home, XDG_CONFIG_HOME: `${daemon.home}/.config`, PLURNK_MODEL: "",
    }, daemon.workspace);
    t.after(() => tui.kill());
    t.after(() => { if (!t.passed) t.diagnostic(stripVTControlCharacters(tui.output())); });
    await tui.waitFor(/plurnk.*\/help/s);
    tui.write("Exercise the group.\r");
    const { response, threadId, runId } = await active.promise;
    return {
        tui,
        emit: (event: object) => { response.write(frame(event)); },
        row: (entry: LogEntryWire) => {
            entries.push(entry);
            for (const event of partsOf(entry)) response.write(frame(event));
        },
        terminal: (status = 499) => {
            response.end(frame({ type: "RUN_FINISHED", threadId, runId, outcome: { type: "success" }, metadata: { plurnk: { terminal: {
                loopId: 1, turnIds: [1], hitMaxTurns: false, result: { status, ...(status === 499 ? { problem: {
                    type: "https://example.test/cancelled", title: "Cancelled", status: 499,
                    detail: "The fixture loop was cancelled.", retryable: false,
                } } : {}) },
            } } } }));
        },
        disconnect: () => { response.end(); },
    };
};

test("{§cli-notice-rendering}: a warning is an adjacent operation-aligned row, not an alert block", { timeout: 60_000 }, async (t) => {
    const f = await fixture(t);
    f.row(receipt("READ", 0));
    f.emit({ type: "CUSTOM", name: "plurnk.notice", value: {
        source: "scheme:file", kind: "path_normalized", level: "warn", message: "Path resolved to 'notes.md'.",
    } });
    f.row({ ...receipt("READ", 1), attrs: {} });
    await f.tui.waitForScreen(/^📖 \(receipt-0\.txt\) *\n⚠️ scheme:file:path_normalized — Path resolved to 'notes\.md'\. *\n📖 \(receipt-1\.txt\) *$/mu);
    f.terminal(200);
    await f.tui.waitFor(/done · 1 turn/);
    f.tui.write("/quit\r");
    assert.equal(await f.tui.exited, 0);
});

for (const [op, glyph] of [["READ", "📖"], ["EDIT", "📝"], ["KILL", "🗑️"]]) {
    test(`{§cli-log-entry-line-format}: live ${op} failure is visible before termination and survives history`, { timeout: 60_000 }, async (t) => {
        const f = await fixture(t);
        f.row(receipt(op, 0));
        f.row(receipt(op, 1, 409));
        await f.tui.waitFor(new RegExp(`${glyph} \\(receipt-1\\.txt\\).*Entry changed: Retained conflict detail`));
        assert.match(stripVTControlCharacters(f.tui.output()), new RegExp(`${glyph} \\(receipt-0\\.txt\\)`));
        f.terminal();
        await f.tui.waitFor(/cancelled/);
        const since = f.tui.output().length;
        f.tui.write("/worker main\r");
        await f.tui.waitFor(/receipt-1\.txt[\s\S]*Retained conflict detail/u, 10_000, since);
        const history = stripVTControlCharacters(f.tui.output().slice(since));
        assert.match(history, new RegExp(`${glyph} \\(receipt-0\\.txt\\)`));
        assert.match(history, new RegExp(`${glyph} \\(receipt-1\\.txt\\).*Entry changed: Retained conflict detail`));
        assert.doesNotMatch(history, /receipt-2\.txt|receipt-\*\.txt/, "unexecuted work is not invented");
        f.tui.write("/quit\r");
        assert.equal(await f.tui.exited, 0);
    });
}

for (const ending of ["turn", "terminal", "disconnect", "quit", "signal"] as const) {
    test(`{§cli-log-entry-line-format}: ${ending} flushes a partial successful group`, { timeout: 60_000 }, async (t) => {
        const f = await fixture(t);
        f.row(receipt("EDIT", 0));
        if (ending === "turn") f.emit({ type: "CUSTOM", name: "plurnk.notice", value: {
            source: "engine:turn", kind: "turn_awaiting_model", level: "info", message: "awaiting model response",
        } });
        else if (ending === "terminal") f.terminal(200);
        else if (ending === "disconnect") f.disconnect();
        else {
            await f.tui.waitForScreen(/EDIT\s+file:\/\/receipt-0\.txt/);
            if (ending === "signal") f.tui.kill("SIGTERM");
            else f.tui.write("/quit\r");
        }
        await f.tui.waitFor(/📝 \(receipt-0\.txt\)/u);
        assert.doesNotMatch(stripVTControlCharacters(f.tui.output()), /📝 \(receipt-\*\.txt\).*\{3\}/u);
        if (ending !== "quit" && ending !== "signal") f.tui.write("/quit\r");
        assert.equal(await f.tui.exited, ending === "signal" ? 143 : 0);
    });
}

test("{§cli-log-entry-line-format}: a complete live group keeps one compact row", { timeout: 60_000 }, async (t) => {
    const f = await fixture(t);
    for (const index of [0, 1, 2]) f.row(receipt("EDIT", index));
    await f.tui.waitFor(/📝 \(receipt-\*\.txt\) \{3\}/u);
    assert.doesNotMatch(stripVTControlCharacters(f.tui.output()), /📝 \(receipt-\d\.txt\)/u);
    f.terminal(200);
    await f.tui.waitFor(/done · 1 turn/);
    f.tui.write("/quit\r");
    assert.equal(await f.tui.exited, 0);
});
