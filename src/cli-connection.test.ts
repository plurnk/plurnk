// Unit coverage for cli-connection, cli-permission, cli-runner, acp-client-transport,
// presenter-formatters, and credential edge cases ({§cli-invocation}, {§cli-workspaces-and-sessions},
// {§cli-inline-review}, {§cli-output-channels}, {§cli-rendering}, {§cli-problems-and-notices}).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { createNodeHttpHandler } from "@agentclientprotocol/sdk/experimental/node";
import { AcpServer } from "@agentclientprotocol/sdk/experimental/server";
import {
    agent as createAcpAgent,
    methods,
    PROTOCOL_VERSION,
    RequestError,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    hydrateSessionUpdate,
    normalizeAcpUrl,
    scrubAcpMeta,
    toAcpWebSocketUrl,
    wrapStreamWithMetaScrubber,
} from "./acp-client-transport.ts";
import { AcpClient } from "./acp-client.ts";
import {
    ClientCliError,
    ensureDaemonConnected,
    nextSequentialName,
    openCliSession,
    resolveServiceCommand,
    type CliCommonOptions,
} from "./cli-connection.ts";
import {
    createCliElicitationHandler,
    createCliPermissionHandler,
    formatProposalDiffPreview,
    matchesRuntimeAcceptance,
} from "./cli-permission.ts";
import { runCliPrompt, runInteractiveSession } from "./cli-runner.ts";
import Credential, { toHttpOrigin } from "./credential.ts";
import {
    abbreviatedCount,
    extractMessageActor,
    extractToolFields,
    formatActiveOperationLead,
    lifecycleGlyphFor,
    operationGlyphFor,
    receiptCountFor,
} from "./presenter-formatters.ts";

test("{§cli-invocation} {§cli-workspaces-and-sessions}: resolveServiceCommand, nextSequentialName, ensureDaemonConnected, and openCliSession handle edge cases", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "plurnk-conn-test-"));
    try {
        const jsCmd = resolveServiceCommand(join(tmpDir, "svc.mjs"), ["status"]);
        assert.equal(jsCmd.file, process.execPath);
        assert.equal(jsCmd.args[1], "status");
        const binCmd = resolveServiceCommand("/usr/local/bin/plurnk-service", ["stop"]);
        assert.equal(binCmd.file, "/usr/local/bin/plurnk-service");
        assert.deepEqual(binCmd.args, ["stop"]);

        assert.equal(nextSequentialName("workspace", ["workspace1", "workspace3", "other"]), "workspace4");
        assert.equal(nextSequentialName("session", []), "session1");

        const baseOpts: CliCommonOptions = {
            url: "http://127.0.0.1:0/acp",
            explicitAcpUrl: false,
            host: "127.0.0.1",
            port: 0,
            credential: new Credential({ HOME: tmpDir, XDG_STATE_HOME: tmpDir }),
            env: { HOME: tmpDir, XDG_STATE_HOME: tmpDir, PATH: "" },
            cwd: tmpDir,
            termSession: "session1",
            autostart: true,
            daemonTimeoutMs: 350,
            oauthTimeoutMs: 1000,
            cancelGraceMs: 200,
            serviceBin: join(tmpDir, "missing-bin"),
            yolo: true,
            auto: false,
            bell: false,
            json: false,
            interactive: true,
            previewLines: 4,
            historyEntries: 10,
            mermaidTimeoutMs: 1000,
            color: "never",
        };

        // Port 0 + missing serviceBin -> not-installed (127)
        await assert.rejects(
            () => ensureDaemonConnected({ connect: async () => ({}) } as unknown as AcpClient, baseOpts),
            (err: unknown) => err instanceof ClientCliError && err.exitCode === 127,
        );

        // Port 0 + existing serviceBin -> port-unshareable (64)
        const existingBin = join(tmpDir, "svc.js");
        writeFileSync(existingBin, "// noop\n", "utf8");
        await assert.rejects(
            () =>
                ensureDaemonConnected(
                    { connect: async () => ({}) } as unknown as AcpClient,
                    { ...baseOpts, serviceBin: existingBin },
                ),
            (err: unknown) => err instanceof ClientCliError && err.exitCode === 64,
        );

        // 503 service-starting retry succeeds on second attempt
        let connectAttempts = 0;
        await ensureDaemonConnected(
            {
                connect: async () => {
                    connectAttempts += 1;
                    if (connectAttempts === 1) {
                        throw Object.assign(new Error("503 service-starting"), { status: 503 });
                    }
                    return {};
                },
            } as unknown as AcpClient,
            { ...baseOpts, port: 54321, autostart: false },
        );
        assert.equal(connectAttempts, 2);

        // Autostart spawns serviceBin and succeeds on subsequent connect poll
        let autostartConnects = 0;
        await ensureDaemonConnected(
            {
                connect: async () => {
                    autostartConnects += 1;
                    if (autostartConnects === 1) {
                        throw new Error("ECONNREFUSED");
                    }
                    return {};
                },
            } as unknown as AcpClient,
            { ...baseOpts, port: 54322, autostart: true, serviceBin: existingBin },
        );
        assert.equal(autostartConnects, 2);

        // Connection refused when autostart is false
        await assert.rejects(
            () =>
                ensureDaemonConnected(
                    {
                        connect: async () => {
                            throw new Error("fetch failed: ECONNREFUSED");
                        },
                    } as unknown as AcpClient,
                    { ...baseOpts, port: 54321, autostart: false },
                ),
            (err: unknown) =>
                err instanceof ClientCliError &&
                err.problem.type === "https://problems.plurnk.xyz/client/connection/refused",
        );

        // openCliSession: headless workspace1 allocation, 409 conflict retry -> workspace2, initial config + env
        let newSessionCalls = 0;
        const setConfigCalls: Array<[string, unknown]> = [];
        const envReplaceCalls: Array<Record<string, unknown>> = [];
        const mockOpenClient = {
            onSessionUpdate: () => () => {},
            onDisconnect: () => () => {},
            trackSession: () => {},
            action: async (kind: string, params?: Record<string, unknown>) => {
                if (kind === "workspace.list") {
                    return { workspaces: [{ name: "workspace1" }] };
                }
                if (kind === "session.env.replace") {
                    envReplaceCalls.push(params ?? {});
                    return {};
                }
                return {};
            },
            newSession: async (_cwd: string, extra?: { _meta?: { plurnk?: Record<string, unknown> } }) => {
                newSessionCalls += 1;
                if (newSessionCalls === 1) {
                    throw Object.assign(new Error("Conflict"), { data: { status: 409 } });
                }
                const ws = String(extra?._meta?.plurnk?.workspace ?? "");
                const sess = String(extra?._meta?.plurnk?.session ?? "");
                return {
                    sessionId: `${ws}#${sess}`,
                    configOptions: [
                        {
                            configId: "mode",
                            name: "Mode",
                            type: "select",
                            currentValue: "review",
                            options: [],
                        },
                    ],
                };
            },
            resumeSession: async () => ({
                configOptions: [],
                availableCommands: [],
                _meta: { plurnk: { workspace: { name: "workspace3" } } },
            }),
            setConfigOption: async (_sid: string, cid: string, val: unknown) => {
                setConfigCalls.push([cid, val]);
                return {
                    configOptions: [
                        {
                            configId: "mode",
                            name: "Mode",
                            type: "select",
                            currentValue: cid === "mode" ? String(val) : "review",
                            options: [],
                        },
                    ],
                    _meta: { plurnk: { status: { lifecycle: "idle" } } },
                };
            },
        } as unknown as AcpClient;

        const opened = await openCliSession(
            mockOpenClient,
            {
                ...baseOpts,
                port: 54321,
                projectRoot: "",
                persona: "reviewer",
                model: "fast",
                effort: "high",
                sessionEnv: { MY_VAR: "1" },
            },
            undefined,
            true,
        );
        assert.equal(opened.sessionId, "workspace3#session2");
        assert.deepEqual(
            setConfigCalls.map(([id]) => id),
            ["persona", "model", "thought_level", "mode"],
        );
        assert.equal(envReplaceCalls.length, 1);
        opened.dispose();

        // Qualified sessionId + systemPrompt + buffered notification deduplication
        let bufferedCb: ((n: { sessionId: string; update: unknown }) => void) | null = null;
        const qualSession = await openCliSession(
            {
                onSessionUpdate: (cb: (n: { sessionId: string; update: unknown }) => void) => {
                    bufferedCb = cb;
                    return () => {};
                },
                onDisconnect: () => () => {},
                trackSession: () => {},
                newSession: async () => {
                    bufferedCb?.({
                        sessionId: "wsNamed#sessNamed",
                        update: {
                            sessionUpdate: "notice",
                            severity: "warning",
                            title: "engine:configuration:model",
                            description: "no model",
                        },
                    });
                    bufferedCb?.({
                        sessionId: "wsNamed#sessNamed",
                        update: {
                            sessionUpdate: "notice",
                            severity: "warning",
                            title: "engine:configuration:model",
                            description: "no model",
                        },
                    });
                    return { sessionId: "wsNamed#sessNamed", configOptions: [] };
                },
            } as unknown as AcpClient,
            {
                ...baseOpts,
                sessionId: "wsNamed#sessNamed",
                systemPrompt: "Act concisely.",
                yolo: false,
            },
        );
        assert.equal(qualSession.items.length, 1);
        qualSession.dispose();

        // debugNoMeta resume fallback on -32002
        let createdAfterNotFound = false;
        const debugSession = await openCliSession(
            {
                onSessionUpdate: () => () => {},
                onDisconnect: () => () => {},
                trackSession: () => {},
                resumeSession: async () => {
                    throw Object.assign(new Error("Not found"), { code: -32002 });
                },
                newSession: async () => {
                    createdAfterNotFound = true;
                    return { sessionId: "plain-1", configOptions: [] };
                },
            } as unknown as AcpClient,
            { ...baseOpts, debugNoMeta: true, sessionId: "plain-1", yolo: false },
        );
        assert.equal(createdAfterNotFound, true);
        assert.equal(debugSession.sessionId, "plain-1");
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
});

test("{§cli-inline-review}: matchesRuntimeAcceptance, formatProposalDiffPreview, and interactive CLI permission/elicitation handlers", async () => {
    const req = {
        sessionId: "1#s1",
        subject: { type: "command" as const, command: "gitea", cwd: "/tmp" },
        title: "gitea (issue_read)",
        description: "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n ctx",
        options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" as const },
            { optionId: "deny", name: "Deny", kind: "reject_once" as const },
        ],
        _meta: {
            plurnk: {
                proposal: {
                    runtime: "gitea",
                    tool: "issue_read",
                    body: "initial body",
                },
            },
        },
    };

    assert.equal(matchesRuntimeAcceptance(req, {}), false);
    assert.equal(matchesRuntimeAcceptance(req, { PLURNK_CLIENT_ACCEPT_GITEA: "1" }), true);
    assert.equal(
        matchesRuntimeAcceptance(req, {
            PLURNK_CLIENT_ACCEPT_GITEA: "1",
            PLURNK_CLIENT_ACCEPT_GITEA_TOOLS: '["issue_read"]',
        }),
        true,
    );
    assert.equal(
        matchesRuntimeAcceptance(req, {
            PLURNK_CLIENT_ACCEPT_GITEA: "1",
            PLURNK_CLIENT_ACCEPT_GITEA_TOOLS: '["issue_write"]',
        }),
        false,
    );
    assert.equal(
        matchesRuntimeAcceptance(req, {
            PLURNK_CLIENT_ACCEPT_GITEA: "1",
            PLURNK_CLIENT_ACCEPT_GITEA_TOOLS: "not-json",
        }),
        false,
    );

    assert.equal(stripVTControlCharacters(formatProposalDiffPreview(req)), "  initial body");
    const preview = stripVTControlCharacters(
        formatProposalDiffPreview({
            ...req,
            _meta: { plurnk: { proposal: { runtime: "gitea", tool: "issue_read" } } },
        }),
    );
    assert.match(preview, /\+\+\+ b\/x\.ts/u);
    assert.match(preview, /\+new/u);
    assert.match(preview, /-old/u);

    // Non-TTY rejects fail-closed
    const headlessPerm = createCliPermissionHandler(false, { isTTY: false });
    assert.deepEqual(await headlessPerm(req, new AbortController().signal), {
        outcome: { outcome: "selected", optionId: "deny" },
    });

    // Interactive TTY menu: [a]ccept, [r]eject, [c]ancel, [e]dit, numeric [2]
    const runMenuChoice = async (line: string, editBody?: (b: string) => string | null) => {
        const stdin = new PassThrough();
        const stderr = new PassThrough();
        const handler = createCliPermissionHandler(false, {
            stdin,
            stderr,
            isTTY: true,
            env: {},
            editBody,
        });
        const p = handler(req, new AbortController().signal);
        stdin.write(`${line}\n`);
        return await p;
    };

    assert.deepEqual(await runMenuChoice("a"), { outcome: { outcome: "selected", optionId: "allow" } });
    assert.deepEqual(await runMenuChoice("r"), { outcome: { outcome: "selected", optionId: "deny" } });
    assert.deepEqual(await runMenuChoice("c"), { outcome: { outcome: "cancelled" } });
    assert.deepEqual(await runMenuChoice("2"), { outcome: { outcome: "selected", optionId: "deny" } });
    const editedRes = await runMenuChoice("e", (b) => `${b} + edited`);
    assert.deepEqual((editedRes as unknown as { _meta?: unknown })._meta, {
        plurnk: { body: "initial body + edited" },
    });

    // Elicitation handler: non-TTY, URL accept/decline, Form string/boolean/number
    const headlessElicit = createCliElicitationHandler({ isTTY: false });
    assert.deepEqual(
        await headlessElicit(
            { sessionId: "1#s1", mode: "url", elicitationId: "e1", message: "Auth", url: "https://x" },
            new AbortController().signal,
        ),
        { action: "cancel" },
    );

    const urlStdin = new PassThrough();
    const urlElicit = createCliElicitationHandler({ stdin: urlStdin, stderr: new PassThrough(), isTTY: true });
    const urlPromise = urlElicit(
        { sessionId: "1#s1", mode: "url", elicitationId: "e1", message: "Auth", url: "https://x" },
        new AbortController().signal,
    );
    urlStdin.write("yes\n");
    assert.deepEqual(await urlPromise, { action: "accept" });

    const formStdin = new PassThrough();
    const formElicit = createCliElicitationHandler({ stdin: formStdin, stderr: new PassThrough(), isTTY: true });
    const formPromise = formElicit(
        {
            sessionId: "1#s1",
            mode: "form",
            message: "Configure",
            requestedSchema: {
                type: "object",
                properties: {
                    name: { type: "string", title: "Name" },
                    enabled: { type: "boolean", title: "Enabled" },
                    retries: { type: "integer", title: "Retries" },
                },
            },
        },
        new AbortController().signal,
    );
    setImmediate(() => {
        formStdin.write("demo\n");
        setImmediate(() => {
            formStdin.write("yes\n");
            setImmediate(() => {
                formStdin.write("3\n");
            });
        });
    });
    assert.deepEqual(await formPromise, {
        action: "accept",
        content: { name: "demo", enabled: true, retries: 3 },
    });
});

test("{§cli-output-channels} {§cli-rendering} {§cli-problems-and-notices}: transport helpers, formatters, credential revocation, and runCliPrompt exit codes", async () => {
    // Transport helpers
    assert.equal(normalizeAcpUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080/acp");
    assert.equal(toAcpWebSocketUrl("https://example.com/acp"), "wss://example.com/acp");
    assert.equal(toAcpWebSocketUrl("http://example.com"), "ws://example.com/acp");

    const scrubbed = scrubAcpMeta({
        a: 1,
        _meta: {
            plurnk: { secret: true },
            "io.modelcontextprotocol/trace": { span: "abc", _meta: { plurnk: 1 } },
        },
        list: [{ _meta: { plurnk: 2 }, ok: true }],
    });
    assert.deepEqual(scrubbed, {
        a: 1,
        _meta: { "io.modelcontextprotocol/trace": { span: "abc" } },
        list: [{ ok: true }],
    });

    const rawReadable = new ReadableStream({
        start(c) {
            c.enqueue({ text: "hi", _meta: { plurnk: 1 } });
            c.close();
        },
    });
    const writtenItems: unknown[] = [];
    const rawWritable = new WritableStream({
        write(msg) {
            writtenItems.push(msg);
        },
    });
    const wrapped = wrapStreamWithMetaScrubber({ readable: rawReadable, writable: rawWritable });
    const reader = wrapped.readable.getReader();
    assert.deepEqual((await reader.read()).value, { text: "hi" });
    const writer = wrapped.writable.getWriter();
    await writer.write({ out: 1, _meta: { plurnk: 2 } });
    await writer.close();
    assert.deepEqual(writtenItems, [{ out: 1 }]);

    // Hydrate full message & tool_call resource_link blocks
    const fakeFetch = async (input: unknown) =>
        new Response(`hydrated:${String(input)}`, { status: 200 });
    const hydratedMsg = await hydrateSessionUpdate(
        "http://127.0.0.1:9000/acp",
        {
            sessionId: "1#s1",
            update: {
                sessionUpdate: "agent_message",
                messageId: "m1",
                content: [{ type: "resource_link", uri: "http://127.0.0.1:9000/bodies/1", name: "body" }],
            },
        },
        fakeFetch,
    );
    assert.deepEqual((hydratedMsg.update as { content?: unknown }).content, [
        { type: "text", text: "hydrated:http://127.0.0.1:9000/bodies/1" },
    ]);

    const hydratedTool = await hydrateSessionUpdate(
        "http://127.0.0.1:9000/acp",
        {
            sessionId: "1#s1",
            update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "1/1/1",
                name: "note",
                status: "completed",
                content: [
                    {
                        type: "content",
                        content: { type: "resource_link", uri: "http://127.0.0.1:9000/bodies/2", name: "n" },
                    },
                ],
            },
        },
        fakeFetch,
    );
    assert.deepEqual((hydratedTool.update as { content?: unknown }).content, [
        { type: "content", content: { type: "text", text: "hydrated:http://127.0.0.1:9000/bodies/2" } },
    ]);

    // Presenter formatters remaining branches
    assert.equal(abbreviatedCount(2_500_000_000), "2.5B");
    assert.equal(operationGlyphFor(""), "⚙️");
    assert.equal(lifecycleGlyphFor("cancelled"), "🛑");
    assert.equal(extractToolFields("gitea", { body: "{bad" }), null);
    assert.equal(extractToolFields("gitea", { body: { repo: "plurnk", id: 1 } }), "{repo,id}");
    assert.equal(receiptCountFor("find", { range: { total: 7 } }), 7);
    assert.equal(receiptCountFor("find", { matches: 3 }), 3);
    assert.equal(formatActiveOperationLead("edit"), "📝 edit");
    assert.equal(formatActiveOperationLead("note"), "🗒️  note");
    assert.equal(formatActiveOperationLead("sh"), "⚙️  sh");
    assert.equal(extractMessageActor({ source: "acp://scout" }), "scout");
    assert.equal(extractMessageActor({ source: "session://worker1" }), "worker1");
    assert.equal(extractMessageActor({ source: "schedule:///nightly" }), "schedule:nightly");
    assert.equal(extractMessageActor({ source: "message://ws/alice_a1b2" }), "alice");

    // Credential logout with revocation endpoint + runCliPrompt max_turn_requests (exit 2) & share failure
    const tmpDir = mkdtempSync(join(tmpdir(), "plurnk-runner-test-"));
    let revokedPosted = false;
    let mode: "max_turns" | "share_fail" = "max_turns";

    const agentApp = createAcpAgent({ name: "mock-runner" })
        .onRequest(methods.agent.initialize, async () => ({
            protocolVersion: PROTOCOL_VERSION,
            info: { name: "mock", version: "1.0.0" },
            capabilities: {},
        }))
        .onRequest(methods.agent.session.new, async () => ({
            sessionId: "1#session1",
            configOptions: [],
        }))
        .onRequest(methods.agent.session.resume, async ({ client, params }) => {
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: { sessionUpdate: "replay_complete" },
            });
            return { configOptions: [] };
        })
        .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
            if (params.prompt[0] && "text" in params.prompt[0] && params.prompt[0].text === "quit-repl") {
                return { messageId: "m0" };
            }
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_thought_chunk",
                    messageId: "th1",
                    content: { type: "text", text: "thinking" },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "tool_call_update",
                    toolCallId: "1/1/1",
                    title: "read (a.ts)",
                    status: "completed",
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "notice",
                    severity: "error",
                    title: "engine:warn",
                    description: "minor error notice",
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "agent_message_chunk",
                    messageId: "m1",
                    content: { type: "text", text: "Hello out" },
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: {
                    sessionUpdate: "state_update",
                    state: "running",
                },
            });
            await client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update:
                    (mode as string) === "max_turns"
                        ? { sessionUpdate: "state_update", state: "idle", stopReason: "max_turn_requests" }
                        : { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
            });
            return { messageId: "m1" };
        })
        .onRequest(
            "_plurnk/action",
            (raw) => raw as { kind: string },
            async ({ params }) => {
                if (params.kind === "workspace.share" && (mode as string) === "share_fail") {
                    throw new RequestError(-32000, "Share target exists", {
                        type: "https://problems.plurnk.xyz/workspace/share-exists",
                        title: "Share exists",
                        status: 409,
                        detail: "Target folder already exists.",
                    });
                }
                return {};
            },
        );

    const acpServer = new AcpServer({ agent: agentApp });
    const acpHandler = createNodeHttpHandler(acpServer);
    const httpServer = http.createServer((req, res) => {
        if (req.url === "/revoke" && req.method === "POST") {
            revokedPosted = true;
            res.writeHead(200);
            res.end();
            return;
        }
        acpHandler(req, res);
    });
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    const port = (httpServer.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${String(port)}`;
    const url = `${origin}/acp`;

    try {
        assert.equal(toHttpOrigin("wss://example.com/acp"), "https://example.com");
        assert.equal(toHttpOrigin("ws://example.com/acp"), "http://example.com");
        const cred = new Credential({ HOME: tmpDir, XDG_STATE_HOME: tmpDir });
        mkdirSync(dirname(cred.grantsPath()), { recursive: true });
        writeFileSync(cred.grantsPath(), "{malformed-json", "utf8");
        assert.deepEqual(await cred.logout(url), { revoked: false, origin });
        writeFileSync(
            cred.grantsPath(),
            JSON.stringify({
                [origin]: {
                    issuer: origin,
                    clientId: "c1",
                    accessToken: "tok",
                    expiresAt: Date.now() + 60_000,
                    revocationEndpoint: `${origin}/revoke`,
                },
            }),
            "utf8",
        );
        assert.deepEqual(await cred.operatorHeaders(url), { authorization: "Bearer tok" });
        assert.equal(await cred.token(url), "tok");
        cred.invalidate();
        assert.equal(await cred.token(url), null);
        await assert.rejects(
            () => cred.login(url, { signal: new AbortController().signal }),
            /did not advertise authorization_endpoint and token_endpoint/u,
        );
        assert.deepEqual(await cred.logout(url), { revoked: true, origin });
        assert.equal(revokedPosted, true);

        const opts: CliCommonOptions = {
            url,
            explicitAcpUrl: true,
            host: "127.0.0.1",
            port,
            credential: cred,
            env: { HOME: tmpDir, XDG_STATE_HOME: tmpDir },
            cwd: tmpDir,
            workspace: "ws1",
            sessionId: "session1",
            termSession: "session1",
            autostart: false,
            daemonTimeoutMs: 2000,
            oauthTimeoutMs: 2000,
            cancelGraceMs: 200,
            yolo: true,
            auto: false,
            bell: false,
            json: true,
            previewLines: 4,
            historyEntries: 0,
            mermaidTimeoutMs: 1000,
            color: "never",
        };

        const outStream = new PassThrough();
        let jsonOut = "";
        outStream.on("data", (c) => (jsonOut += String(c)));
        const exit2 = await runCliPrompt("go", opts, {
            stdin: new PassThrough(),
            stdout: outStream,
            stderr: new PassThrough(),
            events: new PassThrough(),
            reasoning: new PassThrough(),
        });
        assert.equal(exit2, 2);
        assert.equal(JSON.parse(jsonOut).finalStatus, 429);

        const plainOut = new PassThrough();
        let plainText = "";
        plainOut.on("data", (c) => (plainText += String(c)));
        const exit2Text = await runCliPrompt("? go", { ...opts, json: false, auto: true, maxTurns: 3 }, {
            stdin: new PassThrough(),
            stdout: plainOut,
            stderr: new PassThrough(),
            events: new PassThrough(),
            reasoning: new PassThrough(),
        });
        assert.equal(exit2Text, 2);
        assert.match(plainText, /Hello out/u);

        mode = "share_fail";
        await assert.rejects(
            () =>
                runCliPrompt(
                    "go",
                    { ...opts, shareFolder: "~/out" },
                    {
                        stdin: new PassThrough(),
                        stdout: new PassThrough(),
                        stderr: new PassThrough(),
                        events: new PassThrough(),
                        reasoning: new PassThrough(),
                    },
                ),
            (err: unknown) => err instanceof ClientCliError && err.problem.status === 409,
        );

        // runInteractiveSession with --repl
        const replIn = new PassThrough();
        replIn.end("/quit\n");
        const replCode = await runInteractiveSession(
            { ...opts, json: false, repl: true },
            {
                stdin: replIn,
                stdout: new PassThrough(),
                stderr: new PassThrough(),
                events: new PassThrough(),
                reasoning: new PassThrough(),
            },
        );
        assert.equal(replCode, 0);
    } finally {
        await acpServer.close();
        httpServer.closeAllConnections();
        await new Promise<void>((r) => httpServer.close(() => r()));
        rmSync(tmpDir, { recursive: true, force: true });
    }
});
