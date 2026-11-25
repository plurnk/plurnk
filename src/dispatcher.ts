// {§cli-workspaces-and-sessions} {§cli-model-selection} {§cli-sessions-topology} {§cli-subcommands} {§cli-conformance}
// CLI entrypoint and subcommand dispatcher ({§cli-invocation}).

import { parseArgs } from "node:util";
import {
    assembleCliCommonOptions,
    CLIENT_OPTIONS,
    collectSessionEnv,
    detectInitialJsonMode,
    FAMILY_COMMANDS,
    parseSwitchValue,
    readVersion,
    STRING_LONG_FLAGS,
    USAGE,
    usageError,
} from "./cli-options.ts";
import {
    runCliCompletion,
    runCliConfig,
    runCliDaemon,
    runCliDeleteSession,
    runCliFamily,
    runCliForkSession,
    runCliListSessions,
    runCliLogin,
    runCliLogout,
    runCliLogRead,
    runCliModels,
    runCliNewSession,
    runCliPrompt,
    runCliReadCoord,
    runCliResumeSession,
    runCliScript,
    runCliUpdate,
    runCliWorkspace,
    runInteractiveSession,
} from "./cli-runner.ts";
import { RENDER_HELP, runRender } from "./render-filter.ts";
import { formatActionErrorDetail } from "./repl-commands.ts";

export {
    assembleCliCommonOptions,
    CLIENT_OPTIONS,
    collectSessionEnv,
    detectInitialJsonMode,
    parseSwitchValue,
    USAGE,
};

const readStdinAll = async (): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString("utf8");
};

export const main = async (argv: readonly string[] = process.argv): Promise<void> => {
    const rawArgs = argv.slice(2);
    let jsonOutput = detectInitialJsonMode(rawArgs, process.env.PLURNK_CLIENT_JSON);

    try {
        // Split before family or daemon command if present ({§cli-invocation})
        let clientArgs = [...rawArgs];
        let familyName: string | undefined;
        let familyArgs: string[] = [];
        let daemonPassthrough = false;
        let daemonArgs: string[] = [];

        for (let i = 0; i < rawArgs.length; i += 1) {
            const token = rawArgs[i]!;
            if (token === "--") break;
            if (token.startsWith("-")) {
                if (STRING_LONG_FLAGS.has(token)) {
                    i += 1;
                }
                continue;
            }
            if (token === "daemon") {
                clientArgs = rawArgs.slice(0, i);
                daemonPassthrough = true;
                daemonArgs = rawArgs.slice(i + 1);
            } else if (FAMILY_COMMANDS.has(token)) {
                clientArgs = rawArgs.slice(0, i);
                familyName = token;
                familyArgs = rawArgs.slice(i + 1);
            }
            break;
        }

        let parsed: ReturnType<typeof parseArgs>;
        try {
            parsed = parseArgs({
                args: clientArgs,
                allowPositionals: true,
                allowNegative: true,
                strict: true,
                options: CLIENT_OPTIONS,
            });
        } catch (err) {
            const detail = err instanceof Error ? err.message : String(err);
            throw usageError("Invalid CLI option", detail);
        }

        const positionals = parsed.positionals;
        const first = daemonPassthrough ? "daemon" : (familyName ?? positionals[0]);

        if (parsed.values.help === true && familyName === undefined && !daemonPassthrough) {
            process.stdout.write(first === "render" ? RENDER_HELP : USAGE);
            return;
        }

        if (parsed.values.version === true && familyName === undefined && !daemonPassthrough) {
            process.stdout.write(`${readVersion()}\n`);
            return;
        }

        // Local-only subcommands require no daemon or env cascade ({§cli-markdown-projection})
        if (first === "render") {
            if (positionals.length > 1) {
                throw usageError(
                    "Unexpected argument",
                    `plurnk render accepts no positional arguments (got ${positionals.slice(1).join(" ")}).`,
                );
            }
            const defaultWidth = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80;
            const width = typeof parsed.values.width === "string"
                ? (/^\d+$/u.test(parsed.values.width.trim()) ? Number.parseInt(parsed.values.width.trim(), 10) : Number.NaN)
                : defaultWidth;
            if (!Number.isInteger(width) || width < 1) {
                throw usageError("Invalid --width", "plurnk render: --width must be a positive integer.");
            }
            const mermaidTimeoutOverride =
                typeof parsed.values["mermaid-timeout-ms"] === "string"
                    ? parsed.values["mermaid-timeout-ms"]
                    : undefined;
            process.exitCode = await runRender(width, mermaidTimeoutOverride);
            return;
        }

        if (first === "completion") {
            process.exitCode = runCliCompletion(positionals[1]);
            return;
        }

        const common = assembleCliCommonOptions(parsed.values as Record<string, unknown>);
        jsonOutput = common.json;

        let exitCode = 0;

        if (daemonPassthrough) {
            exitCode = await runCliDaemon(daemonArgs, common);
        } else if (familyName !== undefined) {
            exitCode = await runCliFamily(familyName, familyArgs, common);
        } else if (first === "session") {
            const sub = positionals[1] ?? "list";
            const targetId = positionals[2] ?? common.sessionId;
            switch (sub) {
                case "list":
                    exitCode = await runCliListSessions(common);
                    break;
                case "new":
                    exitCode = await runCliNewSession(common);
                    break;
                case "resume":
                    if (!targetId) {
                        throw usageError("Missing session id", "plurnk session resume requires a <sessionId>.");
                    }
                    exitCode = await runCliResumeSession(targetId, common);
                    break;
                case "fork":
                    if (!targetId) {
                        throw usageError("Missing session id", "plurnk session fork requires a <sessionId>.");
                    }
                    exitCode = await runCliForkSession(targetId, common);
                    break;
                case "delete":
                    if (!targetId) {
                        throw usageError("Missing session id", "plurnk session delete requires a <sessionId>.");
                    }
                    exitCode = await runCliDeleteSession(targetId, common);
                    break;
                default:
                    throw usageError("Unknown subcommand", `Unknown session subcommand: ${sub}`);
            }
        } else if (first === "config") {
            if (positionals.length > 3) {
                throw usageError("Invalid arguments", "plurnk config accepts at most [<id> [<value>]].");
            }
            exitCode = await runCliConfig(positionals[1], positionals[2], common);
        } else if (first === "update") {
            exitCode = await runCliUpdate(common);
        } else if (first === "models") {
            const limitNum = typeof parsed.values.limit === "string"
                ? Number.parseInt(parsed.values.limit, 10)
                : undefined;
            const offsetNum = typeof parsed.values.offset === "string"
                ? Number.parseInt(parsed.values.offset, 10)
                : undefined;
            exitCode = await runCliModels(
                positionals.slice(1),
                {
                    ...(typeof parsed.values.provider === "string" ? { provider: parsed.values.provider } : {}),
                    ...(parsed.values.all === true ? { all: true } : {}),
                    ...(offsetNum !== undefined && Number.isInteger(offsetNum) ? { offset: offsetNum } : {}),
                    ...(limitNum !== undefined && Number.isInteger(limitNum) ? { limit: limitNum } : {}),
                },
                common,
            );
        } else if (first === "workspace") {
            exitCode = await runCliWorkspace(positionals[1], positionals[2], positionals[3], common);
        } else if (first === "log" && positionals[1] === "read") {
            const loopNum = typeof parsed.values.loop === "string" ? Number.parseInt(parsed.values.loop, 10) : undefined;
            const turnNum = typeof parsed.values.turn === "string" ? Number.parseInt(parsed.values.turn, 10) : undefined;
            const sinceNum = typeof parsed.values.since === "string" ? Number.parseInt(parsed.values.since, 10) : undefined;
            const limitNum = typeof parsed.values.limit === "string" ? Number.parseInt(parsed.values.limit, 10) : undefined;
            exitCode = await runCliLogRead(
                {
                    ...(loopNum !== undefined && Number.isInteger(loopNum) ? { loopId: loopNum } : {}),
                    ...(turnNum !== undefined && Number.isInteger(turnNum) ? { turnId: turnNum } : {}),
                    ...(sinceNum !== undefined && Number.isInteger(sinceNum) ? { sinceId: sinceNum } : {}),
                    ...(limitNum !== undefined && Number.isInteger(limitNum) ? { limit: limitNum } : {}),
                },
                common,
            );
        } else if (first === "read") {
            if (!positionals[1]) {
                throw usageError("Missing coordinate", "plurnk read requires a <loop>/<turn>/<seq> coordinate.");
            }
            exitCode = await runCliReadCoord(positionals[1], common);
        } else if (first === "effort") {
            exitCode = await runCliConfig("thought_level", positionals[1], common);
        } else if (first === "persona") {
            exitCode = await runCliConfig("persona", positionals[1], common);
        } else if (first === "login") {
            exitCode = await runCliLogin(common);
        } else if (first === "logout") {
            exitCode = await runCliLogout(common);
        } else if (first === "script") {
            if (!positionals[1]) {
                throw usageError("Missing script path", "plurnk script requires a <file.plk> path.");
            }
            exitCode = await runCliScript(positionals[1], common);
        } else if (common.repl && positionals.length === 0) {
            if (common.json) {
                throw usageError(
                    "Incompatible flags",
                    "--json requires one-shot or subcommand mode and cannot be used with --repl.",
                );
            }
            exitCode = await runInteractiveSession(common);
        } else {
            const positionalText = positionals.join(" ");
            const stdinText = !process.stdin.isTTY ? (await readStdinAll()).trim() : "";
            const promptText = positionalText.length > 0 && stdinText.length > 0
                ? `${positionalText}\n\n${stdinText}`
                : positionalText.length > 0
                    ? positionalText
                    : stdinText;

            if (promptText.length === 0) {
                if (process.stdin.isTTY && !common.json) {
                    exitCode = await runInteractiveSession(common);
                } else {
                    throw usageError(
                        "Missing prompt",
                        common.json
                            ? "--json requires a non-empty prompt or subcommand."
                            : "No prompt provided on arguments or standard input. Run `plurnk --help` for usage.",
                    );
                }
            } else {
                exitCode = await runCliPrompt(promptText, common);
            }
        }

        if (exitCode !== 0) {
            process.exitCode = exitCode;
        }
    } catch (error) {
        const cliErr = error as {
            readonly problem?: Record<string, unknown>;
            readonly data?: Record<string, unknown>;
            readonly exitCode?: number;
        };
        const message = error instanceof Error ? error.message : String(error);
        const dataProblem =
            cliErr?.data !== undefined &&
            cliErr.data !== null &&
            typeof cliErr.data === "object" &&
            typeof cliErr.data.type === "string" &&
            typeof cliErr.data.title === "string" &&
            typeof cliErr.data.status === "number"
                ? cliErr.data
                : undefined;
        const problem = cliErr?.problem ?? dataProblem ?? {
            type: "https://problems.plurnk.xyz/client/error",
            title: "Client error",
            status: 500,
            detail: message,
        };
        if (jsonOutput) {
            process.stdout.write(`${JSON.stringify({ schemaVersion: 6, problem })}\n`);
        } else {
            process.stderr.write(`plurnk: ${formatActionErrorDetail(error)}\n`);
        }
        process.exitCode = typeof cliErr?.exitCode === "number" ? cliErr.exitCode : 1;
    }
};
