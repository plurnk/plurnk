// Thin TUI projection of the daemon-owned file members Functionality family:
// the common lifecycle (list | discover | add | enable | disable | remove)
// over the Worker's `members` actions. Git-tracked files are members on their
// own; a definition is one gitignore-style glob that includes untracked files
// or, with a leading `!`, excludes members. The client composes exact
// definitions and renders the daemon's states; resolution, the model's
// ceiling, and enablement policy live in the service.

import { commandUsage } from "./commands.ts";

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

type MutationResult = { status?: unknown; alias?: unknown; removed?: unknown; definition?: DefinitionState };

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
const effectOf = (glob: string): { effect: "include" | "exclude"; pattern: string } =>
    glob.startsWith("!") ? { effect: "exclude", pattern: glob.slice(1) } : { effect: "include", pattern: glob };

const renderResolution = (effect: "include" | "exclude", detail: Resolution | undefined): string => {
    if (typeof detail?.matched !== "number") return "";
    if (effect === "exclude") return ` → ${count(detail.matched, "member")}`;
    const ignored = typeof detail.ignored === "number" && detail.ignored > 0 ? ` (${detail.ignored} ignored)` : "";
    return ` → ${count(detail.matched, "file")}${ignored}`;
};

const renderDefinition = (entry: DefinitionState): string => {
    const alias = typeof entry.alias === "string" ? entry.alias : "(unnamed)";
    const origin = typeof entry.origin === "string" ? entry.origin : "unknown";
    const state = typeof entry.state === "string" ? entry.state : "unknown";
    const { effect, pattern } = effectOf(typeof entry.definition?.glob === "string" ? entry.definition.glob : "unknown");
    const problem = typeof entry.problem?.detail === "string" ? `  — ${entry.problem.detail}` : "";
    return `  ${alias}  ${origin}  ${state}  ${effect} ${pattern}${renderResolution(effect, entry.detail)}${problem}\n`;
};

const renderCandidate = (candidate: Candidate): string => {
    const alias = typeof candidate.alias === "string" ? candidate.alias : "(unnamed)";
    const kind = typeof candidate.provenance?.kind === "string" ? candidate.provenance.kind : "candidate";
    const glob = typeof candidate.definition?.glob === "string" ? `  ${candidate.definition.glob}` : "";
    const summary = typeof candidate.summary === "string" ? `  ${candidate.summary}` : "";
    return `  ${alias}  ${kind}${glob}${summary}\n`;
};

const renderMutation = (result: MutationResult, verb: "added" | "enabled" | "disabled", aliasHint: string, write: (text: string) => void): void => {
    const alias = typeof result.alias === "string" ? result.alias : aliasHint;
    const state = typeof result.definition?.state === "string" ? ` (${result.definition.state})` : "";
    const problem = typeof result.definition?.problem?.detail === "string" ? `  — ${result.definition.problem.detail}` : "";
    write(`  ${verb}: ${alias}${state}${problem}\n`);
};

const usage = (write: (text: string) => void, subcommand?: string): void => {
    write(`  usage: ${commandUsage("members", subcommand)}\n`);
};

const list = async (rpc: ActionCaller, write: (text: string) => void): Promise<unknown> => {
    const result = await rpc.call("worker.members.list", {}) as { definitions?: unknown };
    if (!Array.isArray(result.definitions)) throw new Error("worker.members.list returned an invalid result.");
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
        const result = await rpc.call("worker.members.discover", { query }) as { candidates?: unknown };
        if (!Array.isArray(result.candidates)) throw new Error("worker.members.discover returned an invalid result.");
        if (result.candidates.length === 0) write("  candidates: none\n");
        else for (const candidate of result.candidates) write(renderCandidate(candidate as Candidate));
        return result;
    }

    if (command === "add") {
        const glob = args.slice(2).join(" ");
        if (args.length < 3 || name.length === 0 || glob.length === 0) {
            usage(write, "add");
            return null;
        }
        const definition: MembersDefinition = { glob };
        const result = await rpc.call("worker.members.add", { alias: name, definition }) as MutationResult;
        renderMutation(result, "added", name, write);
        return result;
    }

    if (command === "enable" || command === "disable") {
        if (args.length !== 2 || name.length === 0) {
            usage(write, command);
            return null;
        }
        const result = await rpc.call(`worker.members.${command}`, { alias: name }) as MutationResult;
        renderMutation(result, command === "enable" ? "enabled" : "disabled", name, write);
        return result;
    }

    if (command === "remove") {
        if (args.length !== 2 || name.length === 0) {
            usage(write, "remove");
            return null;
        }
        const result = await rpc.call("worker.members.remove", { alias: name });
        write(`  removed: ${name}\n`);
        return result;
    }

    usage(write);
    return null;
};
