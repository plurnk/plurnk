import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { actionViaBridge } from "../../src/agui.ts";
import { bootDaemon, locateDaemon } from "./harness.ts";

for (const browserFails of [false, true]) {
    test(`[§cli-mcp-oauth-callback] built CLI authorizes through ${browserFails ? "manual navigation after browser failure" : "its system browser"}`, { timeout: 60_000 }, async (t) => {
        if (process.platform !== "linux") { t.skip("the controlled browser uses Linux's BROWSER convention"); return; }
        const bin = await locateDaemon();
        if (bin === null) { t.skip("service checkout is not reachable"); return; }
        const require = createRequire(join(dirname(bin), "../package.json"));
        const { McpServer, createMcpHandler } = await import(pathToFileURL(require.resolve("@modelcontextprotocol/server")).href);
        const handler = createMcpHandler(() => {
            const peer = new McpServer({ name: "oauth-callback-fixture", version: "1.0.0" });
            peer.registerTool("inspect", { description: "Read the fixture." }, async () => ({ content: [{ type: "text", text: "authorized fixture" }] }));
            return peer;
        }, { legacy: "reject", responseMode: "auto", keepAliveMs: 0 });
        const slot = createServer();
        slot.listen(0, "127.0.0.1");
        await once(slot, "listening");
        const redirect = `http://127.0.0.1:${(slot.address() as AddressInfo).port}/callback`;
        await new Promise<void>((resolveClose) => slot.close(() => resolveClose()));
        let origin = "";
        let challenge = "";
        const tokenRequests: URLSearchParams[] = [];
        const server = createServer((incoming, outgoing) => {
            void (async () => {
                let body = "";
                for await (const chunk of incoming) body += chunk;
                const url = new URL(incoming.url!, origin);
                const json = (data: unknown): void => { outgoing.setHeader("content-type", "application/json"); outgoing.end(JSON.stringify(data)); };
                if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
                    json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["mcp:read"] }); return;
                }
                if (url.pathname === "/.well-known/oauth-authorization-server") {
                    json({
                        issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
                        response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
                        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
                        client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true,
                    }); return;
                }
                if (url.pathname === "/authorize") {
                    assert.equal(url.searchParams.get("redirect_uri"), redirect);
                    assert.equal(url.searchParams.get("resource"), `${origin}/mcp`);
                    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
                    challenge = url.searchParams.get("code_challenge")!;
                    const callback = new URL(redirect);
                    callback.searchParams.set("state", url.searchParams.get("state")!);
                    callback.searchParams.set("iss", origin);
                    callback.searchParams.set("code", "fixture-code");
                    outgoing.writeHead(302, { location: callback.href }).end(); return;
                }
                if (url.pathname === "/token") {
                    const params = new URLSearchParams(body);
                    tokenRequests.push(params);
                    assert.equal(params.get("code"), "fixture-code");
                    assert.equal(params.get("redirect_uri"), redirect);
                    assert.equal(params.get("resource"), `${origin}/mcp`);
                    assert.equal(createHash("sha256").update(params.get("code_verifier")!).digest("base64url"), challenge);
                    json({ access_token: "fixture-token", token_type: "Bearer", scope: "mcp:read" }); return;
                }
                if (incoming.headers.authorization !== "Bearer fixture-token") {
                    outgoing.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }).end(); return;
                }
                const request = new Request(url, {
                    method: incoming.method, headers: incoming.headers as Record<string, string>,
                    ...(body.length === 0 ? {} : { body }),
                });
                const response: Response = await handler.fetch(request);
                outgoing.writeHead(response.status, Object.fromEntries(response.headers));
                if (response.body !== null) for await (const chunk of response.body) outgoing.write(chunk);
                outgoing.end();
            })().catch((cause) => { outgoing.destroy(cause); });
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        t.after(async () => { await handler.close(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); });
        const daemon = await bootDaemon(bin, { mcp: { oauth: {
            type: "streamable-http", url: `${origin}/mcp`, authorization: {
                type: "oauth", redirectUrl: redirect, clientMetadataUrl: "https://client.example/oauth.json",
            },
        } } });
        t.after(daemon.cleanup);
        const workspace = "oauth-client";
        await actionViaBridge({ bridgeUrl: daemon.url }, { threadId: workspace, kind: "workspace.create", params: { name: workspace, projectRoot: null } });
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PLURNK_")));
        const child = spawn(process.execPath, [
            resolve("bin/plurnk.js"), "--workspace", workspace, "--json",
            ...(browserFails ? ["--oauth-timeout-ms", "5000"] : []), "mcp", "oauth", "oauth",
        ], {
            cwd: daemon.workspace,
            env: {
                ...env, HOME: daemon.home, XDG_CONFIG_HOME: join(daemon.home, ".config"),
                PLURNK_AGUI_URL: daemon.url, PLURNK_CLIENT_OAUTH_TIMEOUT_MS: browserFails ? "0" : "5000",
                BROWSER: `${process.execPath} ${resolve("test/fixtures/oauth-browser.mjs")}`,
                OAUTH_BROWSER_FAIL: browserFails ? "1" : "0",
                DISPLAY: "", WAYLAND_DISPLAY: "", XDG_CURRENT_DESKTOP: "", DE: "", SSH_CONNECTION: "", SSH_CLIENT: "", SSH_TTY: "", NO_COLOR: "1",
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
        let stdout = "";
        let stderr = "";
        let navigation: Promise<number | Error> | undefined;
        child.stdout.setEncoding("utf8").on("data", (text: string) => { stdout += text; });
        child.stderr.setEncoding("utf8").on("data", (text: string) => {
            stderr += text;
            if (browserFails && navigation === undefined && stderr.includes("Could not open the browser")) {
                const url = /authorization required: (\S+)/u.exec(stderr)?.[1];
                if (url !== undefined) navigation = fetch(url).then((response) => response.status, (error: Error) => error);
            }
        });
        const [code] = await once(child, "close");
        assert.equal(code, 0, `${stdout}\n${stderr}\n${daemon.output()}`);
        const result = JSON.parse(stdout) as { status: number; definition: { state: string; detail: { tools: string[] } } };
        assert.equal(result.status, 200);
        assert.equal(result.definition.state, "active");
        assert.deepEqual(result.definition.detail.tools, ["inspect"]);
        assert.equal(tokenRequests.length, 1);
        if (browserFails) {
            assert.equal(await navigation, 200);
            assert.match(stderr, /Could not open the browser: launcher exited 3/u);
        }
        assert.doesNotMatch(stdout + stderr, /fixture-code|fixture-token/u);
        await assert.rejects(fetch(redirect), /fetch failed/u);
    });
}
