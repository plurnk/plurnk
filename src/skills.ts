// Project-facing projection of the universal Agent Skills package manager.
// Plurnk owns neither its registry nor its installation format: this wrapper
// fixes the target to the shared `.agents/skills` convention and leaves source
// resolution, lock metadata, updates, and removal to the standard CLI.

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify, stripVTControlCharacters } from "node:util";

const execFileP = promisify(execFile);

export interface SkillsCommandResult {
    stdout: string;
    stderr: string;
}

export type SkillsRunner = (
    args: readonly string[],
    cwd: string,
) => Promise<SkillsCommandResult>;

const runSkills: SkillsRunner = async (args, cwd) => {
    const { stdout, stderr } = await execFileP(
        "npx",
        ["--yes", "skills", ...args],
        {
            cwd,
            env: { ...process.env, NO_COLOR: "1" },
            maxBuffer: 4 * 1024 * 1024,
        },
    );
    return { stdout, stderr };
};

const argumentsOf = (source: string): string[] | null => {
    const values: string[] = [];
    let value = "";
    let quote: "\"" | "'" | null = null;
    let escaped = false;
    let started = false;
    for (const character of source) {
        if (escaped) {
            value += character;
            escaped = false;
            started = true;
            continue;
        }
        if (character === "\\") {
            escaped = true;
            started = true;
            continue;
        }
        if (quote !== null) {
            if (character === quote) quote = null;
            else value += character;
            started = true;
            continue;
        }
        if (character === "\"" || character === "'") {
            quote = character;
            started = true;
            continue;
        }
        if (/\s/u.test(character)) {
            if (started) {
                values.push(value);
                value = "";
                started = false;
            }
            continue;
        }
        value += character;
        started = true;
    }
    if (escaped || quote !== null) return null;
    if (started) values.push(value);
    return values;
};

const usage = (write: (text: string) => void): void => {
    write("  usage: /skills [list [--global]]\n");
    write("         /skills add <source> [--skill <name> ...] [--global]\n");
    write("         /skills remove <name> ... [--global]\n");
    write("         /skills find <query>\n");
    write("         /skills update [name ...] [--global]\n");
};

const includesAny = (args: readonly string[], choices: readonly string[]): boolean =>
    args.some((arg) => choices.includes(arg));

const commandArguments = (input: readonly string[]): string[] | null => {
    if (input.length === 0) return ["list", "--agent", "universal"];
    if (input.some((arg) => arg === "--agent" || arg === "-a" || arg.startsWith("--agent="))) return null;

    const [command, ...rest] = input;
    switch (command) {
        case "list":
        case "ls":
            return ["list", ...rest, "--agent", "universal"];
        case "add":
        case "install":
            return rest.length === 0 || includesAny(rest, ["--all"])
                ? null
                : ["add", ...rest, "--agent", "universal", "--yes"];
        case "remove":
        case "rm":
            return rest.length === 0
                ? null
                : ["remove", ...rest, "--agent", "universal", "--yes"];
        case "find":
        case "search":
            return rest.length === 0 ? null : ["find", ...rest];
        case "update":
        case "upgrade":
            return [
                "update",
                ...rest,
                ...(includesAny(rest, ["--global", "-g", "--project", "-p"])
                    ? []
                    : ["--project"]),
                "--yes",
            ];
        default:
            return null;
    }
};

export const handleSkills = async (
    input: string | readonly string[],
    write: (text: string) => void,
    projectRoot: string | null | undefined,
    runner: SkillsRunner = runSkills,
): Promise<void> => {
    if (projectRoot === null || projectRoot === undefined || projectRoot.length === 0) {
        throw new Error("skills require a workspace project root");
    }
    const parsed = typeof input === "string" ? argumentsOf(input) : [...input];
    const args = parsed === null ? null : commandArguments(parsed);
    if (args === null) {
        usage(write);
        return;
    }

    try {
        const { stdout, stderr } = await runner(args, resolve(projectRoot));
        if (stdout.length > 0) write(stripVTControlCharacters(stdout));
        if (stderr.length > 0) write(stripVTControlCharacters(stderr));
    } catch (cause) {
        const output = cause as { stdout?: unknown; stderr?: unknown };
        if (typeof output.stdout === "string" && output.stdout.length > 0) {
            write(stripVTControlCharacters(output.stdout));
        }
        if (typeof output.stderr === "string" && output.stderr.length > 0) {
            write(stripVTControlCharacters(output.stderr));
        }
        throw new Error("Agent Skills command failed", { cause });
    }
};
