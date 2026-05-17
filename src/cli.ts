import { parseArgs } from "node:util";
import { run } from "./run.ts";

const USAGE = `usage: plurnk <prompt...>

Run a single plurnk loop against the configured provider.
The prompt is everything after the program name; quoting is optional.

env (all required):
  PLURNK_DB_PATH        sqlite file path
  PLURNK_MAX_TURNS      loop safety cap
  OPENAI_BASE_URL       provider endpoint
  OPENAI_API_KEY        provider auth (empty for local)
  OPENAI_MODEL          model id
  OPENAI_CONTEXT_SIZE   provider context window in tokens
  OPENAI_FETCH_TIMEOUT_MS  request timeout in ms
  OPENAI_THINK          1 to enable provider reasoning toggle, else 0

options:
  -h, --help            print this message and exit
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
    if (positionals.length === 0) die(64, USAGE);

    const prompt = positionals.join(" ");

    try {
        const result = await run(prompt);
        if (result.finalStatus === 200) process.exit(0);
        if (result.hitMaxTurns) process.exit(2);
        process.exit(3);
    } catch (cause) {
        process.stderr.write(`plurnk: ${cause instanceof Error ? cause.message : String(cause)}\n`);
        if (cause instanceof Error && cause.cause) {
            process.stderr.write(`  cause: ${cause.cause instanceof Error ? cause.cause.message : String(cause.cause)}\n`);
        }
        process.exit(1);
    }
};
