// Thin TUI projection of the daemon-owned schedule Functionality family: the
// common lifecycle (list | discover | add | enable | disable | remove) over the
// workspace's `schedule` actions. The client composes one exact definition and
// renders the daemon's states; the clock, the rule's canonical form, the timers
// and the delivery live in the service.

import { commandUsage } from "./commands.ts";

interface ActionCaller {
    call(method: string, params?: object): Promise<unknown>;
}

type Definition = Record<string, unknown> & { rule?: unknown; target?: unknown; prompt?: unknown; policy?: unknown };

type DefinitionState = {
    alias?: unknown;
    origin?: unknown;
    state?: unknown;
    definition?: Definition;
    detail?: { text?: unknown; next?: unknown; exhausted?: unknown; zone?: unknown };
    problem?: { detail?: unknown };
};

type Candidate = { alias?: unknown; summary?: unknown; definition?: Definition };

type MutationResult = { status?: unknown; alias?: unknown; removed?: unknown; definition?: DefinitionState };

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

// A bare worker name is the `worker://` target; `--accept` lets a loop the delivery starts act
// on its own proposals.
export const composeDefinition = (worker: string, rule: string, prompt: string, accept = false): Definition => ({
    rule,
    target: worker.startsWith("worker://") ? worker : `worker://${worker}`,
    prompt,
    ...(accept ? { policy: { proposals: "accept" } } : {}),
});

const renderDefinition = (entry: DefinitionState): string => {
    const alias = typeof entry.alias === "string" ? entry.alias : "(unnamed)";
    const state = typeof entry.state === "string" ? entry.state : "unknown";
    const text = typeof entry.detail?.text === "string" ? `  ${entry.detail.text}` : "";
    const when = entry.detail?.exhausted === true ? "  exhausted" : typeof entry.detail?.next === "string" ? `  next ${entry.detail.next}` : "";
    const target = typeof entry.definition?.target === "string" ? `  ${entry.definition.target}` : "";
    const origin = entry.origin === "service" ? "  (service)" : "";
    const problem = typeof entry.problem?.detail === "string" ? `  — ${entry.problem.detail}` : "";
    return `  ${alias}  ${state}${text}${when}${target}${origin}${problem}\n`;
};

const renderCandidate = (candidate: Candidate): string => {
    const alias = typeof candidate.alias === "string" ? candidate.alias : "(unnamed)";
    const summary = typeof candidate.summary === "string" ? `  ${candidate.summary}` : "";
    const rule = typeof candidate.definition?.rule === "string" ? `\n    ${candidate.definition.rule.replaceAll("\n", "\n    ")}` : "";
    return `  ${alias}  candidate${summary}${rule}\n`;
};

const renderMutation = (result: MutationResult, verb: "added" | "enabled" | "disabled", aliasHint: string, write: (text: string) => void): void => {
    const alias = typeof result.alias === "string" ? result.alias : aliasHint;
    const state = typeof result.definition?.state === "string" ? ` (${result.definition.state})` : "";
    const next = typeof result.definition?.detail?.next === "string" ? `  next ${result.definition.detail.next}` : "";
    const problem = typeof result.definition?.problem?.detail === "string" ? `  — ${result.definition.problem.detail}` : "";
    write(`  ${verb}: ${alias}${state}${next}${problem}\n`);
};

const usage = (write: (text: string) => void, subcommand?: string): void => {
    write(`  usage: ${commandUsage("schedule", subcommand)}\n`);
};

export const handleSchedule = async (
    input: string | readonly string[],
    rpc: ActionCaller,
    write: (text: string) => void,
): Promise<unknown | null> => {
    if (input.length === 0) {
        const result = await rpc.call("workspace.schedule.list", {}) as { definitions?: unknown };
        if (!Array.isArray(result.definitions)) throw new Error("workspace.schedule.list returned an invalid result.");
        if (result.definitions.length === 0) write("  schedules: none\n");
        else for (const definition of result.definitions) write(renderDefinition(definition as DefinitionState));
        return result;
    }

    const args = typeof input === "string" ? argumentsOf(input) : [...input];
    if (args === null || args.length === 0) { usage(write); return null; }
    const [command] = args;

    if (command === "discover") {
        const source = args.slice(1).join(" ");
        if (source.length === 0) {
            usage(write, "discover");
            return null;
        }
        const result = await rpc.call("workspace.schedule.discover", { source }) as { candidates?: unknown };
        if (!Array.isArray(result.candidates)) throw new Error("workspace.schedule.discover returned an invalid result.");
        if (result.candidates.length === 0) write("  candidates: none\n");
        else for (const candidate of result.candidates) write(renderCandidate(candidate as Candidate));
        return result;
    }

    if (command === "add") {
        const accept = args[1] === "--accept";
        const [alias, worker, rule, ...prompt] = args.slice(accept ? 2 : 1);
        if (alias === undefined || alias.length === 0 || worker === undefined || worker.length === 0 || rule === undefined || rule.length === 0 || prompt.length === 0) {
            usage(write, "add");
            return null;
        }
        const result = await rpc.call("workspace.schedule.add", { alias, definition: composeDefinition(worker, rule, prompt.join(" "), accept) }) as MutationResult;
        renderMutation(result, "added", alias, write);
        return result;
    }

    const alias = args[1];
    if (command === "enable" || command === "disable") {
        if (args.length !== 2 || alias.length === 0) {
            usage(write, command);
            return null;
        }
        const result = await rpc.call(`workspace.schedule.${command}`, { alias }) as MutationResult;
        renderMutation(result, command === "enable" ? "enabled" : "disabled", alias, write);
        return result;
    }

    if (command === "remove") {
        if (args.length !== 2 || alias.length === 0) {
            usage(write, "remove");
            return null;
        }
        const result = await rpc.call("workspace.schedule.remove", { alias });
        write(`  removed: ${alias}\n`);
        return result;
    }

    usage(write);
    return null;
};
