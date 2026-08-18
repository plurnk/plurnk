// Thin operator projection of workspace Agent Skills management. The client
// reads and writes the workspace's skills/ directory directly; the daemon
// republishes the worker://plurnk/skills/ surface on its next workspace
// refresh, so changes are discoverable by the model from the following turn.

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const skillsDir = (projectRoot: string | null | undefined): string => {
    if (projectRoot === null || projectRoot === undefined || projectRoot.length === 0) {
        throw new Error("skills require a workspace project root");
    }
    return join(resolve(projectRoot), "skills");
};

const requireName = (name: string): string => {
    if (!NAME_PATTERN.test(name)) {
        throw new Error(`skill name '${name}' must match ${NAME_PATTERN.source}`);
    }
    return name;
};

const frontmatter = (raw: string): { name: string | null; description: string | null } => {
    const lines = raw.replace(/\r\n/gu, "\n").split("\n");
    let name: string | null = null;
    let description: string | null = null;
    if (lines[0]?.trim() === "---") {
        for (let index = 1; index < lines.length; index += 1) {
            const line = lines[index]!.trimEnd();
            if (line === "---") break;
            const key = /^([a-z]+):\s*(.*)$/u.exec(line.trim());
            if (key?.[1] === "name" && key[2]!.length > 0) name = key[2]!;
            else if (key?.[1] === "description" && key[2]!.length > 0) description = key[2]!;
        }
    }
    return { name, description };
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
    write("  usage: /skills\n");
    write("         /skills add <name> <path-to-SKILL.md>\n");
    write("         /skills install <owner/repo|git-url|local-path> [--skill <name>]\n");
    write("         /skills remove <name>\n");
};

// npx-skills-compatible sources: `owner/repo` (GitHub shorthand), any git URL,
// or a local path. The client clones/reads the source and copies the selected
// skill folders into the workspace's skills/ — the daemon never fetches git.
const resolveSkillSource = async (source: string): Promise<{ dir: string; cleanup: () => Promise<void> }> => {
    if (/^[\w.-]+\/[\w.-]+$/.test(source)) {
        const dir = await mkdtemp(join(tmpdir(), "plurnk-skill-"));
        await execFileP("git", ["clone", "--depth", "1", `https://github.com/${source}.git`, dir]);
        return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
    }
    if (/^(https?:\/\/|git@|ssh:\/\/)/.test(source) || source.endsWith(".git")) {
        const dir = await mkdtemp(join(tmpdir(), "plurnk-skill-"));
        await execFileP("git", ["clone", "--depth", "1", source, dir]);
        return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
    }
    return { dir: resolve(source), cleanup: async () => undefined };
};

const skillFoldersOf = async (dir: string): Promise<string[]> => {
    const candidate = await readdir(join(dir, "skills"), { withFileTypes: true }).then(
        (entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, "skills", entry.name)),
    ).catch(() => []);
    const entries = candidate.length > 0
        ? candidate
        : await readdir(dir, { withFileTypes: true }).then(
            (found) => found.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name)),
        ).catch(() => []);
    const folders: string[] = [];
    for (const folder of entries) {
        const hasDoc = await readdir(folder).then((names) => names.includes("SKILL.md")).catch(() => false);
        if (hasDoc) folders.push(folder);
    }
    return folders;
};

export const handleSkills = async (
    input: string | readonly string[],
    write: (text: string) => void,
    projectRoot: string | null | undefined,
): Promise<void> => {
    if (input.length === 0) {
        const dir = skillsDir(projectRoot);
        const folders = (await readdir(dir, { withFileTypes: true }).catch(() => []))
            .filter((entry) => entry.isDirectory())
            .toSorted((left, right) => left.name.localeCompare(right.name));
        if (folders.length === 0) {
            write("  skills: none\n");
            return;
        }
        for (const folder of folders) {
            const raw = await readFile(join(dir, folder.name, "SKILL.md"), "utf8").catch(() => null);
            const { name, description } = raw === null
                ? { name: null, description: null }
                : frontmatter(raw);
            const label = name ?? folder.name;
            write(description === null
                ? `  ${label}\n`
                : `  ${label} — ${description}\n`);
        }
        return;
    }

    const args = typeof input === "string" ? argumentsOf(input) : [...input];
    if (args === null || args.length === 0) {
        usage(write);
        return;
    }
    const [command, name] = args;
    const dir = skillsDir(projectRoot);

    if (command === "add") {
        if (args.length !== 3 || name.length === 0 || args[2].length === 0) {
            write("  usage: /skills add <name> <path-to-SKILL.md>\n");
            return;
        }
        const folder = requireName(name);
        let raw: string;
        try {
            raw = await readFile(resolve(args[2]), "utf8");
        } catch (cause) {
            throw new Error(`skills file not readable: ${args[2]}`, { cause });
        }
        await mkdir(join(dir, folder), { recursive: true });
        await writeFile(join(dir, folder, "SKILL.md"), raw);
        write(`  added: ${folder}\n`);
        return;
    }

    if (command === "install") {
        if (args.length < 2 || args[1].length === 0) {
            write("  usage: /skills install <owner/repo|git-url|local-path> [--skill <name>]\n");
            return;
        }
        const skillFlag = args.indexOf("--skill");
        const requested = skillFlag >= 0 ? (args[skillFlag + 1] ?? "") : null;
        if (requested === "") {
            write("  usage: /skills install <source> --skill <name>\n");
            return;
        }
        const source = await resolveSkillSource(args[1]);
        try {
            const folders = (await skillFoldersOf(source.dir))
                .filter((folder) => requested === null
                    || folder.split(/[\/\\]/u).at(-1) === requested);
            if (folders.length === 0) {
                write(`  skills: no skill${requested === null ? "s" : ` named ${requested}`} in ${args[1]}\n`);
                return;
            }
            const wanted: string | null = requested;
            const installed: string[] = [];
            for (const folder of folders) {
                const name = requireName(folder.split(/[\/\\]/u).at(-1) ?? "");
                await cp(folder, join(dir, name), { recursive: true });
                installed.push(name);
            }
            write(`  installed: ${installed.join(", ")}\n`);
        } finally {
            await source.cleanup();
        }
        return;
    }

    if (command === "remove") {
        if (args.length !== 2 || name.length === 0) {
            write("  usage: /skills remove <name>\n");
            return;
        }
        const folder = requireName(name);
        const exists = await readdir(join(dir, folder)).then(() => true).catch(() => false);
        if (!exists) {
            write(`  skills: no skill named ${folder}\n`);
            return;
        }
        await rm(join(dir, folder), { recursive: true, force: true });
        write(`  removed: ${folder}\n`);
        return;
    }

    usage(write);
};
