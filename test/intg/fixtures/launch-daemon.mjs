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
    const finish = () => {
        writeFileSync(`${witness}.stopped`, JSON.stringify({ rootExists: existsSync(root) }));
        process.exit(Number(process.env.LAUNCH_STOP_CODE || "0"));
    };
    const delay = Number(process.env.LAUNCH_STOP_DELAY_MS || "0");
    if (delay > 0) setTimeout(finish, delay);
    else finish();
});

if (process.env.LAUNCH_CASE === "exit") {
    process.stderr.write("launch fixture admission refused\n");
    process.exit(17);
}
if (process.env.LAUNCH_CASE !== "timeout") {
    process.stdout.write(`plurnk-service agui=http://127.0.0.1:43210/agui db=${JSON.stringify(join(root, "plurnk.db"))} route="fixture"\n`);
}
setInterval(() => {}, 1_000);
