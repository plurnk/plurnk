// Thin TUI projection of the daemon-owned Agent Skills Functionality family:
// the common lifecycle (list | discover | add | enable | disable | remove)
// over the Worker's `skills` actions. The client composes exact definitions
// and renders the daemon's states; installation, discovery, and enablement
// policy live in the service.

interface ActionCaller {
    call(method: string, params?: object): Promise<unknown>;
}

type SkillDefinition = { name: string; scope: "project" | "global"; source?: string };

type DefinitionState = {
    alias?: unknown;
    origin?: unknown;
    state?: unknown;
    definition?: Partial<SkillDefinition>;
    detail?: { scope?: unknown; description?: unknown };
    problem?: { detail?: unknown };
};

type Candidate = { alias?: unknown; summary?: unknown; definition?: Partial<SkillDefinition>; provenance?: { kind?: unknown; source?: unknown; reference?: unknown } };

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

// A package reference (owner/repo, URL, or path) is a source; anything else
// is a registry query.
export const isSource = (term: string): boolean => /[\/\\:]/u.test(term) || term.startsWith(".") || term.startsWith("~");

const renderDefinition = (entry: DefinitionState): string => {
    const alias = typeof entry.alias === "string" ? entry.alias : "(unnamed)";
    const state = typeof entry.state === "string" ? entry.state : "unknown";
    const scope = typeof entry.definition?.scope === "string" ? entry.definition.scope : "unknown";
    const source = typeof entry.definition?.source === "string" ? `  ${entry.definition.source}` : "";
    const description = typeof entry.detail?.description === "string" ? `  ${entry.detail.description}` : "";
    const origin = entry.origin === "worker" ? "  (worker)" : "";
    const problem = typeof entry.problem?.detail === "string" ? `  — ${entry.problem.detail}` : "";
    return `  ${alias}  ${state}  ${scope}${source}${description}${origin}${problem}\n`;
};

const renderCandidate = (candidate: Candidate): string => {
    const alias = typeof candidate.alias === "string" ? candidate.alias : "(unnamed)";
    const source = typeof candidate.definition?.source === "string" ? `  ${candidate.definition.source}` : "";
    const summary = typeof candidate.summary === "string" ? `  ${candidate.summary}` : "";
    const reference = typeof candidate.provenance?.reference === "string" ? `  ${candidate.provenance.reference}` : "";
    return `  ${alias}  candidate${source}${summary}${reference}\n`;
};

const renderMutation = (result: MutationResult, verb: "added" | "enabled" | "disabled", aliasHint: string, write: (text: string) => void): void => {
    const alias = typeof result.alias === "string" ? result.alias : aliasHint;
    const state = typeof result.definition?.state === "string" ? ` (${result.definition.state})` : "";
    const problem = typeof result.definition?.problem?.detail === "string" ? `  — ${result.definition.problem.detail}` : "";
    write(`  ${verb}: ${alias}${state}${problem}\n`);
};

const usage = (write: (text: string) => void): void => {
    write("  usage: /skills [discover <query|source> | add <name> <source> [--global] | enable|disable|remove <name>]\n");
};

export const handleSkills = async (
    input: string | readonly string[],
    rpc: ActionCaller,
    write: (text: string) => void,
): Promise<unknown | null> => {
    if (input.length === 0) {
        const result = await rpc.call("worker.skills.list", {}) as { definitions?: unknown };
        if (!Array.isArray(result.definitions)) throw new Error("worker.skills.list returned an invalid result.");
        if (result.definitions.length === 0) write("  Agent Skills: none\n");
        else for (const definition of result.definitions) write(renderDefinition(definition as DefinitionState));
        return result;
    }

    const args = typeof input === "string" ? argumentsOf(input) : [...input];
    if (args === null || args.length === 0) { usage(write); return null; }
    const [command, name] = args;

    if (command === "discover" || command === "find") {
        const term = args.slice(1).join(" ").trim();
        if (term.length === 0) {
            write("  usage: /skills discover <query|source>\n");
            return null;
        }
        const query = args.length === 2 && isSource(term) ? { source: term } : { query: term };
        const result = await rpc.call("worker.skills.discover", query) as { candidates?: unknown };
        if (!Array.isArray(result.candidates)) throw new Error("worker.skills.discover returned an invalid result.");
        if (result.candidates.length === 0) write("  candidates: none\n");
        else for (const candidate of result.candidates) write(renderCandidate(candidate as Candidate));
        return result;
    }

    if (command === "add") {
        const positional = args.slice(1).filter((arg) => arg !== "--global");
        const global = args.includes("--global");
        if (positional.length !== 2 || positional[0].length === 0 || positional[1].length === 0) {
            write("  usage: /skills add <name> <source> [--global]\n");
            return null;
        }
        const [alias, source] = positional;
        const definition: SkillDefinition = { name: alias, scope: global ? "global" : "project", source };
        const result = await rpc.call("worker.skills.add", { alias, definition }) as MutationResult;
        renderMutation(result, "added", alias, write);
        return result;
    }

    if (command === "enable" || command === "disable") {
        if (args.length !== 2 || name.length === 0) {
            write(`  usage: /skills ${command} <name>\n`);
            return null;
        }
        const result = await rpc.call(`worker.skills.${command}`, { alias: name }) as MutationResult;
        renderMutation(result, command === "enable" ? "enabled" : "disabled", name, write);
        return result;
    }

    if (command === "remove") {
        if (args.length !== 2 || name.length === 0) {
            write("  usage: /skills remove <name>\n");
            return null;
        }
        const result = await rpc.call("worker.skills.remove", { alias: name });
        write(`  removed: ${name}\n`);
        return result;
    }

    usage(write);
    return null;
};
