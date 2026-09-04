// One bounded `npm audit` for prepublishOnly (#144). npm's advisory endpoint drops over-limit
// requests instead of answering 429, and retries only feed the limit: an unreachable endpoint
// warns and continues; a genuine ≥high finding still fails.
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

// The texts npm actually prints for a dropped request, plus the generic transport failures.
const UNREACHABLE = /network timeout|audit endpoint returned an error|ETIMEDOUT|ECONNRESET|ERR_SOCKET_TIMEOUT|FETCH_ERROR|socket hang up|request to .* failed|timed out/iu;

export const unreachable = (text) => UNREACHABLE.test(text);

export const auditGate = async () => {
    try {
        const { stdout } = await run("npm", ["audit", "--audit-level=high"], {
            env: { ...process.env, npm_config_audit: "true", npm_config_fetch_retries: "0", npm_config_fetch_timeout: "60000" },
            maxBuffer: 64 * 1024 * 1024,
        });
        process.stdout.write(stdout);
        return 0;
    } catch (cause) {
        const text = `${cause.stdout ?? ""}\n${cause.stderr ?? ""}`;
        if (!unreachable(text)) {
            process.stderr.write(text);
            return 1;
        }
        console.warn(`audit-gate: dependency audit UNREACHABLE — the advisory endpoint did not answer; continuing (#144). Re-run \`npm audit\` when it recovers.\n${text.trim().slice(0, 300)}`);
        return 0;
    }
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await auditGate();
