import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootDaemon, locateDaemon } from "./harness.ts";

for (const mode of ["ready", "exit", "timeout"] as const) {
    test(`[§cli-test-daemon-lifecycle] ${mode}: owned process exits before temporary state is removed`, { timeout: 15_000 }, async (t) => {
        const service = await locateDaemon();
        assert.ok(service, "the client lifecycle test requires the service launcher");
        const directory = await mkdtemp(join(tmpdir(), "plurnk-launch-witness-"));
        const witness = join(directory, "witness.json");
        let state: { pid: number; root: string; home: string; model: string } | undefined;
        t.after(async () => {
            if (state !== undefined) {
                try { process.kill(state.pid, "SIGTERM"); }
                catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause; }
                await rm(state.root, { recursive: true, force: true });
            }
            await rm(directory, { recursive: true, force: true });
        });
        const entry = join(directory, "service.mjs");
        await copyFile(new URL("./fixtures/launch-daemon.mjs", import.meta.url), entry);
        await writeFile(join(directory, "package.json"), JSON.stringify({
            name: "@plurnk/plurnk-service", type: "module", exports: { "./launch": "./Launch.js" },
        }));
        await symlink(createRequire(service).resolve("@plurnk/plurnk-service/launch"), join(directory, "Launch.js"));
        const started = bootDaemon(entry, {
            readyTimeoutMs: 1_000,
            extraEnv: { LAUNCH_CASE: mode, LAUNCH_WITNESS: witness },
        });
        if (mode === "ready") {
            const daemon = await started;
            t.after(daemon.cleanup);
            state = JSON.parse(await readFile(witness, "utf8"));
            assert.equal(daemon.url, "http://127.0.0.1:43210/agui");
            assert.equal(state?.model, "", "the deterministic fixture cannot inherit an operator model");
            assert.equal(state?.home, daemon.home);
            await daemon.cleanup();
            assert.equal(existsSync(daemon.workspace), false);
        } else {
            await assert.rejects(started, (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, mode === "exit" ? /launch fixture admission refused/ : /timeout|readiness/i);
                assert.ok(error.cause instanceof Error);
                assert.equal(error.cause.name, "LaunchError", "the service's structured failure survives wrapping");
                assert.ok("kind" in error.cause);
                assert.equal(error.cause.kind, mode === "exit" ? "exited" : "timeout");
                return true;
            });
            state = JSON.parse(await readFile(witness, "utf8"));
        }
        assert.ok(state);
        assert.throws(() => process.kill(state!.pid, 0), { code: "ESRCH" }, "settled startup/shutdown cannot leave an owned process alive");
        assert.equal(existsSync(state.root), false, "the caller removes only its disposable state after the process exits");
        if (mode !== "exit") {
            assert.deepEqual(JSON.parse(await readFile(`${witness}.stopped`, "utf8")), { rootExists: true },
                "the daemon still has its state throughout managed shutdown");
        }
    });
}
