import { access, readFile, realpath } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { connect, isIP } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AcpTarget } from "./acp.ts";
import Credential from "./credential.ts";
import { clientProblem, ProblemError } from "./diagnostics.ts";
import Knobs, { KnobError } from "./knobs.ts";

const SERVICE = "@plurnk/plurnk-service";

interface Daemon {
    readonly url: string;
    readonly dbPath: string;
    readonly child: { readonly pid?: number };
    readonly logFile: string | null;
}

interface Launcher {
    start(options: {
        command: readonly string[];
        env: NodeJS.ProcessEnv;
        cwd: string;
        host: string;
        port: number;
        lifetime: "shared";
        readyTimeoutMs: number;
        stopGraceMs: number;
    }): Promise<Daemon>;
}

/** The service an invocation started and left running. */
export interface StartedService {
    readonly pid: number | null;
    readonly url: string;
    readonly logFile: string | null;
}

const hasCode = (cause: unknown, code: string): boolean =>
    cause instanceof Error && "code" in cause && cause.code === code;

const installationMissing = (binary?: string): ProblemError => new ProblemError(clientProblem(
    "daemon", "not-installed", 503,
    binary === undefined ? "No installed plurnk-service was found." : `The configured service executable was not found: ${binary}`,
    { hints: [`Install it: npm install -g ${SERVICE}`] },
), 127);

const findExecutable = async (name: string, env: NodeJS.ProcessEnv): Promise<string | null> => {
    const candidates = isAbsolute(name) || name.includes("/") || name.includes("\\")
        ? [resolve(name)]
        : (env.PATH ?? "").split(delimiter).flatMap((directory) => process.platform === "win32"
            ? [join(directory, name), join(directory, `${name}.cmd`)]
            : [join(directory, name)]);
    for (const candidate of candidates) {
        try { await access(candidate); return await realpath(candidate); }
        catch (cause) { if (!hasCode(cause, "ENOENT") && !hasCode(cause, "ENOTDIR")) throw cause; }
    }
    return null;
};

// Resolve the launcher from the SAME package as its executable. No shell, npm invocation,
// package download, or source-checkout guessing participates in runtime startup.
export const serviceInstallation = async (env: NodeJS.ProcessEnv): Promise<{ command: string[]; launch: Launcher }> => {
    const configured = env.PLURNK_CLIENT_SERVICE_BIN;
    let entry: string;
    let manifest: string;
    if (configured !== undefined && configured.length > 0) {
        const found = await findExecutable(configured, env);
        if (found === null) throw installationMissing(configured);
        entry = found;
        manifest = createRequire(entry).resolve(`${SERVICE}/package.json`);
    } else {
        try {
            manifest = createRequire(import.meta.url).resolve(`${SERVICE}/package.json`);
            const pkg = JSON.parse(await readFile(manifest, "utf8")) as { bin: Record<string, string> };
            entry = resolve(dirname(manifest), pkg.bin["plurnk-service"]);
        } catch (cause) {
            if (!hasCode(cause, "MODULE_NOT_FOUND")) throw cause;
            const found = await findExecutable("plurnk-service", env);
            if (found === null) throw installationMissing();
            manifest = createRequire(found).resolve(`${SERVICE}/package.json`);
            const pkg = JSON.parse(await readFile(manifest, "utf8")) as { bin: Record<string, string> };
            entry = resolve(dirname(manifest), pkg.bin["plurnk-service"]);
        }
    }
    const module = await import(pathToFileURL(createRequire(manifest).resolve(`${SERVICE}/launch`)).href) as { default: Launcher };
    if (typeof module.default?.start !== "function") throw new TypeError("The installed service does not export its launch interface.");
    return {
        command: [process.execPath, ...(entry.endsWith(".ts") ? ["--conditions=plurnk-dev"] : []), entry, "start"],
        launch: module.default,
    };
};

export const isLoopback = (hostname: string): boolean => {
    const host = hostname.replace(/^\[|\]$/gu, "");
    return host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
};

// Only ECONNREFUSED means there is no listener. A slow, unavailable, foreign, or rejecting
// endpoint is not permission to substitute an unrelated environment. A live listener still
// has to satisfy the ordinary ACP protocol; this probe establishes no identity or authority.
export const listenerPresent = (url: URL, timeoutMs: number): Promise<boolean> => new Promise<boolean>((accept, reject) => {
    const socket = connect({ host: url.hostname.replace(/^\[|\]$/gu, ""), port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) });
    socket.once("connect", () => { socket.destroy(); accept(true); });
    socket.once("error", (cause) => { socket.destroy(); hasCode(cause, "ECONNREFUSED") ? accept(false) : reject(cause); });
    socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error(`Connection to ${url.origin} timed out.`)); });
});

// How often an attach looks again at a service that is still starting.
const ADMISSION_POLL_MS = 100;

// {§cli-daemon-autostart} A service owns its listener before it admits clients, answering 503
// `service-starting` until then; an attach waits for admission within the startup deadline. The probe is
// one OPTIONS on its own connection, which an admitted service answers before any authentication. Any
// other answer, or none (a listener that is not HTTP), is the ACP caller's to judge.
const starting = (acpUrl: string, timeoutMs: number): Promise<boolean> => new Promise((accept) => {
    const probe = request(acpUrl, { method: "OPTIONS", agent: false, timeout: timeoutMs }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { text += chunk; });
        response.on("error", () => accept(false));
        response.on("end", () => {
            if (response.statusCode !== 503) { accept(false); return; }
            try {
                const body: unknown = JSON.parse(text);
                accept(typeof body === "object" && body !== null && "type" in body
                    && typeof body.type === "string" && body.type.endsWith("/http/service-starting"));
            } catch { accept(false); }
        });
    });
    probe.on("timeout", () => { probe.destroy(); accept(false); });
    probe.on("error", () => accept(false));
    probe.end();
});

const admitted = async (acpUrl: string, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (await starting(acpUrl, timeoutMs) && Date.now() < deadline) {
        await new Promise((accept) => setTimeout(accept, ADMISSION_POLL_MS));
    }
};

const unshareablePort = (): ProblemError => new ProblemError(clientProblem(
    "daemon", "port-unshareable", 400, "Autostart needs the service's port; PLURNK_PORT is 0.",
    { hints: ["Set PLURNK_PORT to the port the service listens on, or PLURNK_ACP_URL to attach to a running one."] },
), 64);

// What a failed start said: its stderr, or the shared log's lines when that is where both streams went.
const startOutput = (cause: unknown): string => cause instanceof Error && "stderr" in cause && "stdout" in cause
    && typeof cause.stderr === "string" && typeof cause.stdout === "string" ? cause.stderr.trim() || cause.stdout.trim() : "";

// {§cli-daemon-autostart} — one service per configuration. The client attaches to the one listening at
// its address, or starts it once with the launcher's shared lifetime and leaves it running for every
// later client; it never stops a service.
export default class Backend {
    readonly target: AcpTarget;
    // The service this invocation started, for its notice; null when it attached to one already running.
    readonly started: StartedService | null;

    private constructor(target: AcpTarget, started: StartedService | null = null) {
        this.target = target;
        this.started = started;
    }

    static async open(target: AcpTarget, env: NodeJS.ProcessEnv = process.env): Promise<Backend> {
        const url = new URL(target.acpUrl);
        if ((env.PLURNK_ACP_URL ?? "").length > 0 || !isLoopback(url.hostname)
            || !Knobs.flag("PLURNK_CLIENT_AUTOSTART", "live", env)) return new Backend(target);
        const timeout = Knobs.count("PLURNK_CLIENT_DAEMON_TIMEOUT_MS", env);
        if (timeout === 0) throw new KnobError("PLURNK_CLIENT_DAEMON_TIMEOUT_MS", String(timeout), "must be positive.");
        if (url.port === "0") throw unshareablePort();
        if (await listenerPresent(url, timeout)) {
            await admitted(target.acpUrl, timeout);
            return new Backend(target);
        }
        const { command, launch } = await serviceInstallation(env);
        let daemon: Daemon;
        try {
            daemon = await launch.start({
                command, env, cwd: homedir(), host: url.hostname.replace(/^\[|\]$/gu, ""), port: Number(url.port),
                lifetime: "shared", readyTimeoutMs: timeout, stopGraceMs: timeout,
            });
        } catch (cause) {
            // A concurrent first launch that won the address serves this client too.
            if (await listenerPresent(url, timeout)) {
                await admitted(target.acpUrl, timeout);
                return new Backend({ ...target, credential: Credential.fromEnvironment(env) ?? target.credential });
            }
            const said = startOutput(cause);
            if (said.length === 0 || !(cause instanceof Error)) throw cause;
            throw new Error(`${cause.message}\n${said}`, { cause });
        }
        // {§cli-credential} — the secret the started service minted beside its database.
        const credential = Credential.fromFile(join(dirname(daemon.dbPath), "secret")) ?? target.credential;
        return new Backend({ acpUrl: daemon.url, credential }, { pid: daemon.child.pid ?? null, url: daemon.url, logFile: daemon.logFile });
    }
}
