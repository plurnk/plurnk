// Daemon-subprocess harness for integration tests. Boots a plurnk-service
// instance on an ephemeral port with a tmp DB + tmp workspace, returns the
// URL plus a cleanup function. Each test file gets its own daemon (suite-
// level setup/teardown via node:test before/after hooks).
//
// Skip-if-not-found: when the daemon binary isn't reachable we return null
// from locateDaemon(), and each test file's `before()` hook can skip the
// whole suite cleanly. This keeps `npm test` from hard-failing downstream.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, access, writeFile, constants as fsConstants } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Where to look for plurnk-service. Env override wins; otherwise we look at
// the sibling repo on disk. Returns absolute path or null.
export const locateDaemon = async (): Promise<string | null> => {
    const envPath = process.env.PLURNK_SERVICE_BIN;
    if (envPath !== undefined && envPath.length > 0) {
        try { await access(envPath, fsConstants.X_OK); return envPath; } catch { /* fall through */ }
    }
    // The service entrypoint has moved over time: bin/plurnk-service.js →
    // bin/plurnk-service.ts (#183) → src/service.ts (bin: dist/service.js,
    // 2026-06-20). Probe newest-first, keeping the old paths for older checkouts.
    const candidates = [
        "src/service.ts",
        "dist/service.js",
        "bin/plurnk-service.ts",
        "bin/plurnk-service.js",
    ];
    for (const rel of candidates) {
        const sibling = resolve(__dirname, `../../../plurnk-service/${rel}`);
        try { await access(sibling, fsConstants.R_OK); return sibling; } catch { /* not present */ }
    }
    return null;
};

// Where the daemon's .env (with model alias config) lives. Optional; passed
// to node --env-file=... when present.
export const locateDaemonEnv = async (binPath: string): Promise<string | null> => {
    const envFile = resolve(dirname(binPath), "../.env");
    try { await access(envFile, fsConstants.R_OK); return envFile; } catch { return null; }
};

export interface Daemon {
    url: string;
    workspace: string;
    pid: number;
    cleanup: () => Promise<void>;
}

interface BootOptions {
    extraEnv?: Record<string, string>;  // additional env vars (override file-loaded ones)
    readyTimeoutMs?: number;             // default 10s
}

// Boot the daemon and wait until its WS server prints the ready line. Returns
// the resolved URL plus a cleanup function that MUST be awaited (otherwise
// orphan subprocess — see memory:feedback-background-task-cleanup).
export const bootDaemon = async (binPath: string, opts: BootOptions = {}): Promise<Daemon> => {
    const dbPath = (await mkdtemp(join(tmpdir(), "plurnk-intg-db-"))) + "/plurnk.db";
    const workspace = await mkdtemp(join(tmpdir(), "plurnk-intg-ws-"));
    const daemonEnv = await locateDaemonEnv(binPath);
    // The service loads env IN-SCRIPT (process.loadEnvFile OVERRIDES spawn env), so
    // spawn-env pins don't survive; its own --env-file flags, loaded LAST, are the
    // sanctioned override. Also: PLURNK_PORT=0 makes the banner lie (prints the
    // configured 0) — allocate a concrete port so the module is addressable.
    const port = await new Promise<number>((r) => {
        const srv = createServer();
        srv.listen(0, "127.0.0.1", () => { const p = (srv.address() as { port: number }).port; srv.close(() => r(p)); });
    });
    const overrides = [
        `PLURNK_SERVICE_DB_PATH=${dbPath}`,
        `PLURNK_PORT=${port}`,
        "PLURNK_WS_PORT=0",
        `OPENAI_BASE_URL=${process.env.OPENAI_BASE_URL ?? "http://127.0.0.1:11435"}`,
        `PLURNK_EMBED_WORKERS=${process.env.PLURNK_EMBED_WORKERS ?? "2"}`,
        ...Object.entries(opts.extraEnv ?? {}).map(([k, v]) => `${k}=${v}`),
    ].join("\n");
    const overridesPath = join(dirname(dbPath), "test.env");
    await writeFile(overridesPath, `${overrides}\n`);
    const args = [
        binPath,
        ...(daemonEnv !== null ? [`--env-file=${daemonEnv}`] : []),
        `--env-file=${overridesPath}`,
    ];
    const env = process.env as Record<string, string>;

    const child: ChildProcess = spawn("node", args, {
        env,
        // Plugin discovery resolves node_modules/@plurnk/* relative to cwd —
        // run from the service repo so its installed executors register.
        cwd: resolve(dirname(binPath), ".."),
        stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const readyTimeoutMs = opts.readyTimeoutMs ?? 10_000;

    const url = await new Promise<string>((resolveBoot, rejectBoot) => {
        const timeout = setTimeout(() => {
            rejectBoot(new Error(`daemon boot timeout after ${readyTimeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        }, readyTimeoutMs);

        child.stdout?.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
            // AG-UI+ is the client surface — the module's port is the daemon's address.
            const m = stdout.match(/agui=http:\/\/(\d+\.\d+\.\d+\.\d+):(\d+)/);
            if (m !== null) {
                clearTimeout(timeout);
                resolveBoot(`http://${m[1]}:${m[2]}`);
            }
        });
        child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        child.once("exit", (code) => {
            clearTimeout(timeout);
            rejectBoot(new Error(`daemon exited with code ${code} before ready\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        });
        child.once("error", (err) => {
            clearTimeout(timeout);
            rejectBoot(err);
        });
    });

    const cleanup = async (): Promise<void> => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGTERM");
            await new Promise<void>((r) => {
                const done = (): void => r();
                if (child.exitCode !== null || child.signalCode !== null) { done(); return; }
                child.once("exit", done);
                // Hard timeout — if SIGTERM doesn't take, escalate
                setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already dead */ } done(); }, 2000);
            });
        }
        await rm(dirname(dbPath), { recursive: true, force: true });
        await rm(workspace, { recursive: true, force: true });
    };

    return { url, workspace, pid: child.pid ?? -1, cleanup };
};
