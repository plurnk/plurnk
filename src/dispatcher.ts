// plurnk client entrypoint. Dispatches argv to CLI mode (positional args or
// piped stdin) or TUI REPL mode (no positionals, TTY stdin). Per SPEC.md
// §2 (CLI mode) and §3 (TUI mode).

import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import Rpc from "./rpc.ts";
import { runCli } from "./cli.ts";
import { runTui } from "./tui.ts";

// Read all of stdin to EOF. Called when stdin is piped (not a TTY) — never
// blocks an interactive session because we gate on isTTY upstream.
const readStdin = async (): Promise<string> => {
    let buf = "";
    for await (const chunk of process.stdin) buf += chunk;
    return buf;
};

// Persona resolution: the flag/env value is a path to a markdown file.
// Personas are typically long; quoting multiline markdown on the command
// line is hostile. Path-only keeps the contract obvious.
export const resolvePersona = async (raw: string | undefined): Promise<string | undefined> => {
    if (raw === undefined) return undefined;
    const abs = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
    return await readFile(abs, "utf8");
};

// projectRoot resolution: empty string = explicit headless (null on wire);
// otherwise must be an absolute path. Caller passes cwd as default.
export const resolveProjectRoot = (raw: string | undefined): string | null => {
    if (raw === undefined) return process.cwd();
    if (raw.length === 0) return null;
    if (!isAbsolute(raw)) throw new Error(`plurnk: --project-root must be an absolute path (got ${JSON.stringify(raw)})`);
    return raw;
};

const USAGE = `usage: plurnk [--json] [--session <name>] [--run <name>] [--model <alias>] [prompt...]
       <piped stdin> | plurnk [options] [prompt...]

Connects to the plurnk-service daemon. Run a single prompt one-shot
(positional args, piped stdin, or both — positionals come first, stdin
is appended after a blank line). With no positionals and a TTY stdin,
enters the interactive REPL.

env:
  PLURNK_URL            daemon WebSocket URL (default ws://127.0.0.1:3044)
  PLURNK_SESSION        resume an existing session by name
  PLURNK_RUN            resume (or create) a named run within that session
  PLURNK_MODEL          model alias to use for every loop.run on this invocation.
                        Shared with the daemon (user-level preference). --model
                        overrides for this invocation only.
  PLURNK_PROJECT_ROOT   absolute path passed to session.create as the session's
                        project_root (workspace for file ops). Default: cwd.
                        Empty string = headless (no project_root, file ops 400).
  PLURNK_PERSONA        path to a persona file (text/markdown); contents are
                        passed on every loop.run.
  PLURNK_YOLO           when truthy, auto-accept every proposal without prompting.
                        Client-side only — proposals still go through the wire.

options:
  -h, --help              print this message and exit
      --json              emit the terminal answer as a JSON value on stdout
                          (compact, validated; non-JSON replies are wrapped as
                          JSON string literals). CLI mode only.
      --session <name>    resume the named session; without it, a fresh session
                          is created. Overrides PLURNK_SESSION.
      --run <name>        resume (or create) the named run within the session.
                          Requires --session. Overrides PLURNK_RUN.
      --model <alias>     model alias to pass on every loop.run. Resolved
                          server-side against PLURNK_MODEL_<alias>. Without
                          this (and PLURNK_MODEL unset), the daemon uses its
                          own boot-time PLURNK_MODEL.
      --project-root <p>  absolute path. Sent on session.create only; ignored
                          on --session attach (daemon preserves stored value).
                          Default: cwd. Empty string = headless. Overrides
                          PLURNK_PROJECT_ROOT.
      --persona <path>    path to a persona file (text/markdown); contents are
                          passed on every loop.run. Overrides PLURNK_PERSONA.
      --yolo              auto-accept every proposal locally without prompting.
                          Overrides PLURNK_YOLO.
`;

const die = (code: number, message: string): never => {
    process.stderr.write(`${message}\n`);
    process.exit(code);
};

interface SessionResult { id: number; name: string }

// Resolve the session by name (via session.list filter) or create a fresh one.
// Names are the user-facing handle — ids are internals, not exposed via flags.
// projectRoot is sent on creation only; attach inherits the daemon-stored value.
const attachOrCreateSession = async (
    rpc: Rpc,
    opts: { sessionName?: string; runName?: string; projectRoot: string | null },
): Promise<SessionResult> => {
    if (opts.sessionName === undefined) {
        return await rpc.call("session.create", { projectRoot: opts.projectRoot }) as SessionResult;
    }
    const { sessions } = await rpc.call("session.list") as { sessions: SessionResult[] };
    const matches = sessions.filter((s) => s.name === opts.sessionName);
    if (matches.length === 0) {
        throw new Error(`no session named ${JSON.stringify(opts.sessionName)}; run without --session to create one`);
    }
    if (matches.length > 1) {
        throw new Error(`${matches.length} sessions named ${JSON.stringify(opts.sessionName)}; pick a unique name`);
    }
    const attachParams: { id: number; runName?: string } = { id: matches[0].id };
    if (opts.runName !== undefined) attachParams.runName = opts.runName;
    return await rpc.call("session.attach", attachParams) as SessionResult;
};

export const main = async (argv: string[]): Promise<void> => {
    try { process.loadEnvFile(".env"); } catch { /* .env is optional */ }

    const { positionals, values } = parseArgs({
        args: argv.slice(2),
        allowPositionals: true,
        options: {
            help: { type: "boolean", short: "h" },
            json: { type: "boolean" },
            session: { type: "string" },
            run: { type: "string" },
            model: { type: "string" },
            "project-root": { type: "string" },
            persona: { type: "string" },
            yolo: { type: "boolean" },
        },
    });

    if (values.help) { process.stdout.write(USAGE); process.exit(0); }

    // Assemble the prompt: positionals first, then piped stdin (if any),
    // separated by a blank line. Either source alone is fine; neither
    // present + TTY stdin → TUI mode. The --json flag requires a prompt.
    const positionalPrompt = positionals.join(" ");
    const stdinPrompt = process.stdin.isTTY === true ? "" : (await readStdin()).trim();
    const prompt = positionalPrompt.length > 0 && stdinPrompt.length > 0
        ? `${positionalPrompt}\n\n${stdinPrompt}`
        : positionalPrompt || stdinPrompt;

    if (values.json === true && prompt.length === 0) {
        die(64, "plurnk: --json requires a prompt (CLI mode only)");
    }

    // CLI flag overrides env; env overrides nothing.
    const sessionName = values.session ?? process.env.PLURNK_SESSION;
    const runName = values.run ?? process.env.PLURNK_RUN;
    const modelAlias = values.model ?? process.env.PLURNK_MODEL;
    const yolo = values.yolo === true || ["1", "true", "yes", "on"].includes((process.env.PLURNK_YOLO ?? "").toLowerCase());
    if (runName !== undefined && sessionName === undefined) {
        die(64, "plurnk: --run / PLURNK_RUN requires --session / PLURNK_SESSION");
    }

    const projectRootRaw = values["project-root"] ?? process.env.PLURNK_PROJECT_ROOT;
    const projectRoot: string | null = (() => {
        try { return resolveProjectRoot(projectRootRaw); }
        catch (cause) { return die(64, cause instanceof Error ? cause.message : String(cause)); }
    })();
    const persona: string | undefined = await (async () => {
        try { return await resolvePersona(values.persona ?? process.env.PLURNK_PERSONA); }
        catch (cause) { return die(1, `plurnk: cannot read persona file: ${cause instanceof Error ? cause.message : String(cause)}`); }
    })();

    const url = process.env.PLURNK_URL ?? "ws://127.0.0.1:3044";
    const rpc = new Rpc({ url });

    try {
        await rpc.connect();
    } catch (cause) {
        die(1, `plurnk: cannot connect to daemon at ${url}\n  ${cause instanceof Error ? cause.message : String(cause)}\n\nIs the daemon running? Start it from plurnk-service with:\n  node bin/plurnk-service.js start`);
    }

    try {
        const session = await attachOrCreateSession(rpc, { sessionName, runName, projectRoot });
        if (prompt.length === 0) {
            await runTui(rpc, session, { modelAlias, persona, yolo });
            process.exit(0);
        }
        const exitCode = await runCli(rpc, prompt, session, { json: values.json === true, modelAlias, persona, yolo });
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
