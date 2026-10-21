import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--env-file=")) process.loadEnvFile(arg.slice("--env-file=".length));
}

const root = process.env.PLURNK_SERVICE_STATE_ROOT || dirname(process.env.PLURNK_SERVICE_DB_PATH);
const witness = process.env.LAUNCH_WITNESS;
const state = { pid: process.pid, root, home: process.env.HOME, model: process.env.PLURNK_MODEL };
writeFileSync(witness, JSON.stringify(state));
process.on("SIGTERM", () => {
    writeFileSync(`${witness}.stopped`, JSON.stringify({ rootExists: existsSync(root) }));
    process.exit(0);
});

if (process.env.LAUNCH_CASE === "exit") {
    process.stderr.write("launch fixture admission refused\n");
    process.exit(17);
}
if (process.env.LAUNCH_CASE !== "timeout") {
    process.stdout.write(`plurnk-service agui=http://127.0.0.1:43210/agui db=${JSON.stringify(join(root, "plurnk.db"))} route="fixture"\n`);
}
setInterval(() => {}, 1_000);
