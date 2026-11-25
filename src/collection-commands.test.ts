import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import type { AcpClient } from "./acp-client.ts";
import {
    COLLECTION_PAGE_SIZE,
    formatDiscoverPageFooter,
    formatListPageFooter,
    parseFamilyDiscoverArgs,
    parseFamilyListArgs,
    parseModelsArgs,
} from "./collection-commands.ts";
import { executeFamilyCommand, formatModelsRows } from "./repl-commands.ts";
import { dispatchSlashCommand, type ReplSlashCommandContext } from "./repl-slash-commands.ts";
import { parseScheduleCommand } from "./schedule-command.ts";
import { completeInput } from "./term-completion.ts";

const makeBufferStream = (): { readonly stream: Writable; read: () => string } => {
    const chunks: string[] = [];
    const stream = new Writable({
        write(chunk, _enc, cb) {
            chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
            cb();
        },
    });
    return { stream, read: () => chunks.join("") };
};

test("{§cli-configuration-source} {§cli-subcommands} collection browsing parsers support filter, offset/limit, cursor pagination, and models default limit 10", () => {
    assert.equal(COLLECTION_PAGE_SIZE, 10);
    assert.deepEqual(parseFamilyListArgs(["git", "--state", "active", "--origin=workspace", "--offset", "10", "--limit", "10"]), {
        query: "git",
        state: "active",
        origin: "workspace",
        offset: 10,
        limit: 10,
    });
    assert.throws(() => parseFamilyListArgs(["--state", "bogus"]), /Invalid --state/u);
    assert.throws(() => parseFamilyListArgs(["--limit", "101"]), /--limit/u);

    assert.deepEqual(parseFamilyDiscoverArgs("mcp", ["--limit", "10", "--cursor", "c2"]), {
        cursor: "c2",
        limit: 10,
    });
    assert.deepEqual(parseFamilyDiscoverArgs("skills", ["https://git.example/skills.git", "--query", "sql", "--limit", "10"]), {
        source: "https://git.example/skills.git",
        query: "sql",
        limit: 10,
    });
    assert.deepEqual(parseFamilyDiscoverArgs("env", ["--query", "PORT", "--source", "defaults", "--limit", "5"]), {
        query: "PORT",
        source: "defaults",
        limit: 5,
    });
    assert.deepEqual(parseScheduleCommand(["--state", "disabled", "--limit", "10"]), {
        kind: "action",
        sub: "list",
        actionName: "workspace.schedule.list",
        params: { state: "disabled", limit: 10 },
    });
    assert.deepEqual(parseScheduleCommand(["discover", "0 9 * * *", "--limit", "5"]), {
        kind: "action",
        sub: "discover",
        actionName: "workspace.schedule.discover",
        params: { rule: "0 9 * * *", limit: 5 },
    });

    assert.deepEqual(parseModelsArgs([]), { limit: 10 });
    assert.deepEqual(parseModelsArgs(["claude", "--provider", "anthropic", "--all", "--offset", "20", "--limit", "25"]), {
        search: "claude",
        provider: "anthropic",
        all: true,
        offset: 20,
        limit: 25,
    });

    assert.equal(formatListPageFooter({ definitions: [{}, {}], offset: 0, total: 2 }), null);
    assert.equal(
        formatListPageFooter({ definitions: [{}, {}], offset: 0, total: 12, nextOffset: 2 }),
        "Showing 1–2 of 12 (next: --offset 2)",
    );
    assert.equal(
        formatDiscoverPageFooter({ candidates: [{}], total: 20, nextCursor: "offset:1" }),
        "Showing 1 of 20 (next: --cursor offset:1)",
    );
    assert.equal(
        formatDiscoverPageFooter({ candidates: [{}], nextCursor: "reg-2" }),
        "Showing 1 (next: --cursor reg-2)",
    );
    assert.match(
        formatModelsRows({
            offset: 10,
            total: 12,
            items: [{ selector: "openai/gpt-5", modelName: "GPT-5", limits: { contextTokens: 128000 }, capabilities: {} }],
        }),
        /\(showing 11-11 of 12\)/u,
    );
});

test("{§cli-configuration-source} {§cli-subcommands} executeFamilyCommand and /models dispatch filter, cursor pagination, and default limit 10", async () => {
    const calls: Array<{ kind: string; params: Record<string, unknown> }> = [];
    const client = {
        action: async (kind: string, params: Record<string, unknown>) => {
            calls.push({ kind, params });
            if (kind === "workspace.mcp.list") {
                return {
                    family: "mcp",
                    definitions: [{ alias: "gitea", state: "active", origin: "workspace", definition: {} }],
                    offset: 0,
                    total: 15,
                    nextOffset: 1,
                };
            }
            if (kind === "workspace.mcp.discover") {
                return {
                    family: "mcp",
                    candidates: [{ alias: "github", summary: "GitHub MCP", definition: { type: "streamable-http", url: "https://example.com" } }],
                    nextCursor: "next-page",
                };
            }
            if (kind === "models.list") {
                return {
                    offset: Number(params.offset ?? 0),
                    total: 15,
                    nextOffset: 10,
                    items: [{ selector: "anthropic/claude-sonnet-4", modelName: "Claude Sonnet 4", limits: { contextTokens: 200000 }, capabilities: {} }],
                };
            }
            return {};
        },
    } as unknown as AcpClient;

    const listOut = makeBufferStream();
    let errorCount = 0;
    await executeFamilyCommand(client, "mcp", ["--query", "git", "--state", "active", "--limit", "1"], { workspace: "alpha" }, "/tmp", {
        stdout: listOut.stream,
        onError: () => { errorCount += 1; },
    });
    assert.equal(errorCount, 0);
    assert.deepEqual(calls[0], { kind: "workspace.mcp.list", params: { query: "git", state: "active", limit: 1 } });
    assert.match(listOut.read(), /Showing 1–1 of 15 \(next: --offset 1\)/u);

    const discOut = makeBufferStream();
    await executeFamilyCommand(client, "mcp", ["discover", "--limit", "10"], { workspace: "alpha" }, "/tmp", {
        stdout: discOut.stream,
        onError: () => { errorCount += 1; },
    });
    assert.deepEqual(calls[1], { kind: "workspace.mcp.discover", params: { limit: 10 } });
    assert.match(discOut.read(), /Showing 1 \(next: --cursor next-page\)/u);

    // Usage errors report via onError without throwing
    await executeFamilyCommand(client, "mcp", ["list", "--state", "nope"], { workspace: "alpha" }, "/tmp", {
        stdout: makeBufferStream().stream,
        onError: () => { errorCount += 1; },
    });
    assert.equal(errorCount, 1);

    const slashOut = makeBufferStream();
    const slashErr = makeBufferStream();
    await dispatchSlashCommand("/models claude --provider anthropic --offset 0", {
        client,
        options: { cwd: "/tmp", url: "ws://127.0.0.1:1066/acp", env: {}, oauthTimeoutMs: 5000 } as never,
        streams: {
            stdin: process.stdin,
            stdout: slashOut.stream,
            stderr: slashErr.stream,
            events: makeBufferStream().stream,
            reasoning: makeBufferStream().stream,
        },
        hasCustomEventsStream: false,
        pendingGates: new Map(),
        getSession: () => ({ sessionId: "1#s1", availableCommands: [], configOptions: [] }) as never,
        setSession: () => {},
        getWorkspace: () => "alpha",
        setWorkspace: () => {},
        getSessionName: () => "s1",
        getProjectRoot: () => "/tmp",
        getLifecycle: () => "idle",
        getYolo: () => false,
        setYolo: () => {},
        clearForceReviewNextRun: () => {},
        getStagedComposerText: () => "",
        setStagedComposerText: () => {},
        beginLocalOAuth: () => ({ signal: new AbortController().signal, finish: () => {} }),
        bindSession: async () => ({}) as never,
        adoptForkedSession: async () => ({}) as never,
        emitSessionBound: () => {},
        dispatchLine: async () => "continue",
    } as unknown as ReplSlashCommandContext);
    assert.equal(slashErr.read(), "");
    assert.deepEqual(calls[2], { kind: "models.list", params: { search: "claude", provider: "anthropic", offset: 0, limit: 10 } });
    assert.match(slashOut.read(), /showing 1-1 of 15; next --offset 10/u);
});

test("{§cli-interactive-command-discovery} completeInput suggests list, discover, state/origin, and /models flags without breaking selector completion", async () => {
    const ctx = {
        cwd: "/tmp",
        getProjectRoot: () => "/tmp",
        getModels: () => ["anthropic/claude-sonnet-4", "openai/gpt-5"],
    };
    const listFlags = await completeInput("/mcp list --", ctx);
    assert.deepEqual(
        listFlags.suggestions.map((s) => s.value),
        ["--query", "--state", "--origin", "--offset", "--limit"],
    );
    const stateVals = await completeInput("/mcp list --state d", ctx);
    assert.deepEqual(stateVals.suggestions.map((s) => s.value), ["dormant", "disabled"]);
    const originVals = await completeInput("/env --scope workspace list --origin w", ctx);
    assert.deepEqual(originVals.suggestions.map((s) => s.value), ["workspace"]);
    const skillDiscFlags = await completeInput("/skills discover /dir --", ctx);
    assert.deepEqual(
        skillDiscFlags.suggestions.map((s) => s.value),
        ["--source", "--query", "--cursor", "--limit"],
    );
    const modelsFlags = await completeInput("/models --", ctx);
    assert.deepEqual(
        modelsFlags.suggestions.map((s) => s.value),
        ["--provider", "--all", "--offset", "--limit"],
    );
    const modelSelectors = await completeInput("/models ", ctx);
    assert.deepEqual(
        modelSelectors.suggestions.map((s) => s.value),
        ["anthropic/claude-sonnet-4", "openai/gpt-5"],
    );
});
