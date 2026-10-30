// Standalone CLI subcommands (`session`, `config`, `update`, `models`, `workspace`,
// `log read`, `read`, `capabilities`, `script`, `completion`, and family commands)
// ({§cli-subcommands}, {§cli-configuration-source}, {§cli-interactive-command-discovery}).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    SessionConfigOption,
    ToolCallContent,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { AcpClient } from "./acp-client.ts";
import { contentBlockToText } from "./acp-session.ts";
import {
    ensureDaemonConnected,
    openCliSession,
    type CliCommonOptions,
} from "./cli-runner.ts";
import {
    executeFamilyCommand,
    formatLogEntries,
    formatModelsRows,
    formatWorkspacesRows,
    writeErrorJsonl,
} from "./repl-commands.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const runCliListSessions = async (options: CliCommonOptions): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    try {
        await ensureDaemonConnected(client, options);
        const res = await client.listSessions(options.cwd);
        if (options.json) {
            process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
            return 0;
        }
        if (res.sessions.length === 0) {
            process.stdout.write("No sessions.\n");
            return 0;
        }
        for (const s of res.sessions) {
            const title = s.title ? `  ${s.title}` : "";
            const updated = s.updatedAt ? `  (${s.updatedAt})` : "";
            process.stdout.write(`${s.sessionId}\t${s.cwd}${title}${updated}\n`);
        }
        return 0;
    } finally {
        client.close();
    }
};

export const runCliNewSession = async (options: CliCommonOptions): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    try {
        await ensureDaemonConnected(client, options);
        const session = await openCliSession(client, { ...options, sessionId: undefined });
        if (options.json) {
            process.stdout.write(
                `${JSON.stringify(
                    {
                        sessionId: session.sessionId,
                        configOptions: session.configOptions,
                    },
                    null,
                    2,
                )}\n`,
            );
        } else {
            process.stdout.write(`${session.sessionId}\n`);
        }
        return 0;
    } finally {
        client.close();
    }
};

export const runCliResumeSession = async (
    sessionId: string,
    options: CliCommonOptions,
): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    try {
        await ensureDaemonConnected(client, options);
        const session = await openCliSession(client, { ...options, sessionId }, undefined, true);
        if (options.json) {
            process.stdout.write(
                `${JSON.stringify(
                    {
                        sessionId: session.sessionId,
                        state: session.state,
                        stopReason: session.stopReason,
                        configOptions: session.configOptions,
                        usage: session.usage,
                        items: session.items,
                    },
                    null,
                    2,
                )}\n`,
            );
            return 0;
        }
        for (const item of session.items) {
            switch (item.kind) {
                case "user_message":
                    process.stdout.write(`> ${item.text}\n`);
                    break;
                case "agent_thought":
                    process.stdout.write(`[thought] ${item.text}\n`);
                    break;
                case "agent_message":
                    process.stdout.write(`${item.text}\n`);
                    break;
                case "tool_call": {
                    const label = item.title ?? item.name ?? item.toolCallId;
                    process.stdout.write(`[tool:${item.status ?? "pending"}] ${label}\n`);
                    for (const c of item.content) {
                        if (ToolCallContent.isContent(c)) {
                            process.stdout.write(`  ${contentBlockToText(c.content)}\n`);
                        } else if (ToolCallContent.isDiff(c)) {
                            process.stdout.write(`  [diff]\n`);
                        }
                    }
                    break;
                }
                case "terminal":
                    process.stdout.write(`[terminal] ${item.command ?? item.terminalId}\n`);
                    if (item.outputText.length > 0) {
                        process.stdout.write(
                            item.outputText.endsWith("\n") ? item.outputText : `${item.outputText}\n`,
                        );
                    }
                    break;
                case "notice":
                    process.stdout.write(
                        `[${item.severity}] ${item.title}${item.description ? `: ${item.description}` : ""}\n`,
                    );
                    break;
                default:
                    break;
            }
        }
        return 0;
    } finally {
        client.close();
    }
};

export const runCliForkSession = async (
    sessionId: string,
    options: CliCommonOptions,
): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    try {
        await ensureDaemonConnected(client, options);
        const res = await client.forkSession(sessionId, options.cwd);
        if (options.json) {
            process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
        } else {
            process.stdout.write(`${res.sessionId}\n`);
        }
        return 0;
    } finally {
        client.close();
    }
};

export const runCliDeleteSession = async (
    sessionId: string,
    options: CliCommonOptions,
): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    try {
        await ensureDaemonConnected(client, options);
        await client.deleteSession(sessionId);
        if (options.json) {
            process.stdout.write(`${JSON.stringify({ deleted: sessionId }, null, 2)}\n`);
        } else {
            process.stdout.write(`Deleted ${sessionId}\n`);
        }
        return 0;
    } finally {
        client.close();
    }
};

export const formatConfigOption = (opt: SessionConfigOption): string => {
    if (SessionConfigOption.isBoolean(opt)) {
        return `${opt.configId} (${opt.name}): ${String(opt.currentValue)}`;
    }
    if (SessionConfigOption.isSelect(opt)) {
        const choices: string[] = [];
        for (const entry of opt.options) {
            if ("options" in entry) {
                for (const sub of entry.options) {
                    choices.push(sub.value === opt.currentValue ? `*${sub.value}` : sub.value);
                }
            } else {
                choices.push(entry.value === opt.currentValue ? `*${entry.value}` : entry.value);
            }
        }
        if (choices.length > 12) {
            return `${opt.configId} (${opt.name}): ${opt.currentValue}`;
        }
        return `${opt.configId} (${opt.name}): ${opt.currentValue} [${choices.join(", ")}]`;
    }
    return `${opt.configId} (${opt.name})`;
};

export const runCliConfig = async (
    configId: string | undefined,
    value: string | undefined,
    options: CliCommonOptions,
): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    try {
        await ensureDaemonConnected(client, options);
        const session = await openCliSession(client, {
            ...options,
            ...(configId === "persona" ? { persona: undefined } : {}),
            ...(configId === "thought_level" ? { effort: undefined } : {}),
            ...(configId === "model" ? { model: undefined } : {}),
        });
        if (configId !== undefined && value !== undefined) {
            const existing = session.configOptions.find((o) => o.configId === configId);
            const parsedValue =
                existing !== undefined && SessionConfigOption.isBoolean(existing)
                    ? value === "true" || value === "1" || value === "on"
                    : value;
            const res = await client.setConfigOption(session.sessionId, configId, parsedValue);
            session.configOptions = [...res.configOptions];
        }
        if (options.json) {
            process.stdout.write(
                `${JSON.stringify(
                    {
                        sessionId: session.sessionId,
                        configOptions: session.configOptions,
                    },
                    null,
                    2,
                )}\n`,
            );
            return 0;
        }
        for (const opt of session.configOptions) {
            if (configId === undefined || opt.configId === configId) {
                process.stdout.write(`${formatConfigOption(opt)}\n`);
            }
        }
        return 0;
    } finally {
        client.close();
    }
};

export const formatServiceUpdateResult = (res: Record<string, unknown>): string => {
    const cat = (res.catalog ?? {}) as Record<string, unknown>;
    const svc = (res.service ?? {}) as Record<string, unknown>;
    const added =
        typeof cat.addedModels === "number" && cat.addedModels > 0
            ? `, +${String(cat.addedModels)} new`
            : "";
    const catLine = `catalog: ${String(cat.status ?? "updated")} (${String(cat.models ?? 0)} models across ${String(cat.providers ?? 0)} providers${added})`;
    const pkg = String(svc.package ?? "@plurnk/plurnk-service");
    const ver = String(svc.version ?? "");
    const suffix = svc.artifact === "source" ? " (source checkout)" : "";
    const upgradeCmd =
        typeof svc.upgradeCommand === "string"
            ? svc.upgradeCommand
            : "npm install -g --ignore-scripts @plurnk/plurnk-service@latest @plurnk/plurnk@latest";
    const verLine = `version: ${pkg}@${ver}${suffix} — to update packages, stop the daemon and run: ${upgradeCmd}`;
    return `${catLine}\n${verLine}`;
};

export const runCliUpdate = async (options: CliCommonOptions): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    try {
        await ensureDaemonConnected(client, options);
        const result = await client.action<Record<string, unknown>>("service.update", {});
        if (options.json) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
            process.stdout.write(`${formatServiceUpdateResult(result)}\n`);
        }
        return 0;
    } finally {
        client.close();
    }
};

export const runCliModels = async (
    searchTerms: readonly string[],
    query: {
        readonly provider?: string;
        readonly all?: boolean;
        readonly offset?: number;
        readonly limit?: number;
    },
    options: CliCommonOptions,
): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    try {
        await ensureDaemonConnected(client, options);
        const result = await client.action<Record<string, unknown>>("models.list", {
            ...(searchTerms.length > 0 ? { search: searchTerms.join(" ") } : {}),
            ...(query.provider !== undefined ? { provider: query.provider } : {}),
            ...(query.all !== undefined ? { all: query.all } : {}),
            ...(query.offset !== undefined ? { offset: query.offset } : {}),
            ...(query.limit !== undefined ? { limit: query.limit } : {}),
        });
        if (options.json) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            return 0;
        }
        process.stdout.write(formatModelsRows(result));
        return 0;
    } finally {
        client.close();
    }
};

export const runCliWorkspace = async (
    sub: string | undefined,
    arg1: string | undefined,
    arg2: string | undefined,
    options: CliCommonOptions,
): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    try {
        await ensureDaemonConnected(client, options);
        if (sub === "list" || sub === undefined) {
            const result = await client.action<Record<string, unknown>>("workspace.list", {});
            if (options.json) {
                process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
                return 0;
            }
            process.stdout.write(formatWorkspacesRows(result));
            return 0;
        }
        if (sub === "sessions") {
            const wsName = arg1 ?? options.workspace;
            const result = await client.action("workspace.sessions", {}, { workspace: wsName });
            if (options.json) {
                process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
                return 0;
            }
            const rec = result as Record<string, unknown>;
            const sessions = Array.isArray(rec.sessions) ? rec.sessions : [];
            for (const s of sessions) {
                const r = s as Record<string, unknown>;
                process.stdout.write(`${String(r.name)}\t${String(r.lifecycle ?? "idle")}\n`);
            }
            return 0;
        }
        if (sub === "rename") {
            if (!arg1 || !arg2) {
                process.stderr.write("plurnk workspace rename requires <name> <newname>.\n");
                return 64;
            }
            const result = await client.action(
                "workspace.rename",
                { from: arg1, name: arg2 },
                { workspace: arg1 },
            );
            if (options.json) {
                process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            } else {
                process.stdout.write(`${arg2}\n`);
            }
            return 0;
        }
        process.stderr.write(`Unknown workspace subcommand: ${sub}\n`);
        return 64;
    } finally {
        client.close();
    }
};

export const runCliLogRead = async (
    filters: {
        readonly loopId?: number;
        readonly turnId?: number;
        readonly sinceId?: number;
        readonly limit?: number;
    },
    options: CliCommonOptions,
): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    try {
        await ensureDaemonConnected(client, options);
        const result = await client.action<{ readonly entries?: unknown[] }>(
            "log.read",
            {
                ...(filters.loopId !== undefined ? { loopId: filters.loopId } : {}),
                ...(filters.turnId !== undefined ? { turnId: filters.turnId } : {}),
                ...(filters.sinceId !== undefined ? { sinceId: filters.sinceId } : {}),
                limit: filters.limit ?? 100,
            },
            {
                workspace: options.workspace,
                session: options.sessionId ?? options.tuiSession,
                cwd: options.cwd,
            },
        );
        if (options.json) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            return 0;
        }
        process.stdout.write(formatLogEntries(Array.isArray(result.entries) ? result.entries : []));
        return 0;
    } finally {
        client.close();
    }
};

export const runCliReadCoord = async (coord: string, options: CliCommonOptions): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    try {
        await ensureDaemonConnected(client, options);
        const target = coord.includes("://") ? coord : `log:///${coord}`;
        const result = await client.action(
            "entry.read",
            { target },
            {
                workspace: options.workspace,
                session: options.sessionId ?? options.tuiSession,
                cwd: options.cwd,
            },
        );
        if (options.json) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            return 0;
        }
        const rec = result as Record<string, unknown>;
        const entry = rec.entry as Record<string, unknown> | undefined;
        const channels = (entry?.channels ?? {}) as Record<string, { readonly content?: string }>;
        const body =
            channels.body?.content ?? channels.stdout?.content ?? JSON.stringify(result, null, 2);
        process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
        return 0;
    } finally {
        client.close();
    }
};

export const runCliCapabilities = async (
    policyJson: string | undefined,
    options: CliCommonOptions,
): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    try {
        await ensureDaemonConnected(client, options);
        const result =
            policyJson !== undefined
                ? await client.action(
                      "workspace.capabilities.set",
                      { policy: JSON.parse(policyJson) as unknown },
                      { workspace: options.workspace, cwd: options.cwd },
                  )
                : await client.action(
                      "workspace.capabilities.get",
                      {},
                      { workspace: options.workspace, cwd: options.cwd },
                  );
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return 0;
    } finally {
        client.close();
    }
};

export const runCliScript = async (filePath: string, options: CliCommonOptions): Promise<number> => {
    const text = readFileSync(resolve(options.cwd, filePath), "utf8");
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    try {
        await ensureDaemonConnected(client, options);
        const res = await client.action<{
            readonly results?: Array<{
                readonly status?: number;
                readonly content?: string;
                readonly message?: string;
            }>;
        }>(
            "op.parse",
            { text },
            {
                workspace: options.workspace,
                session: options.sessionId ?? options.tuiSession,
                cwd: options.cwd,
            },
        );
        if (options.json) {
            process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
        } else {
            for (const r of res.results ?? []) {
                const line = r.content ?? r.message ?? String(r.status ?? 200);
                process.stdout.write(line.endsWith("\n") ? line : `${line}\n`);
            }
        }
        const worst = Math.max(200, ...(res.results ?? []).map((r) => r.status ?? 200));
        return worst >= 400 ? 4 : 0;
    } finally {
        client.close();
    }
};

export const runCliCompletion = (shell: string | undefined): number => {
    const map: Record<string, string> = {
        bash: "dist/posix/completions/plurnk.bash",
        zsh: "dist/posix/completions/_plurnk",
        fish: "dist/posix/completions/plurnk.fish",
    };
    const rel = shell !== undefined ? map[shell] : undefined;
    if (rel === undefined) {
        process.stderr.write("usage: plurnk completion <bash|zsh|fish>\n");
        return 64;
    }
    const content = readFileSync(resolve(ROOT, rel), "utf8");
    process.stdout.write(content);
    return 0;
};

export const runCliFamily = async (
    family: string,
    familyArgs: readonly string[],
    options: CliCommonOptions,
): Promise<number> => {
    if (familyArgs.includes("--help") || familyArgs.includes("-h")) {
        const extra = family === "mcp" ? "|oauth" : family === "env" ? "|import" : "";
        process.stdout.write(
            `usage: plurnk ${family} [list|discover|add|replace|enable|disable|remove${extra}] [options]\n`,
        );
        return 0;
    }
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    try {
        await ensureDaemonConnected(client, options);
        const session = await openCliSession(client, {
            ...options,
            sessionId: options.sessionId ?? options.tuiSession,
        });
        let hadError = false;
        await executeFamilyCommand(
            client,
            family,
            familyArgs,
            {
                sessionId: session.sessionId,
                workspace: options.workspace,
                session: options.sessionId ?? options.tuiSession,
                cwd: options.cwd,
            },
            options.cwd,
            {
                json: options.json,
                stdout: process.stdout,
                onError: (problem) => {
                    hadError = true;
                    writeErrorJsonl(process.stderr, problem);
                },
            },
        );
        return hadError ? 64 : 0;
    } finally {
        client.close();
    }
};
