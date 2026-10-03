// Daemon-subprocess harness for integration tests. Boots a plurnk-service
// instance on an ephemeral port with a tmp DB + tmp workspace, returns the
// URL plus a cleanup function. Each test file gets its own daemon (suite-
// level setup/teardown via node:test before/after hooks).
//
// Skip-if-not-found: when the daemon binary isn't reachable we return null
// from locateDaemon(), and each test file's `before()` hook can skip the
// whole suite cleanly. This keeps `npm test` from hard-failing downstream.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm, access, realpath, constants as fsConstants } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Where to look for plurnk-service. Env override wins; otherwise we look at
// the sibling repo on disk. Returns absolute path or null.
export const locateDaemon = async (): Promise<string | null> => {
    const envPath = process.env.PLURNK_SERVICE_BIN;
    if (envPath !== undefined && envPath.length > 0) {
        try { await access(envPath, fsConstants.R_OK); return envPath; } catch { /* fall through */ }
    }
    // The service entrypoint has moved over time: bin/plurnk-service.js →
    // bin/plurnk-service.ts (#183) → src/service.ts (bin: dist/service.js,
    // 2026-06-20). Probe newest-first, keeping the old paths for older checkouts.
    const candidates = [
        "plurnk-core/src/service.ts",   // monorepo layout (2026-07-12 cutover)
        "src/service.ts",
        "dist/service.js",
        "bin/plurnk-service.ts",
        "bin/plurnk-service.js",
    ];
    for (const rel of candidates) {
        const sibling = resolve(__dirname, `../../../plurnk-service/${rel}`);
        try { await access(sibling, fsConstants.R_OK); return sibling; } catch { /* not present */ }
    }
    return null;
};

// A source entrypoint still loads its workspace siblings through their `dist`, so an unbuilt
// sibling boots a daemon made of two different services — and it dies in the wrong vocabulary:
// a stale content-store build answered `cannot create AFTER trigger on view: entry_channels`,
// a shape the service source had not had for a day, and cost an afternoon. Name the likely
// cause on the failure rather than refusing beforehand: source mtimes are rewritten by any
// checkout, so "newer than dist" is not evidence of a stale build (plurnk/plurnk#92).
export const STALE_BUILD_SIGNATURES = /cannot create AFTER trigger on view|ERR_MODULE_NOT_FOUND|is not exported from|does not provide an export named/;

export const bootDiagnosis = (stdout: string, stderr: string): string =>
    STALE_BUILD_SIGNATURES.test(stdout + stderr)
        ? "\n\nThis looks like a stale sibling build: a source entrypoint loads @plurnk/* through their `dist`."
            + " Run `npm run build` in plurnk-service and try again."
        : "";

// Where the daemon's .env (with model alias config) lives. Optional; passed
// to node --env-file=... when present.
export const locateDaemonEnv = async (binPath: string): Promise<string | null> => {
    const envFile = resolve(dirname(binPath), "../.env");
    try { await access(envFile, fsConstants.R_OK); return envFile; } catch { return null; }
};

export interface Daemon {
    url: string;
    workspace: string;
    home: string;
    pid: number;
    output: () => string;
    cleanup: () => Promise<void>;
}

interface BootOptions {
    extraEnv?: Record<string, string>;  // additional env vars (override file-loaded ones)
    inheritOperatorConfig?: boolean;    // only real-model tiers may read the operator's config
    readyTimeoutMs?: number;             // default 10s
    mcp?: Readonly<Record<string, object>>;
}

// {§cli-test-daemon-lifecycle}: the selected service owns launch/readiness/shutdown;
// this fixture owns configuration isolation and disposal of its temporary root.
export const bootDaemon = async (binPath: string, opts: BootOptions = {}): Promise<Daemon> => {
    const entry = await realpath(binPath);
    const { default: Launch } = await import(pathToFileURL(
        createRequire(entry).resolve("@plurnk/plurnk-service/launch"),
    ).href);
    await using resources = new AsyncDisposableStack();
    const runtime = await mkdtemp(join(tmpdir(), "plurnk-intg-"));
    resources.defer(() => rm(runtime, { recursive: true, force: true }));
    const home = join(runtime, "home");
    const workspace = join(runtime, "workspace");
    await Promise.all([mkdir(home), mkdir(workspace)]);
    const daemonEnv = opts.inheritOperatorConfig === true ? await locateDaemonEnv(entry) : null;
    const args = [
        ...(entry.endsWith(".ts") ? ["--conditions=plurnk-dev"] : []),
        entry,
        ...(daemonEnv !== null ? [`--env-file=${daemonEnv}`] : []),
    ];
    // The service's env cascade is set-if-unset with the shell highest, so an
    // operator shell that exports provider or PLURNK variables would silently
    // override the test's overrides. Isolated boots therefore inherit neither.
    const isolatedProcessEnv = Object.fromEntries(Object.entries(process.env as Record<string, string>)
        .filter(([key]) => !/^PLURNK_/.test(key) && !/_(API_KEY|BASE_URL)$/.test(key)));
    const env = opts.inheritOperatorConfig === true
        ? process.env as Record<string, string>
        : {
            ...isolatedProcessEnv,
            HOME: home,
            XDG_CONFIG_HOME: join(home, ".config"),
            XDG_DATA_HOME: join(home, ".local", "share"),
            XDG_STATE_HOME: join(home, ".local", "state"),
            XDG_CACHE_HOME: join(home, ".cache"),
        };

    const daemon = await Launch.start({
        command: [process.execPath, ...args],
        env: {
            ...env,
            PLURNK_SERVICE_DB_PATH: "",
            PLURNK_MODEL: "",
            ...Object.fromEntries(Object.entries(opts.mcp ?? {}).map(([name, definition]) => [
                `PLURNK_MCP_${name.replaceAll("-", "_")}`, JSON.stringify({ name, ...definition }),
            ])),
            ...opts.extraEnv,
        },
        cwd: resolve(dirname(entry), ".."),
        stateRoot: runtime,
        host: "127.0.0.1",
        port: 0,
        readyTimeoutMs: opts.readyTimeoutMs ?? 10_000,
        stopGraceMs: 2_000,
    }).catch((cause: unknown) => {
        if (!(cause instanceof Error)
            || !("stdout" in cause) || typeof cause.stdout !== "string"
            || !("stderr" in cause) || typeof cause.stderr !== "string") throw cause;
        const { stdout, stderr } = cause;
        throw new Error(`${cause.message}\nstdout:\n${stdout}\nstderr:\n${stderr}${bootDiagnosis(stdout, stderr)}`, { cause });
    });
    resources.defer(async () => { await daemon.stop(); });
    const owned = resources.move();
    return {
        url: daemon.url, workspace, home, pid: daemon.child.pid,
        output: () => `${daemon.stdout()}\n${daemon.stderr()}`,
        cleanup: () => owned.disposeAsync(),
    };
};

// A scripted OpenAI-compatible completions endpoint for a booted daemon: route an alias to it with
// `PLURNK_BASEURL_<alias>` and every turn answers with `reply(request)` as one streamed chunk. A
// KILL fence ends the loop, so a PTY test can drive a real loop with no model.
export interface CompletionsEndpoint { url: string; close: () => Promise<void> }

const completionsBody = async (request: IncomingMessage): Promise<{ model?: unknown; messages?: unknown }> => {
    let body = "";
    request.setEncoding("utf8");
    for await (const chunk of request) body += chunk;
    return JSON.parse(body) as { model?: unknown; messages?: unknown };
};

const streamCompletion = (response: ServerResponse, model: string, content: string): void => {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const frame = (value: unknown): void => { response.write(`data: ${JSON.stringify(value)}\n\n`); };
    frame({ id: "completions-endpoint", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] });
    frame({ id: "completions-endpoint", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    response.end("data: [DONE]\n\n");
};

export const completionsEndpoint = async (
    reply: (request: { model: string; messages: unknown }) => string,
): Promise<CompletionsEndpoint> => {
    const server = createServer(async (request, response) => {
        if (request.method === "GET" && request.url === "/v1/models") {
            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ object: "list", data: [] }));
            return;
        }
        if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
        const body = await completionsBody(request);
        if (typeof body.model !== "string") { response.writeHead(400).end("model is required"); return; }
        streamCompletion(response, body.model, reply({ model: body.model, messages: body.messages }));
    });
    const port = await new Promise<number>((resolvePort, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolvePort((server.address() as { port: number }).port));
    });
    return {
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise<void>((resolveClose, reject) => server.close((error) => error === undefined ? resolveClose() : reject(error))),
    };
};
