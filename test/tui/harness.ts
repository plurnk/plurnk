// PTY harness for driving the interactive TUI in tests. node-pty gives the
// client a real terminal (isTTY → TUI mode), so we can send keystrokes and
// assert on the rendered waterfall — the coverage that was HITL-only before.
//
// Daemon-gated like the intg suite: reuses bootDaemon. A spec's before() hook
// skips cleanly when the service binary isn't reachable (locateDaemon → null).

import pty from "node-pty";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BIN = resolve(__dirname, "../../bin/plurnk.js");

// The plurnk-agui bridge serve entrypoint — a sibling checkout. Used to drive
// TUI-OVER-BRIDGE pty tests (plurnk-agui#1 Phase C): boot a daemon, boot the
// bridge at it, then spawnTui(daemon.url, [], { PLURNK_AGUI_URL: bridge.url }).
const BRIDGE_SERVE = resolve(__dirname, "../../../plurnk-agui/src/bin/serve.ts");

// Boot the bridge against `daemonUrl`; resolve its base URL from the serve banner.
// null when the sibling checkout is absent (the bridge suite skips, like the
// daemon gate). The caller kills it in after().
export const bootBridge = (daemonUrl: string): Promise<{ url: string; kill: () => void } | null> => {
    if (!existsSync(BRIDGE_SERVE)) return Promise.resolve(null);
    return new Promise((res, rej) => {
        const proc = spawn("node", [BRIDGE_SERVE], {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                ...(process.env as Record<string, string>),
                PLURNK_AGUI_DAEMON_URL: daemonUrl,
                PLURNK_AGUI_HOST: "127.0.0.1",
                PLURNK_AGUI_PORT: "0",   // ephemeral — the banner carries the real port
                PLURNK_AGUI_TOKEN: "",
                PLURNK_AGUI_SESSION_PREFIX: "agui",
                PLURNK_AGUI_MAX_TURNS: "24",
                PLURNK_AGUI_QUESTIONS: "0",
                PLURNK_AGUI_YOLO: "0",
            },
        });
        let out = "";
        let err = "";
        const timer = setTimeout(() => { proc.kill("SIGINT"); rej(new Error(`bridge boot timeout; stdout: ${out} stderr: ${err}`)); }, 10_000);
        proc.stderr?.on("data", (c: Buffer) => { err += c.toString("utf8"); });
        proc.stdout?.on("data", (c: Buffer) => {
            out += c.toString("utf8");
            const m = out.match(/http:\/\/127\.0\.0\.1:\d+/);
            if (m !== null) { clearTimeout(timer); res({ url: m[0], kill: () => { try { proc.kill("SIGINT"); } catch { /* gone */ } } }); }
        });
        proc.once("error", (e) => { clearTimeout(timer); rej(e); });
        proc.once("exit", (c) => { clearTimeout(timer); rej(new Error(`bridge exited ${c} before serving; stderr: ${err}`)); });
    });
};

export interface Tui {
    // Send raw bytes (use "\r" for Enter, "\x1b…" for control sequences).
    write: (data: string) => void;
    // Resolve once the cumulative output matches; reject on timeout (dumping
    // the tail so a failure is legible).
    waitFor: (pattern: RegExp, timeoutMs?: number) => Promise<string>;
    output: () => string;
    kill: () => void;
    exited: Promise<number>;
}

interface Waiter { re: RegExp; resolve: (s: string) => void; timer: ReturnType<typeof setTimeout> }

// Spawn `node bin/plurnk.js <args>` in a 100×30 pty against the given daemon URL.
export const spawnTui = (url: string, args: string[] = [], extraEnv: Record<string, string> = {}, cwd: string = process.cwd()): Tui => {
    const term = pty.spawn("node", [BIN, ...args], {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd,   // the client sends cwd as the session's project_root (membership + edits resolve here)
        env: { ...(process.env as Record<string, string>), PLURNK_WS: url, NO_COLOR: "1", ...extraEnv },
    });

    let buf = "";
    const waiters: Waiter[] = [];
    term.onData((d) => {
        buf += d;
        for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].re.test(buf)) {
                clearTimeout(waiters[i].timer);
                waiters[i].resolve(buf);
                waiters.splice(i, 1);
            }
        }
    });

    let exitCode = -1;
    const exited = new Promise<number>((res) => term.onExit(({ exitCode: c }) => { exitCode = c; res(c); }));

    return {
        write: (data) => term.write(data),
        waitFor: (re, timeoutMs = 10_000) => new Promise((res, rej) => {
            if (re.test(buf)) { res(buf); return; }
            const timer = setTimeout(
                () => rej(new Error(`waitFor ${re} timed out after ${timeoutMs}ms.\n── tail ──\n${buf.slice(-600)}`)),
                timeoutMs,
            );
            waiters.push({ re, resolve: res, timer });
        }),
        output: () => buf,
        kill: () => { try { term.kill(); } catch { /* already gone */ } },
        exited: exited.then(() => exitCode),
    };
};
