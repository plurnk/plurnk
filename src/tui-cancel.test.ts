import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import CancelGesture from "./tui-cancel.ts";

interface Recorder {
    gesture: CancelGesture;
    reasons: string[];
    lines: string[];
    closes: number;
}

// A gesture wired to a loop.cancel that rejects with `failure` (or resolves when undefined).
const wire = (failure?: unknown): Recorder => {
    const reasons: string[] = [];
    const lines: string[] = [];
    const rec = { reasons, lines, closes: 0 } as Recorder;
    rec.gesture = new CancelGesture({
        cancel: async (reason) => {
            reasons.push(reason);
            if (failure !== undefined) throw failure;
            return { cancelled: true };
        },
        print: (line) => { lines.push(line); },
        close: () => { rec.closes += 1; },
    });
    return rec;
};

for (const noColor of ["", "1"]) {
    test(`[§cli-cancellation] the first interrupt cancels once and arms the exit (NO_COLOR=${JSON.stringify(noColor)})`, async (t) => {
        const saved = process.env.NO_COLOR;
        process.env.NO_COLOR = noColor;
        t.after(() => {
            if (saved === undefined) delete process.env.NO_COLOR;
            else process.env.NO_COLOR = saved;
        });
        const rec = wire();
        const { gesture, reasons, lines } = rec;
        assert.equal(gesture.requested, false);
        gesture.request("user_sigint");
        gesture.request("user_escape");
        await tick();
        assert.deepEqual(reasons, ["user_sigint"], "the armed latch swallows the second gesture's cancel");
        assert.deepEqual(lines, [noColor ? "  cancelling… (ctrl-c again to quit)" : "  \x1b[2mcancelling… (ctrl-c again to quit)\x1b[0m"]);
        assert.equal(gesture.requested, true, "the next Ctrl-C exits");
        assert.equal(rec.closes, 0, "a cancel that reached the daemon does not close the client");
    });
}

test("[§cli-cancellation] a cancel that never reached the daemon closes the client, naming what it could not deliver (#90)", async () => {
    const rec = wire(new TypeError("fetch failed"));
    rec.gesture.request("user_sigint");
    await tick();
    assert.equal(rec.closes, 1, "an undeliverable cancel tears the client down locally");
    assert.match(rec.lines.at(-1) as string, /cancel not delivered: the daemon is unreachable \(fetch failed\) — closing this client/);
    assert.equal(rec.gesture.requested, true, "the failure never re-arms the latch: the next Ctrl-C exits, it does not re-cancel");
});

for (const noColor of ["", "1"]) {
    test(`[§cli-cancellation] a refused cancel surfaces the daemon's answer and leaves the exit armed (NO_COLOR=${JSON.stringify(noColor)})`, async (t) => {
        const saved = process.env.NO_COLOR;
        process.env.NO_COLOR = noColor;
        t.after(() => {
            if (saved === undefined) delete process.env.NO_COLOR;
            else process.env.NO_COLOR = saved;
        });
        const rec = wire(new Error("loop 7 is not cancellable"));
        rec.gesture.request("user_stop");
        await tick();
        assert.equal(rec.closes, 0, "the daemon answered — the session continues");
        assert.equal(rec.lines.at(-1), noColor ? "  cancel failed: loop 7 is not cancellable" : "  \x1b[31mcancel failed: loop 7 is not cancellable\x1b[0m");
        assert.equal(rec.gesture.requested, true, "the next Ctrl-C exits, it does not fire a second doomed cancel");
    });
}

test("[§cli-cancellation] the run's end releases the latch for the next run's first interrupt", async () => {
    const rec = wire(new TypeError("fetch failed"));
    rec.gesture.request("user_sigint");
    await tick();
    rec.gesture.release();
    assert.equal(rec.gesture.requested, false);
    rec.gesture.request("user_escape");
    await tick();
    assert.deepEqual(rec.reasons, ["user_sigint", "user_escape"]);
});
