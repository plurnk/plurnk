import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import Lifetime from "./lifetime.ts";

class FakeProcess extends EventEmitter {
    readonly exits: number[] = [];
    exit(code: number): never { this.exits.push(code); return undefined as never; }
}

test("[§cli-daemon-autostart] shutdown awaits pending acquisition and disposes the backend once", async () => {
    const proc = new FakeProcess() as FakeProcess & Pick<NodeJS.Process, "on" | "off" | "exit">;
    const lifetime = new Lifetime(proc);
    const startup = Promise.withResolvers<AsyncDisposable>();
    let stops = 0;
    const admitted = lifetime.own(startup.promise);
    const rejected = assert.rejects(admitted, { name: "AbortError" });
    proc.emit("SIGTERM");
    assert.deepEqual(proc.exits, [], "startup must finish and its child stop before exit");
    startup.resolve({ async [Symbol.asyncDispose]() { stops++; } });
    await rejected;
    await lifetime.close();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(stops, 1);
    assert.deepEqual(proc.exits, [143]);
    assert.deepEqual(proc.eventNames(), [], "the invocation removes its own signal handlers");
});

test("[§cli-daemon-autostart] a failed acquisition is still reported to its caller", async () => {
    await using lifetime = new Lifetime();
    const cause = new Error("service readiness failed");
    await assert.rejects(lifetime.own(Promise.reject(cause)), (error) => error === cause);
    await lifetime.close();
});

test("[§cli-daemon-autostart] cleanup failure remains visible", async () => {
    const lifetime = new Lifetime();
    const cause = new Error("shutdown failed");
    await lifetime.own(Promise.resolve({ async [Symbol.asyncDispose]() { throw cause; } }));
    await assert.rejects(lifetime.close(), (error) => error === cause);
});

test("[§cli-mcp-oauth-callback] invocation shutdown cancels interactive work before draining resources", async () => {
    await using lifetime = new Lifetime();
    let cancelled = 0;
    lifetime.signal.addEventListener("abort", () => { cancelled++; });
    await lifetime.own(Promise.resolve({
        async [Symbol.asyncDispose]() { assert.equal(lifetime.signal.aborted, true); },
    }));
    await lifetime.close();
    await lifetime.close();
    assert.equal(cancelled, 1);
});
