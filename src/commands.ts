// Interactive command reference for the terminal client ({§cli-interactive-command-discovery}).

export const INTERACTIVE_COMMANDS: readonly { readonly usage: string; readonly summary: string }[] = [
    { usage: "/help [verb]", summary: "Show the command index or one command's usage." },
    { usage: "/update", summary: "Update the model catalog and show how to update Plurnk packages." },
    { usage: "/models [search]", summary: "Search the bounded model catalog." },
    { usage: "/workspaces", summary: "List daemon workspaces." },
    { usage: "/sessions", summary: "List this workspace's sessions as a tree, each with its state." },
    { usage: "/loops", summary: "List this session's loops: each one's number and opening line." },
    { usage: "/loop [n]", summary: "Print loop n whole, or the current loop." },
    { usage: "/model [selector] [effort]", summary: "Inspect or select this session's durable model, and its effort with it." },
    { usage: "/child [selector|inherit]", summary: "Inspect or select the inherited child model." },
    { usage: "/effort [policy]", summary: "Inspect or select reasoning effort." },
    { usage: "/persona [name|none]", summary: "Inspect, select, or clear this session's persona role." },
    { usage: "/yolo", summary: "Toggle local proposal auto-accept (Shift-Tab). Off by default." },
    { usage: "/workspace [name]", summary: "Open or create a workspace." },
    { usage: "/rename <name>", summary: "Rename this workspace's mutable handle." },
    { usage: "/share <folder>", summary: "Write this workspace's share into <folder> for a bug report." },
    { usage: "/rollback <loop>/<turn>/<item>", summary: "Reverse the bound session's file mutations after a log coordinate, latest first, as your own operations." },
    { usage: "/session [name]", summary: "Show this session, or go to the named one; a new name makes a new session." },
    { usage: "/fork [name]", summary: "Fork this session into a child that keeps its history, and go there." },
    { usage: "/parent", summary: "Hop to the bound session's parent (Alt-h)." },
    { usage: "/enter", summary: "Hop into the bound session's newest child (Alt-l)." },
    { usage: "/older", summary: "Hop to the next older sibling session, wrapping (Alt-j)." },
    { usage: "/newer", summary: "Hop to the next newer sibling session, wrapping (Alt-k)." },
    { usage: "/mcp [subcommand]", summary: "List or manage this workspace's MCP servers." },
    { usage: "/skills [subcommand]", summary: "List or manage this workspace's Agent Skills." },
    { usage: "/members [subcommand]", summary: "List or manage this workspace's file members." },
    { usage: "/env [--scope session|workspace] [subcommand]", summary: "Manage session overrides or shared workspace environment defaults." },
    { usage: "/schedule [subcommand]", summary: "List or manage this workspace's scheduled messages." },
    { usage: "/personas [subcommand]", summary: "List or manage this workspace's persona roles." },
    { usage: "/import <path>", summary: "Insert a local file into the composer." },
    { usage: "/script <path>", summary: "Submit a local .plk batch of MCP expressions through op.exec." },
    { usage: "/editor", summary: "Compose the current value in $EDITOR." },
    { usage: "/review", summary: "Inspect pending proposals or questions." },
    { usage: "/approve @<id> [optionId]", summary: "Approve the identified proposal or gate (@<id> optional in Term)." },
    { usage: "/accept @<id> [optionId]", summary: "Accept the identified proposal or gate (@<id> optional in Term)." },
    { usage: "/reject @<id> [optionId]", summary: "Reject the identified proposal or gate (@<id> optional in Term)." },
    { usage: "/cancel @<id>", summary: "Cancel the identified proposal or question (@<id> optional in Term)." },
    { usage: "/edit @<id> <body...>", summary: "Edit and accept the identified proposal (@<id> optional in Term)." },
    { usage: "/answer @<id> <json>", summary: "Answer the identified elicitation or question (@<id> optional in Term)." },
    { usage: "/login", summary: "Sign in to the daemon through the browser and keep the grant." },
    { usage: "/logout", summary: "Revoke the kept grant at the daemon and forget it." },
    { usage: "/web [--no-open]", summary: "Open the Plurnk Web UI signed in via a single-use loopback handoff." },
    { usage: "/learn [--scope project|plurnk] [instructions]", summary: "Distill reusable workflow from this session into a SKILL.md." },
    { usage: "/stop", summary: "Cancel the running loop." },
    { usage: "/quit", summary: "Exit the interactive client." },
];

export type LearnResolution =
    | { readonly ok: true; readonly scope: "project" | "plurnk"; readonly prompt: string }
    | { readonly ok: false; readonly error: string };

export const resolveLearnCommand = (
    rawLine: string,
    options?: { readonly projectRoot?: string | null },
): LearnResolution | null => {
    const trimmed = rawLine.trim();
    if (trimmed !== "/learn" && !trimmed.startsWith("/learn ")) {
        return null;
    }
    const restText = trimmed.slice("/learn".length).trim();
    const tokens = restText.length > 0 ? restText.split(/\s+/u) : [];
    let explicitScope: string | undefined;
    const instructionTokens: string[] = [];
    for (let i = 0; i < tokens.length; i += 1) {
        const tok = tokens[i] ?? "";
        if (tok === "--scope") {
            const next = tokens[i + 1];
            if (next === undefined || next.startsWith("--")) {
                return { ok: false, error: "Missing /learn --scope value: expected 'project' or 'plurnk'." };
            }
            explicitScope = next;
            i += 1;
        } else if (tok.startsWith("--scope=")) {
            explicitScope = tok.slice("--scope=".length);
        } else {
            instructionTokens.push(tok);
        }
    }
    if (explicitScope !== undefined && explicitScope !== "project" && explicitScope !== "plurnk") {
        return {
            ok: false,
            error: `Invalid /learn scope '${explicitScope}': expected 'project' or 'plurnk'.`,
        };
    }
    if (explicitScope === "project" && options?.projectRoot === null) {
        return {
            ok: false,
            error: "This workspace has no project folder; use `/learn --scope plurnk` to save under $XDG_CONFIG_HOME/plurnk/skills.",
        };
    }
    const scope = explicitScope ?? (options?.projectRoot === null ? "plurnk" : "project");
    const targetPath =
        scope === "plurnk"
            ? "${XDG_CONFIG_HOME:-~/.config}/plurnk/skills/<name>/SKILL.md"
            : ".agents/skills/<name>/SKILL.md";
    const instructions = instructionTokens.join(" ");
    const basePrompt =
        `Distill reusable workflow, setup, or domain knowledge from this session into an Agent Skill at \`${targetPath}\` ` +
        "(read `mcp:///plurnk/skills.json` first, write a concise `SKILL.md` with YAML frontmatter `name` and `description`, and verify discovery with the `skills` tool).";
    return {
        ok: true,
        scope,
        prompt: instructions.length > 0 ? `${basePrompt}\n\nFocus: ${instructions}` : basePrompt,
    };
};

export const expandLearnCommand = (
    rawLine: string,
    options?: { readonly projectRoot?: string | null },
): string | null => {
    const resolved = resolveLearnCommand(rawLine, options);
    return resolved?.ok === true ? resolved.prompt : null;
};

export const renderCommandReference = (): string =>
    INTERACTIVE_COMMANDS.map(({ usage, summary }) =>
        usage.length >= 30 ? `${usage} ${summary}` : `${usage.padEnd(30, " ")} ${summary}`,
    ).join("\n");
