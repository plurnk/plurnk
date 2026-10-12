// Thin TUI projection of the daemon-owned file members Functionality family:
// the common lifecycle (list | discover | add | enable | disable | remove) over
// the workspace's `members` actions. Git-tracked files are members on their
// own; a definition is one gitignore-style glob that includes untracked files
// or, with a leading `!`, excludes members, and the glob is the definition's
// name: `add` takes globs, each one definition, and enable, disable and remove
// take one. The client composes exact inputs and renders the daemon's states;
// resolution, the model's ceiling, and enablement policy live in the service.

import { commandUsage } from "./commands.ts";
import { configurationSource } from "./functionality-source.ts";

interface ActionCaller {
    call(method: string, params?: object): Promise<unknown>;
}

type MembersDefinition = { glob: string };

type Resolution = { matched?: unknown; ignored?: unknown };

type DefinitionState = {
    alias?: unknown;
    origin?: unknown;
    state?: unknown;
    definition?: Partial<MembersDefinition>;
    detail?: Resolution;
    problem?: { detail?: unknown };
};

type Candidate = { alias?: unknown; summary?: unknown; definition?: Partial<MembersDefinition>; provenance?: { kind?: unknown; source?: unknown } };

type MutationResult = { status?: unknown; alias?: unknown; removed?: unknown; definition?: DefinitionState; definitions?: unknown };

// A glob rides verbatim: quotes and backslashes are pattern characters, never
// shell syntax, so the line splits on whitespace alone.
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

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

// `!glob` excludes matching members; anything else includes matching files.
const effectOf = (glob: string): "include" | "exclude" => (glob.startsWith("!") ? "exclude" : "include");

// The definition's name is its glob, which the daemon carries as the alias and in the definition.
const globOf = (entry: { alias?: unknown; definition?: Partial<MembersDefinition> }): string =>
    typeof entry.definition?.glob === "string" ? entry.definition.glob : typeof entry.alias === "string" ? entry.alias : "(unnamed)";

const renderResolution = (effect: "include" | "exclude", detail: Resolution | undefined): string => {
    if (typeof detail?.matched !== "number") return "";
    if (effect === "exclude") return ` → ${count(detail.matched, "member")}`;
    const ignored = typeof detail.ignored === "number" && detail.ignored > 0 ? ` (${detail.ignored} ignored)` : "";
    return ` → ${count(detail.matched, "file")}${ignored}`;
};

const renderDefinition = (entry: DefinitionState): string => {
    const glob = globOf(entry);
    const origin = typeof entry.origin === "string" ? entry.origin : "unknown";
    const state = typeof entry.state === "string" ? entry.state : "unknown";
    const problem = typeof entry.problem?.detail === "string" ? `  — ${entry.problem.detail}` : "";
    return `  ${glob}  ${origin}  ${state}${renderResolution(effectOf(glob), entry.detail)}${configurationSource(entry)}${problem}\n`;
};

const renderCandidate = (candidate: Candidate): string => {
    const kind = typeof candidate.provenance?.kind === "string" ? candidate.provenance.kind : "candidate";
    const summary = typeof candidate.summary === "string" ? `  ${candidate.summary}` : "";
    return `  ${globOf(candidate)}  ${kind}${summary}\n`;
};

const renderMutation = (verb: "added" | "enabled" | "disabled", glob: string, entry: DefinitionState | undefined, write: (text: string) => void): void => {
    const state = typeof entry?.state === "string" ? ` (${entry.state})` : "";
    const problem = typeof entry?.problem?.detail === "string" ? `  — ${entry.problem.detail}` : "";
    write(`  ${verb}: ${glob}${state}${problem}\n`);
};

const usage = (write: (text: string) => void, subcommand?: string): void => {
    write(`  usage: ${commandUsage("members", subcommand)}\n`);
};

const list = async (rpc: ActionCaller, write: (text: string) => void): Promise<unknown> => {
    const result = await rpc.call("workspace.members.list", {}) as { definitions?: unknown };
    if (!Array.isArray(result.definitions)) throw new Error("workspace.members.list returned an invalid result.");
    if (result.definitions.length === 0) write("  file members: none\n");
    else for (const definition of result.definitions) write(renderDefinition(definition as DefinitionState));
    return result;
};

export const handleMembers = async (
    input: string | readonly string[],
    rpc: ActionCaller,
    write: (text: string) => void,
): Promise<unknown | null> => {
    if (input.length === 0) return list(rpc, write);

    const args = typeof input === "string" ? argumentsOf(input) : [...input];
    if (args === null || args.length === 0) { usage(write); return null; }
    const [command, name] = args;

    if (command === "discover") {
        const query = args.slice(1).join(" ");
        if (query.length === 0) {
            usage(write, "discover");
            return null;
        }
        const result = await rpc.call("workspace.members.discover", { query }) as { candidates?: unknown };
        if (!Array.isArray(result.candidates)) throw new Error("workspace.members.discover returned an invalid result.");
        if (result.candidates.length === 0) write("  candidates: none\n");
        else for (const candidate of result.candidates) write(renderCandidate(candidate as Candidate));
        return result;
    }

    // Each argument is one glob, one definition; the receipt lists every definition admitted.
    if (command === "add") {
        const files = args.slice(1);
        if (files.length === 0 || files.some((file) => file.length === 0)) {
            usage(write, "add");
            return null;
        }
        const result = await rpc.call("workspace.members.add", { files }) as MutationResult;
        if (!Array.isArray(result.definitions)) throw new Error("workspace.members.add returned an invalid result.");
        for (const entry of result.definitions as DefinitionState[]) renderMutation("added", globOf(entry), entry, write);
        return result;
    }

    if (command === "enable" || command === "disable") {
        if (args.length !== 2 || name.length === 0) {
            usage(write, command);
            return null;
        }
        const result = await rpc.call(`workspace.members.${command}`, { file: name }) as MutationResult;
        renderMutation(command === "enable" ? "enabled" : "disabled", typeof result.alias === "string" ? result.alias : name, result.definition, write);
        return result;
    }

    if (command === "remove") {
        if (args.length !== 2 || name.length === 0) {
            usage(write, "remove");
            return null;
        }
        const result = await rpc.call("workspace.members.remove", { file: name });
        write(`  removed: ${name}\n`);
        return result;
    }

    usage(write);
    return null;
};
