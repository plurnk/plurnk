import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import TerminalGuards from "./tui-guards.ts";

class FakeProcess extends EventEmitter {
    readonly exits: number[] = [];
    exit(code: number): never { this.exits.push(code); return undefined as never; }
}
const fake = () => new FakeProcess() as unknown as FakeProcess & Pick<NodeJS.Process, "once" | "off" | "exit">;

test("a signal stops the surface before the process exits with the conventional status", () => {
    for (const [signal, status] of [["SIGTERM", 143], ["SIGHUP", 129]] as const) {
        const proc = fake();
        const stops: string[] = [];
        TerminalGuards.install({ stop: () => stops.push(signal) }, proc);
        proc.emit(signal);
        assert.deepEqual(stops, [signal], `${signal} restored the terminal`);
        assert.deepEqual(proc.exits, [status], `${signal} exit status`);
    }
});

test("an escaped throw or an uncaught rejection stops the surface, reports, and exits 1", () => {
    const original = console.error;
    const reported: unknown[] = [];
    console.error = (...args: unknown[]) => { reported.push(args[0]); };
    try {
        for (const event of ["uncaughtException", "unhandledRejection"] as const) {
            const proc = fake();
            let stopped = 0;
            TerminalGuards.install({ stop: () => { stopped += 1; } }, proc);
            proc.emit(event, new Error(event));
            assert.equal(stopped, 1, event);
            assert.deepEqual(proc.exits, [1], event);
        }
    } finally { console.error = original; }
    assert.equal(reported.length, 2, "both fatal paths report the error");
});

test("release detaches every guard", () => {
    const proc = fake();
    const release = TerminalGuards.install({ stop: () => assert.fail("released guards must not fire") }, proc);
    release();
    assert.equal(proc.listenerCount("SIGTERM") + proc.listenerCount("SIGHUP") + proc.listenerCount("uncaughtException") + proc.listenerCount("unhandledRejection"), 0);
});
