import assert from "node:assert/strict";
import { access, constants as fsConstants, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import pty from "node-pty";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..");
const binPath = join(repoRoot, "bin", "plurnk.js");
const liveEnabled = process.env.PLURNK_CLIENT_LIVE === "1";

const locateServiceEntry = async (): Promise<string> => {
    const checkout = resolve(repoRoot, process.env.PLURNK_SERVICE_CHECKOUT ?? "../plurnk-service");
    const entry = join(checkout, "plurnk-core", "src", "service.ts");
    await access(entry, fsConstants.R_OK);
    return await realpath(entry);
};

test(
    "[{§cli-tui-flow}] interactive TUI live session completes a real-model prompt over ACP v2",
    {
        timeout: 600_000,
        skip: liveEnabled ? false : "real-model tier requires npm run test:tui:live",
    },
    async () => {
        const liveModel = process.env.PLURNK_MODEL;
        assert.ok(liveModel && liveModel.length > 0, "test:tui:live requires an explicit PLURNK_MODEL selector");

        const entry = await locateServiceEntry();
        const serviceRequire = createRequire(entry);
        const { default: Launch } = (await import(
            pathToFileURL(serviceRequire.resolve("@plurnk/plurnk-service/launch")).href
        )) as {
            default: {
                start: (opts: {
                    command: string[];
                    cwd: string;
                    stateRoot?: string;
                    host?: string;
                    port?: number;
                    env: NodeJS.ProcessEnv;
                    readyTimeoutMs: number;
                    stopGraceMs: number;
                }) => Promise<{
                    url: string;
                    port: number;
                    stdout: () => string;
                    stderr: () => string;
                    stop: () => Promise<void>;
                }>;
            };
        };

        const sandbox = await mkdtemp(join(tmpdir(), "plurnk-tui-live-"));
        const home = join(sandbox, "home");
        await mkdir(home, { recursive: true });

        let daemon:
            | {
                  url: string;
                  port: number;
                  stdout: () => string;
                  stderr: () => string;
                  stop: () => Promise<void>;
              }
            | undefined;
        let term: pty.IPty | undefined;
        try {
            daemon = await Launch.start({
                command: [process.execPath, "--conditions=plurnk-dev", entry],
                cwd: resolve(dirname(entry), ".."),
                stateRoot: sandbox,
                host: "127.0.0.1",
                port: 0,
                env: {
                    ...process.env,
                    PLURNK_SERVICE_DB_PATH: "",
                    PLURNK_AUTH: "0",
                    PLURNK_MODEL: liveModel,
                },
                readyTimeoutMs: 30_000,
                stopGraceMs: 5_000,
            });

            let output = "";
            const waiters: Array<{ pattern: RegExp; resolveWait: (text: string) => void; timer: NodeJS.Timeout }> = [];
            term = pty.spawn(
                process.execPath,
                [
                    binPath,
                    "--autostart",
                    "0",
                    "--yolo",
                    "--workspace",
                    "live-client-tui",
                    "--session",
                    "live-user",
                    "--project-root",
                    "",
                ],
                {
                    name: "xterm-256color",
                    cols: 100,
                    rows: 30,
                    cwd: repoRoot,
                    env: Object.fromEntries(
                        Object.entries({
                            ...process.env,
                            HOME: home,
                            XDG_CONFIG_HOME: join(home, ".config"),
                            XDG_DATA_HOME: join(home, ".local", "share"),
                            XDG_STATE_HOME: join(home, ".local", "state"),
                            PLURNK_HOST: new URL(daemon.url).hostname,
                            PLURNK_PORT: new URL(daemon.url).port,
                            PLURNK_ACP_URL: "",
                            NO_COLOR: "1",
                        }).filter(([, value]) => value !== undefined),
                    ) as Record<string, string>,
                },
            );

            term.onData((chunk) => {
                output += chunk;
                for (let i = waiters.length - 1; i >= 0; i -= 1) {
                    if (waiters[i]!.pattern.test(output)) {
                        clearTimeout(waiters[i]!.timer);
                        waiters[i]!.resolveWait(output);
                        waiters.splice(i, 1);
                    }
                }
            });

            const waitFor = (pattern: RegExp, timeoutMs = 120_000): Promise<string> =>
                new Promise((resolveWait, rejectWait) => {
                    if (pattern.test(output)) {
                        resolveWait(output);
                        return;
                    }
                    const timer = setTimeout(() => {
                        rejectWait(
                            new Error(
                                `waitFor ${String(pattern)} timed out:\n${output.slice(-2_000)}\ndaemon stderr:\n${daemon?.stderr() ?? ""}`,
                            ),
                        );
                    }, timeoutMs);
                    waiters.push({ pattern, resolveWait, timer });
                });

            await waitFor(/workspace: live-client-tui/u, 30_000);
            term.write("Reply with the single word Pong and nothing else.\r");
            await waitFor(/Pong/iu, 180_000);
            await waitFor(/⏹️/u, 60_000);
            term.write("/quit\r");
        } finally {
            try {
                term?.kill();
            } catch {
                // already exited
            }
            await daemon?.stop();
            await rm(sandbox, { recursive: true, force: true });
        }
    },
);
