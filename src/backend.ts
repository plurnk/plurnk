import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { connect, isIP } from "node:net";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AguiTarget } from "./agui.ts";
import { clientProblem, ProblemError } from "./diagnostics.ts";
import Knobs, { KnobError } from "./knobs.ts";

const SERVICE = "@plurnk/plurnk-service";

interface Daemon {
    readonly url: string;
    readonly dbPath: string;
    stop(): Promise<unknown>;
}

interface Launcher {
    start(options: {
        command: readonly string[];
        env: NodeJS.ProcessEnv;
        cwd: string;
        stateRoot?: string;
        host: string;
        port: number;
        lifetime: "private";
        readyTimeoutMs: number;
        stopGraceMs: number;
    }): Promise<Daemon>;
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
// has to satisfy the ordinary AG-UI protocol; this probe establishes no identity or authority.
export const listenerPresent = (url: URL, timeoutMs: number): Promise<boolean> => {
    if (url.port === "0") return Promise.resolve(false);
    return new Promise<boolean>((accept, reject) => {
        const socket = connect({ host: url.hostname.replace(/^\[|\]$/gu, ""), port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) });
        socket.once("connect", () => { socket.destroy(); accept(true); });
        socket.once("error", (cause) => { socket.destroy(); hasCode(cause, "ECONNREFUSED") ? accept(false) : reject(cause); });
        socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error(`Connection to ${url.origin} timed out.`)); });
    });
};

// {§cli-daemon-autostart} — one invocation owns at most one backend. Persistent state and
// process ownership are separate: close never deletes user data or stops an attached service.
export default class Backend {
    readonly target: AguiTarget;
    readonly database: string | null;
    readonly resumeEnv: Readonly<Record<string, string>>;
    readonly allocatedStorage: boolean;
    readonly #daemon: Daemon | null;
    #closing: Promise<void> | undefined;

    private constructor(target: AguiTarget, daemon: Daemon | null, resumeEnv: Readonly<Record<string, string>> = {}, allocatedStorage = false) {
        this.target = target;
        this.database = daemon?.dbPath ?? null;
        this.resumeEnv = resumeEnv;
        this.allocatedStorage = allocatedStorage;
        this.#daemon = daemon;
    }

    static async open(target: AguiTarget, env: NodeJS.ProcessEnv = process.env): Promise<Backend> {
        const url = new URL(target.aguiUrl);
        if ((env.PLURNK_AGUI_URL ?? "").length > 0 || !isLoopback(url.hostname)
            || !Knobs.flag("PLURNK_CLIENT_AUTOSTART", "live", env)) return new Backend(target, null);
        const timeout = Knobs.count("PLURNK_CLIENT_DAEMON_TIMEOUT_MS", env);
        const grace = Knobs.count("PLURNK_CLIENT_DAEMON_STOP_TIMEOUT_MS", env);
        if (timeout === 0) throw new KnobError("PLURNK_CLIENT_DAEMON_TIMEOUT_MS", String(timeout), "must be positive.");
        if (grace === 0) throw new KnobError("PLURNK_CLIENT_DAEMON_STOP_TIMEOUT_MS", String(grace), "must be positive.");
        if (await listenerPresent(url, timeout)) return new Backend(target, null);
        const { command, launch } = await serviceInstallation(env);
        let stateRoot = env.PLURNK_SERVICE_STATE_ROOT || undefined;
        const allocatedStorage = stateRoot === undefined && !(env.PLURNK_SERVICE_DB_PATH ?? "").length;
        if (allocatedStorage) {
            const data = env.XDG_DATA_HOME;
            const root = join(data !== undefined && isAbsolute(data) ? data : join(homedir(), ".local", "share"), "plurnk", "instances");
            await mkdir(root, { recursive: true, mode: 0o700 });
            stateRoot = await mkdtemp(join(root, "client-"));
        }
        const token = randomBytes(32).toString("hex");
        const daemon = await launch.start({
            command, env: { ...env, PLURNK_AGUI_TOKEN: token }, cwd: process.cwd(), stateRoot,
            host: "127.0.0.1", port: 0, lifetime: "private", readyTimeoutMs: timeout, stopGraceMs: grace,
        }).catch((cause: unknown) => {
            if (!(cause instanceof Error) || !("stderr" in cause) || typeof cause.stderr !== "string" || !cause.stderr.trim()) throw cause;
            throw new Error(`${cause.message}\n${cause.stderr.trim()}`, { cause });
        });
        const resumeEnv = {
            PLURNK_AGUI_URL: "",
            PLURNK_HOST: "127.0.0.1",
            PLURNK_PORT: "0",
            ...(stateRoot === undefined ? {} : { PLURNK_SERVICE_STATE_ROOT: stateRoot }),
            PLURNK_SERVICE_DB_PATH: daemon.dbPath,
        };
        return new Backend({ aguiUrl: daemon.url, token }, daemon, resumeEnv, allocatedStorage);
    }

    close(): Promise<void> {
        return this.#closing ??= (async () => { await this.#daemon?.stop(); })();
    }

    [Symbol.asyncDispose](): Promise<void> { return this.close(); }
}
