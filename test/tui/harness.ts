// PTY harness for driving the interactive TUI in tests. node-pty gives the
// client a real terminal (isTTY → TUI mode), so we can send keystrokes and
// assert on the rendered waterfall — the coverage that was HITL-only before.
//
// Daemon-gated like the intg suite: reuses bootDaemon. A spec's before() hook
// skips cleanly when the service binary isn't reachable (locateDaemon → null).

import pty from "node-pty";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BIN = resolve(__dirname, "../../bin/plurnk.js");

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
export const spawnTui = (url: string, args: string[] = [], extraEnv: Record<string, string> = {}): Tui => {
    const term = pty.spawn("node", [BIN, ...args], {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd: process.cwd(),
        env: { ...(process.env as Record<string, string>), PLURNK_URL: url, NO_COLOR: "1", ...extraEnv },
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
