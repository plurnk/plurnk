import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import TerminalGuards from "./tui-guards.ts";
import Lifetime from "./lifetime.ts";

class FakeProcess extends EventEmitter {
    readonly exits: number[] = [];
    exit(code: number): never { this.exits.push(code); return undefined as never; }
}
const fake = () => new FakeProcess() as unknown as FakeProcess & Pick<NodeJS.Process, "on" | "once" | "off" | "exit">;

test("a signal restores the terminal immediately, then stops owned resources before exit", async () => {
    for (const [signal, status] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
        const proc = fake();
        await using lifetime = new Lifetime(proc);
        const cleanup = Promise.withResolvers<void>();
        await lifetime.own(Promise.resolve({ [Symbol.asyncDispose]: () => cleanup.promise }));
        const stops: string[] = [];
        const release = TerminalGuards.install({ stop: () => stops.push(signal) }, lifetime, proc);
        proc.emit(signal);
        assert.deepEqual(stops, [signal], `${signal} restored the terminal`);
        assert.deepEqual(proc.exits, [], "exit waits for backend shutdown");
        cleanup.resolve();
        await lifetime.close();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(proc.exits, [status], `${signal} exit status`);
        release();
    }
});

test("an escaped throw or an uncaught rejection stops the surface, reports, and exits 1", async () => {
    const original = console.error;
    const reported: unknown[] = [];
    console.error = (...args: unknown[]) => { reported.push(args[0]); };
    try {
        for (const event of ["uncaughtException", "unhandledRejection"] as const) {
            const proc = fake();
            await using lifetime = new Lifetime(proc);
            let stopped = 0;
            const release = TerminalGuards.install({ stop: () => { stopped += 1; } }, lifetime, proc);
            proc.emit(event, new Error(event));
            assert.equal(stopped, 1, event);
            await lifetime.close();
            await new Promise<void>((resolve) => setImmediate(resolve));
            assert.deepEqual(proc.exits, [1], event);
            release();
        }
    } finally { console.error = original; }
    assert.equal(reported.length, 2, "both fatal paths report the error");
});

test("release detaches every guard", async () => {
    const proc = fake();
    await using lifetime = new Lifetime(proc);
    const release = TerminalGuards.install({ stop: () => assert.fail("released guards must not fire") }, lifetime, proc);
    release();
    await lifetime.close();
    assert.equal(proc.listenerCount("SIGTERM") + proc.listenerCount("SIGHUP") + proc.listenerCount("uncaughtException") + proc.listenerCount("unhandledRejection"), 0);
});
