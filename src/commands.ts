import { PLURNK_FENCE } from "@plurnk/plurnk-contracts";
export const COMMAND_GROUPS = [
    { id: "inspect", label: "inspect" },
    { id: "policy", label: "policy" },
    { id: "workspace", label: "workspace" },
    { id: "functionality", label: "functionality" },
    { id: "compose", label: "compose" },
    { id: "review", label: "review" },
    { id: "session", label: "session" },
] as const;

export type CommandGroup = typeof COMMAND_GROUPS[number]["id"];
export type FunctionalityFamily = "mcp" | "skills" | "a2a" | "members" | "env" | "schedule";

// Default action prefixes. Env also accepts an explicit workspace scope.
export const FAMILY_ACTIONS: Readonly<Record<FunctionalityFamily, string>> = Object.freeze({
    mcp: "workspace.mcp", skills: "workspace.skills", a2a: "workspace.a2a", members: "workspace.members", env: "worker.env", schedule: "workspace.schedule",
});

export interface CommandSubcommand {
    name: string;
    usage: string;
    summary: string;
    alias: boolean;
}

export interface CommandSpec {
    name: string;
    usage: string;
    summary: string;
    group: CommandGroup;
    rebinds?: boolean;
    subcommands?: readonly CommandSubcommand[];
}

const lifecycle = (noun: string, discover: CommandSubcommand, add: CommandSubcommand): readonly CommandSubcommand[] => [
    discover,
    add,
    { name: "enable", usage: `enable <${noun}>`, summary: `Enable a current ${noun}.`, alias: true },
    { name: "disable", usage: `disable <${noun}>`, summary: `Disable a current ${noun}.`, alias: true },
    { name: "remove", usage: `remove <${noun}>`, summary: `Remove a current ${noun}.`, alias: true },
];

const MCP_SUBCOMMANDS = [
    { name: "discover", usage: "discover <url|command>", summary: "Inspect one MCP source without adding it.", alias: false },
    { name: "add", usage: "add <alias> <target> [options.json]", summary: "Add and enable an MCP server.", alias: false },
    { name: "enable", usage: "enable <alias> [options.json]", summary: "Enable or specialize a current MCP server.", alias: true },
    { name: "disable", usage: "disable <alias>", summary: "Disable a current MCP server.", alias: true },
    { name: "remove", usage: "remove <alias>", summary: "Remove a current MCP server.", alias: true },
    { name: "oauth", usage: "oauth <alias> <callback-url>", summary: "Complete authorization for an MCP server.", alias: true },
] as const;

const SKILL_SUBCOMMANDS = lifecycle(
    "name",
    { name: "discover", usage: "discover <query|source>", summary: "Search or inspect an Agent Skill source.", alias: false },
    { name: "add", usage: "add <name> <source> [--global]", summary: "Install and enable an Agent Skill.", alias: false },
);

const AGENT_SUBCOMMANDS = lifecycle(
    "alias",
    { name: "discover", usage: "discover <url>", summary: "Inspect one A2A Agent Card without adding it.", alias: false },
    { name: "add", usage: "add <alias> <url> [options.json]", summary: "Add and enable an outbound A2A agent.", alias: false },
);

const MEMBERS_SUBCOMMANDS = lifecycle(
    "alias",
    { name: "discover", usage: "discover <path|glob>", summary: "Explain a file's visibility, or preview what a glob would include or exclude.", alias: false },
    { name: "add", usage: "add <alias> <glob>", summary: "Add and enable a members glob; a leading ! excludes.", alias: false },
);

const ENV_SUBCOMMANDS = lifecycle(
    "name",
    { name: "discover", usage: "discover [query]", summary: "List the names you may set, with their owning package; a query matches a name or its comment.", alias: false },
    { name: "add", usage: "add <NAME> <value>", summary: "Set a variable in the selected scope; the value is used verbatim.", alias: false },
);

const SCHEDULE_SUBCOMMANDS = lifecycle(
    "alias",
    { name: "discover", usage: "discover <rule>", summary: "Read the time and preview a rule's occurrences without adding it.", alias: false },
    { name: "add", usage: "add [--accept] <alias> <worker> <rule> <prompt...>", summary: "Add and arm a rule that delivers the prompt to a worker at each occurrence.", alias: false },
);

export const COMMANDS = [
    { name: "help", usage: "/help [verb]", summary: "Show the command index or one command's usage.", group: "inspect" },
    { name: "models", usage: "/models [search]", summary: "Search the bounded model catalog.", group: "inspect" },
    { name: "workspaces", usage: "/workspaces", summary: "List daemon workspaces.", group: "inspect" },
    { name: "workers", usage: "/workers", summary: "List this workspace's workers as a topology rooted at the bound worker.", group: "inspect" },
    { name: "log", usage: "/log [limit]", summary: "Read recent log entries.", group: "inspect" },
    { name: "look", usage: "/look <address> [scope] [pattern]", summary: "Inspect a resource for yourself: no loop, no log entry, no wait on the model.", group: "inspect" },

    { name: "model", usage: "/model [selector]", summary: "Inspect or select this worker's durable model.", group: "policy" },
    { name: "child", usage: "/child [selector|inherit]", summary: "Inspect or select the inherited child model.", group: "policy" },
    { name: "effort", usage: "/effort [policy]", summary: "Inspect or select reasoning effort.", group: "policy" },
    { name: "capabilities", usage: "/capabilities [json]", summary: "Inspect the capability cascade or set the workspace policy.", group: "policy" },
    { name: "yolo", usage: "/yolo", summary: "Toggle local proposal auto-accept (Shift-Tab). Off ships.", group: "policy" },

    { name: "workspace", usage: "/workspace [name]", summary: "Create and enter a fresh workspace.", group: "workspace", rebinds: true },
    { name: "rename", usage: "/rename <name>", summary: "Rename this workspace's mutable handle.", group: "workspace", rebinds: true },
    { name: "share", usage: "/share <folder>", summary: "Write this workspace's share for a bug report: <folder> and <folder>.zip.", group: "workspace" },
    { name: "worker", usage: "/worker [name]", summary: "Fork and enter a new worker.", group: "workspace", rebinds: true },
    { name: "attach", usage: "/attach <name>", summary: "Bind this session to a worker by name; a new name mints a fresh conversation.", group: "workspace", rebinds: true },
    { name: "parent", usage: "/parent", summary: "Hop to the bound worker's parent (Alt-h).", group: "workspace", rebinds: true },
    { name: "enter", usage: "/enter", summary: "Hop into the bound worker's newest child (Alt-l).", group: "workspace", rebinds: true },
    { name: "older", usage: "/older", summary: "Hop to the next older sibling worker, wrapping (Alt-j).", group: "workspace", rebinds: true },
    { name: "newer", usage: "/newer", summary: "Hop to the next newer sibling worker, wrapping (Alt-k).", group: "workspace", rebinds: true },

    { name: "mcp", usage: "/mcp [subcommand]", summary: "List or manage this workspace's MCP servers.", group: "functionality", subcommands: MCP_SUBCOMMANDS },
    { name: "skills", usage: "/skills [subcommand]", summary: "List or manage this workspace's Agent Skills.", group: "functionality", subcommands: SKILL_SUBCOMMANDS },
    { name: "a2a", usage: "/a2a [subcommand]", summary: "List or manage this workspace's outbound A2A agents.", group: "functionality", subcommands: AGENT_SUBCOMMANDS },
    { name: "members", usage: "/members [subcommand]", summary: "List or manage this workspace's file members.", group: "functionality", subcommands: MEMBERS_SUBCOMMANDS },
    { name: "env", usage: "/env [--scope worker|workspace] [subcommand]", summary: "Manage worker overrides or shared workspace environment defaults.", group: "functionality", subcommands: ENV_SUBCOMMANDS },
    { name: "schedule", usage: "/schedule [subcommand]", summary: "List or manage this workspace's scheduled messages.", group: "functionality", subcommands: SCHEDULE_SUBCOMMANDS },

    { name: "import", usage: "/import <path>", summary: "Insert a local file into the composer.", group: "compose" },
    { name: "script", usage: "/script <path>", summary: "Submit a local .plk program through op.parse.", group: "compose" },
    { name: "editor", usage: "/editor", summary: "Compose the current value in $EDITOR.", group: "compose" },

    { name: "accept", usage: "/accept", summary: "Accept the pending proposal.", group: "review" },
    { name: "reject", usage: "/reject", summary: "Reject the pending proposal.", group: "review" },
    { name: "cancel", usage: "/cancel", summary: "Cancel the pending proposal.", group: "review" },
    { name: "edit", usage: "/edit", summary: "Edit and resolve the pending proposal.", group: "review" },

    { name: "stop", usage: "/stop", summary: "Cancel the running loop.", group: "session" },
    { name: "quit", usage: "/quit", summary: "Exit the interactive client.", group: "session" },
] as const satisfies readonly CommandSpec[];

export type CommandName = typeof COMMANDS[number]["name"];

const BY_NAME = new Map<string, CommandSpec>(COMMANDS.map((command) => [command.name, command]));

export const commandSpec = (name: string): CommandSpec | undefined => BY_NAME.get(name);

export const isCommandName = (name: string): name is CommandName => BY_NAME.has(name);

export const commandUsage = (name: CommandName, subcommand?: string): string => {
    const command = BY_NAME.get(name) as CommandSpec;
    if (subcommand === undefined) return command.usage;
    const nested = command.subcommands?.find(({ name: candidate }) => candidate === subcommand);
    if (nested === undefined) return command.usage;
    return `/${name} ${nested.usage}`;
};

export interface CommandSuggestion {
    value: string;
    description: string;
}

export type CommandCompletion =
    | { kind: "syntax"; prefix: string; suggestions: CommandSuggestion[] }
    | { kind: "aliases"; family: FunctionalityFamily; prefix: string; scope?: "worker" | "workspace" }
    | null;

const matchingCommands = (prefix: string, slash: boolean): CommandSuggestion[] => COMMANDS
    .filter(({ name }) => name.startsWith(prefix))
    .map(({ name, summary }) => ({ value: `${slash ? "/" : ""}${name}`, description: summary }));

export const completeCommandSyntax = (line: string): CommandCompletion => {
    const scoped = /^\/env\s+--scope(?:=|\s+)(worker|workspace)(?:\s+(.*))?$/u.exec(line);
    if (scoped !== null) line = `/env ${scoped[2] ?? ""}`;
    const root = /^\/(\w*)$/u.exec(line);
    if (root !== null) return { kind: "syntax", prefix: line, suggestions: matchingCommands(root[1], true) };

    const help = /^\/help\s+(\w*)$/u.exec(line);
    if (help !== null) return { kind: "syntax", prefix: help[1], suggestions: matchingCommands(help[1], false) };

    const nested = /^\/(mcp|skills|a2a|members|env|schedule)\s+(\w*)$/u.exec(line);
    if (nested !== null) {
        const spec = commandSpec(nested[1]);
        const suggestions = (spec?.subcommands ?? [])
            .filter(({ name }) => name.startsWith(nested[2]))
            .map(({ name, summary }) => ({ value: name, description: summary }));
        return { kind: "syntax", prefix: nested[2], suggestions };
    }

    const alias = /^\/(mcp|skills|a2a|members|env|schedule)\s+(\w+)\s+(\S*)$/u.exec(line);
    if (alias !== null) {
        const subcommand = commandSpec(alias[1])?.subcommands?.find(({ name }) => name === alias[2]);
        if (subcommand?.alias === true) {
            return { kind: "aliases", family: alias[1] as FunctionalityFamily, prefix: alias[3], ...(scoped === null ? {} : { scope: scoped[1] as "worker" | "workspace" }) };
        }
    }
    return null;
};

export const renderCommandHelp = (name: string = ""): string => {
    if (name.length > 0) {
        const command = commandSpec(name.replace(/^\//u, ""));
        if (command === undefined) return `  unknown command ${JSON.stringify(name)}; use /help for the command index\n`;
        const subcommands = (command.subcommands ?? [])
            .map(({ usage, summary }) => `  /${command.name} ${usage}\n      ${summary}`)
            .join("\n");
        return `  ${command.usage}\n      ${command.summary}${subcommands.length > 0 ? `\n${subcommands}` : ""}\n`;
    }

    const groups = COMMAND_GROUPS.map(({ id, label }) => {
        const names = COMMANDS.filter(({ group }) => group === id).map(({ name }) => `/${name}`).join(" ");
        return `  ${label.padEnd(15)}${names}`;
    });
    return [
        ...groups,
        `  language     ${PLURNK_FENCE}OP · ${PLURNK_FENCE}NOTE · ${PLURNK_FENCE}WAIT · ${PLURNK_FENCE}SEND · ${PLURNK_FENCE}LOOK · ! command · ? ask · ... steer`,
        "  keys         Shift-Enter/Ctrl-J newline · Enter submit · Esc cancel/clear · Alt-? help",
        "  tree         Alt-h parent · Alt-l newest child · Alt-j/Alt-k next/prev sibling — the prompt then speaks to that worker",
        "  /help <verb> for exact usage",
        "",
    ].join("\n");
};

export const renderCommandReference = (): string => COMMANDS
    .map(({ usage, summary }) => `${usage.padEnd(30)} ${summary}`)
    .join("\n");
