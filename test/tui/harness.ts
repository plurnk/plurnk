// PTY harness for driving the interactive TUI in tests. node-pty gives the
// client a real terminal (isTTY → TUI mode), so we can send keystrokes and
// assert on the rendered waterfall — the coverage that was HITL-only before.
//
// Daemon-gated like the intg suite: reuses bootDaemon. A spec's before() hook
// skips cleanly when the service binary isn't reachable (locateDaemon → null).

import pty from "node-pty";
import headless, { type Terminal } from "@xterm/headless";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const BIN = resolve(__dirname, "../../bin/plurnk.js");

export interface Tui {
    // Send raw bytes (use "\r" for Enter, "\x1b…" for control sequences).
    write: (data: string) => void;
    // Resolve once the cumulative output matches; reject on timeout (dumping
    // the tail so a failure is legible).
    waitFor: (pattern: RegExp, timeoutMs?: number, since?: number) => Promise<string>;
    // Match the current viewport, including unchanged rows omitted from redraws.
    waitForScreen: (pattern: RegExp, timeoutMs?: number) => Promise<string>;
    output: () => string;
    kill: (signal?: string) => void;
    exited: Promise<number>;
}

interface Waiter { re: RegExp; read: () => string; resolve: (s: string) => void; timer: ReturnType<typeof setTimeout> }

export const screenText = (terminal: Terminal): string => {
    const buffer = terminal.buffer.active;
    return Array.from({ length: terminal.rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "").join("\n");
};

// Spawn `node bin/plurnk.js <args>` in a 100×30 pty against the given daemon URL.
export const spawnTui = (url: string, args: string[] = [], extraEnv: NodeJS.ProcessEnv = {}, cwd: string = process.cwd()): Tui => {
    const term = pty.spawn("node", [BIN, ...args], {
        name: "xterm-256color",
        cols: 100,
        rows: 30,
        cwd,   // the client sends cwd as the workspace's project_root (membership + edits resolve here)
        // `url` is the daemon module's http address (bootDaemon returns it) — the
        // client reads PLURNK_HOST/PLURNK_PORT, ACP+ underneath.
        // pi-tui stretches its lone-ESC window to 100 ms when it sees SSH_CONNECTION/SSH_TTY — a
        // developer's own session, not the pty under test — which swallows an Esc typed 80 ms before
        // the next key (plurnk#25). Pin the window so the harness is deterministic anywhere.
        // node-pty stringifies undefined, so omit explicit unsets from its environment.
        env: Object.fromEntries(Object.entries({
            ...process.env, PI_TUI_ESC_TIMEOUT: "10", PLURNK_HOST: new URL(url).hostname,
            PLURNK_PORT: new URL(url).port, PLURNK_ACP_URL: "", NO_COLOR: "1", ...extraEnv,
        }).filter(([, value]) => value !== undefined)),
    });

    let buf = "";
    const screen = new headless.Terminal({ cols: 100, rows: 30, allowProposedApi: true });
    const waiters: Waiter[] = [];
    const observe = () => {
        for (let i = waiters.length - 1; i >= 0; i--) {
            const value = waiters[i].read();
            if (waiters[i].re.test(value)) {
                clearTimeout(waiters[i].timer);
                waiters[i].resolve(value);
                waiters.splice(i, 1);
            }
        }
    };
    term.onData((d) => {
        buf += d;
        observe();
        screen.write(d, observe);
    });
    const waitFor = (re: RegExp, timeoutMs: number, read: () => string): Promise<string> => new Promise((resolve, reject) => {
        const value = read();
        if (re.test(value)) { resolve(value); return; }
        const waiter: Waiter = {
            re, read, resolve,
            timer: setTimeout(() => {
                waiters.splice(waiters.indexOf(waiter), 1);
                reject(new Error(`waitFor ${re} timed out after ${timeoutMs}ms.\n── tail ──\n${read().slice(-2000)}`));
            }, timeoutMs),
        };
        waiters.push(waiter);
    });

    let exitCode = -1;
    const exited = new Promise<number>((res) => term.onExit(({ exitCode: c }) => {
        exitCode = c;
        screen.write("", () => { screen.dispose(); res(c); });
    }));

    return {
        write: (data) => term.write(data),
        waitFor: (re, timeoutMs = 10_000, since = 0) => waitFor(re, timeoutMs, () => buf.slice(since)).then(() => buf),
        waitForScreen: (re, timeoutMs = 10_000) => waitFor(re, timeoutMs, () => screenText(screen)),
        output: () => buf,
        kill: (signal) => { try { term.kill(signal); } catch { /* already gone */ } },
        exited: exited.then(() => exitCode),
    };
};
