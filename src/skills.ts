// Thin operator projection of workspace Agent Skills management. The client
// reads and writes the workspace's skills/ directory directly; the daemon
// republishes the worker://plurnk/skills/ surface on its next workspace
// refresh, so changes are discoverable by the model from the following turn.

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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
    write("         /skills remove <name>\n");
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
