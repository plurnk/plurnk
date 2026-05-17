import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { Engine, Migrator, SchemeRegistry, PATHS } from "@plurnk/plurnk-service";
import OpenAI from "@plurnk/plurnk-providers-openai";

const requireEnv = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === "") {
        throw new Error(`${name} is not set. Copy .env.example to .env or export the variable in your shell.`);
    }
    return value;
};

const openDb = (dbPath: string): DatabaseSync => {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    return db;
};

export type RunResult = {
    sessionId: number;
    runId: number;
    loopId: number;
    turnIds: number[];
    finalStatus: number;
    hitMaxTurns: boolean;
    wallMs: number;
};

export const run = async (prompt: string): Promise<RunResult> => {
    if (prompt.length === 0) throw new Error("plurnk: prompt is empty");

    const dbPath = requireEnv("PLURNK_DB_PATH");
    const maxTurns = Number(requireEnv("PLURNK_MAX_TURNS"));
    const model = requireEnv("OPENAI_MODEL");

    const systemPrompt = await readFile(PATHS.instructionsSystem, "utf8");

    const db = openDb(dbPath);
    try {
        await new Migrator({ db, dir: PATHS.migrations }).migrate();

        const sessionName = `${model.replace(/\.[^/]+$/, "")}-${Math.floor(Date.now() / 1000)}`;
        const sessionId = (db.prepare("INSERT INTO sessions (name) VALUES (?) RETURNING id").get(sessionName) as { id: number }).id;
        const runId = (db.prepare("INSERT INTO runs (session_id) VALUES (?) RETURNING id").get(sessionId) as { id: number }).id;
        const loopId = (db.prepare("INSERT INTO loops (run_id, sequence, prompt) VALUES (?, 1, ?) RETURNING id").get(runId, prompt) as { id: number }).id;

        const provider = new OpenAI({
            baseUrl: requireEnv("OPENAI_BASE_URL"),
            apiKey: process.env.OPENAI_API_KEY ?? "",
            model,
            contextSize: Number(requireEnv("OPENAI_CONTEXT_SIZE")),
            fetchTimeoutMs: Number(requireEnv("OPENAI_FETCH_TIMEOUT_MS")),
            think: requireEnv("OPENAI_THINK") === "1",
        });

        const engine = new Engine({ db, schemes: new SchemeRegistry() });

        process.stdout.write(`session: ${sessionName} (id=${sessionId})\n`);
        process.stdout.write(`run: ${runId} | loop: ${loopId}\n`);
        process.stdout.write(`provider: ${provider.baseUrl} (${provider.model}, ${provider.contextSize} ctx)\n`);
        process.stdout.write(`prompt: ${prompt}\n\n`);

        const start = Date.now();
        const result = await engine.runLoop({
            provider, sessionId, runId, loopId, maxTurns,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: prompt },
            ],
        });
        const wallMs = Date.now() - start;

        for (const [i, turnId] of result.turnIds.entries()) {
            const turn = db.prepare("SELECT status, packet, usage_completion FROM turns WHERE id = ?").get(turnId) as { status: number; packet: string; usage_completion: number };
            const packet = JSON.parse(turn.packet) as { assistant: { content: string } };
            process.stdout.write(`--- turn ${i + 1} (status ${turn.status}, ${turn.usage_completion} tokens) ---\n`);
            process.stdout.write(packet.assistant.content);
            process.stdout.write("\n\n");
        }

        const entries = db.prepare("SELECT scheme, pathname FROM entries WHERE session_id = ? ORDER BY pathname").all(sessionId) as { scheme: string; pathname: string }[];
        process.stdout.write(`--- final ---\n`);
        process.stdout.write(`final status: ${result.finalStatus}${result.hitMaxTurns ? " (maxTurns reached)" : ""}\n`);
        process.stdout.write(`turns: ${result.turnIds.length}, wall: ${(wallMs / 1000).toFixed(2)}s\n`);
        if (entries.length > 0) {
            process.stdout.write(`entries written:\n`);
            for (const e of entries) process.stdout.write(`  ${e.scheme}://${e.pathname}\n`);
        }

        return { sessionId, runId, loopId, ...result, wallMs };
    } finally { db.close(); }
};
