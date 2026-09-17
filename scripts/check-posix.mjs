import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const checks = [
    ["mandoc", "-T", "lint", "man/plurnk.1"],
    ["bash", "-n", "completions/plurnk.bash"],
    ["zsh", "-n", "completions/_plurnk"],
    ["fish", "--no-config", "-n", "completions/plurnk.fish"],
    ["shellcheck", "-s", "bash", "completions/plurnk.bash"],
];

export const checkPosix = () => checks.map(([command, ...args]) => {
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", timeout: 10_000 });
    if (result.error && result.error.code !== "ENOENT") throw result.error;
    return {
        command,
        missing: result.error?.code === "ENOENT",
        status: result.status,
        output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    };
});

if (import.meta.main) {
    for (const { command, missing, status, output } of checkPosix()) {
        if (output) process.stderr.write(output);
        console.log(`${command}: ${missing ? "missing executable" : status === 0 ? "passed" : `failed (${status})`}`);
        if (status !== 0) process.exitCode = 1;
    }
}
