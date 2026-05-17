// plurnk client entrypoint. Dispatches to one-shot CLI mode (positional args)
// or TUI REPL mode (no positionals). Per TUI.md §2 and §3.

import { parseArgs } from "node:util";
import Rpc from "./rpc.ts";
import { runOneShot } from "./oneshot.ts";
import { runTui } from "./tui.ts";

const USAGE = `usage: plurnk [prompt...]

Connects to the plurnk-service daemon. Run a single prompt one-shot
(positional args) or enter the interactive REPL (no args).

env:
  PLURNK_URL   daemon WebSocket URL (default ws://127.0.0.1:3044)

options:
  -h, --help   print this message and exit
`;

const die = (code: number, message: string): never => {
    process.stderr.write(`${message}\n`);
    process.exit(code);
};

export const main = async (argv: string[]): Promise<void> => {
    try { process.loadEnvFile(".env"); } catch { /* .env is optional */ }

    const { positionals, values } = parseArgs({
        args: argv.slice(2),
        allowPositionals: true,
        options: { help: { type: "boolean", short: "h" } },
    });

    if (values.help) { process.stdout.write(USAGE); process.exit(0); }

    const url = process.env.PLURNK_URL ?? "ws://127.0.0.1:3044";
    const rpc = new Rpc({ url });

    try {
        await rpc.connect();
    } catch (cause) {
        die(1, `plurnk: cannot connect to daemon at ${url}\n  ${cause instanceof Error ? cause.message : String(cause)}\n\nIs the daemon running? Start it from plurnk-service with:\n  node bin/plurnk-service.js start`);
    }

    try {
        if (positionals.length === 0) {
            await runTui(rpc);
            process.exit(0);
        }
        const prompt = positionals.join(" ");
        const exitCode = await runOneShot(rpc, prompt);
        process.exit(exitCode);
    } catch (cause) {
        process.stderr.write(`plurnk: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        if (cause instanceof Error && cause.cause !== undefined) {
            process.stderr.write(`  cause: ${cause.cause instanceof Error ? cause.cause.message : String(cause.cause)}\n`);
        }
        process.exit(1);
    } finally {
        await rpc.close();
    }
};
