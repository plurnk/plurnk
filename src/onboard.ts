// Minimal pre-prompt first-run model bootstrap (`plurnk onboard`) ({§cli-model-selection}, {§cli-subcommands}).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import readline from "node:readline";
import { AcpClient } from "./acp-client.ts";
import {
    ClientCliError,
    ensureDaemonConnected,
    openCliSession,
    type CliCommonOptions,
} from "./cli-runner.ts";

const LOCAL_PROBE_TIMEOUT_MS = 1200;

interface LocalCandidate {
    readonly label: string;
    readonly alias: string;
    readonly selector: string;
    readonly baseUrl?: string;
}

interface HostedProvider {
    readonly id: string;
    readonly label: string;
    readonly envKey: string;
    readonly preferred: RegExp;
}

const HOSTED_PROVIDERS: readonly HostedProvider[] = [
    { id: "anthropic", label: "Anthropic", envKey: "ANTHROPIC_API_KEY", preferred: /claude-sonnet-4|claude-3-7-sonnet/iu },
    { id: "openai", label: "OpenAI", envKey: "OPENAI_API_KEY", preferred: /gpt-5|gpt-4\.1|o4-mini/iu },
    { id: "google", label: "Google Gemini", envKey: "GEMINI_API_KEY", preferred: /gemini-2\.5-pro|gemini-2\.5-flash/iu },
    { id: "deepseek", label: "DeepSeek", envKey: "DEEPSEEK_API_KEY", preferred: /deepseek-chat|deepseek-v3/iu },
    { id: "openrouter", label: "OpenRouter", envKey: "OPENROUTER_API_KEY", preferred: /claude-sonnet-4|qwen3-coder/iu },
];

export interface OnboardIo {
    readonly write?: (text: string) => void;
    readonly askLine?: (prompt: string) => Promise<string>;
    readonly askSecret?: (prompt: string) => Promise<string>;
    readonly ollamaOrigin?: string;
    readonly llamaServerOrigin?: string;
}

const quoteDotenvValue = (val: string): string =>
    /^[A-Za-z0-9_./:@-]+$/u.test(val) ? val : JSON.stringify(val);

export const upsertOperatorEnv = (
    filePath: string,
    updates: Readonly<Record<string, string | null>>,
): void => {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const existing = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
    const lines = existing.length > 0 ? existing.replace(/\r\n/gu, "\n").split("\n") : [];
    if (lines.at(-1) === "") lines.pop();

    const handled = new Set<string>();
    const rewritten: string[] = [];
    for (const line of lines) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=/u.exec(line);
        if (m !== null && Object.hasOwn(updates, m[1]!)) {
            const key = m[1]!;
            handled.add(key);
            const nextVal = updates[key];
            if (nextVal !== null && nextVal !== undefined) {
                rewritten.push(`${key}=${quoteDotenvValue(nextVal)}`);
            }
            continue;
        }
        rewritten.push(line);
    }
    for (const [key, val] of Object.entries(updates)) {
        if (!handled.has(key) && val !== null && val !== undefined) {
            rewritten.push(`${key}=${quoteDotenvValue(val)}`);
        }
    }
    writeFileSync(filePath, `${rewritten.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
    try {
        chmodSync(filePath, 0o600);
    } catch {
        // ignore chmod failures on filesystems without POSIX mode bits
    }
};

const probeLocalCandidates = async (
    ollamaOrigin: string,
    llamaServerOrigin: string,
): Promise<LocalCandidate[]> => {
    const found: LocalCandidate[] = [];
    await Promise.all([
        fetch(`${ollamaOrigin}/api/tags`, { signal: AbortSignal.timeout(LOCAL_PROBE_TIMEOUT_MS) })
            .then(async (res) => {
                if (!res.ok) return;
                const doc = (await res.json()) as { models?: Array<{ name?: string }> };
                const model = doc.models?.find((m) => typeof m?.name === "string" && m.name.length > 0)?.name;
                if (model) {
                    found.push({
                        label: `Local Ollama (${model} at ${ollamaOrigin})`,
                        alias: "local",
                        selector: `ollama/${model}`,
                        ...(ollamaOrigin !== "http://127.0.0.1:11434" ? { baseUrl: ollamaOrigin } : {}),
                    });
                }
            })
            .catch(() => undefined),
        fetch(`${llamaServerOrigin}/v1/models`, { signal: AbortSignal.timeout(LOCAL_PROBE_TIMEOUT_MS) })
            .then(async (res) => {
                if (!res.ok) return;
                const doc = (await res.json()) as { data?: Array<{ id?: string }> };
                const model = doc.data?.find((m) => typeof m?.id === "string" && m.id.length > 0)?.id;
                if (model) {
                    found.push({
                        label: `Local llama-server (${model} at ${llamaServerOrigin})`,
                        alias: "local",
                        selector: `openai/${model}`,
                        baseUrl: `${llamaServerOrigin}/v1`,
                    });
                }
            })
            .catch(() => undefined),
    ]);
    return found;
};

const defaultAskLine = async (prompt: string, write: (text: string) => void): Promise<string> => {
    write(prompt);
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    return await new Promise<string>((resolvePromise, rejectPromise) => {
        rl.once("line", (line) => {
            rl.close();
            resolvePromise(line.trim());
        });
        rl.once("close", () => resolvePromise(""));
        rl.once("error", (err) => {
            rl.close();
            rejectPromise(err);
        });
    });
};

const defaultAskSecret = async (prompt: string, write: (text: string) => void): Promise<string> => {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
        const val = await defaultAskLine(prompt, write);
        return val;
    }
    write(prompt);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    return await new Promise<string>((resolvePromise, rejectPromise) => {
        let buf = "";
        const cleanup = (): void => {
            process.stdin.off("data", onData);
            try {
                process.stdin.setRawMode(Boolean(wasRaw));
            } catch {
                // ignore
            }
            process.stdin.pause();
        };
        const onData = (chunk: Buffer | string): void => {
            const str = typeof chunk === "string" ? chunk : chunk.toString("utf8");
            for (const ch of str) {
                if (ch === "\r" || ch === "\n") {
                    cleanup();
                    write("\n");
                    resolvePromise(buf.trim());
                    return;
                }
                if (ch === "\x03") {
                    cleanup();
                    write("\n");
                    rejectPromise(new Error("Onboarding cancelled."));
                    return;
                }
                if (ch === "\x7f" || ch === "\b") {
                    buf = buf.slice(0, -1);
                    continue;
                }
                if (ch >= " ") {
                    buf += ch;
                }
            }
        };
        process.stdin.on("data", onData);
    });
};

export const resolveOperatorConfigPath = (env: Record<string, string | undefined>): string => {
    const xdg = env.XDG_CONFIG_HOME;
    const base = typeof xdg === "string" && xdg.trim().length > 0
        ? xdg.trim()
        : join(env.HOME || homedir(), ".config");
    return join(base, "plurnk", ".env");
};

export const checkNeedsAutoOnboard = async (options: CliCommonOptions): Promise<boolean> => {
    if (
        options.repl ||
        options.auto ||
        options.json ||
        options.model !== undefined ||
        !process.stdin.isTTY ||
        !process.stdout.isTTY
    ) {
        return false;
    }
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    try {
        await ensureDaemonConnected(client, options);
        const modelsRes = await client.action<{ readonly items?: readonly unknown[] }>("models.list", { limit: 1 });
        if (Array.isArray(modelsRes.items) && modelsRes.items.length > 0) {
            return false;
        }
        const session = await openCliSession(client, {
            ...options,
            sessionId: options.sessionId ?? options.tuiSession ?? "user",
        });
        const modelOpt = session.configOptions.find((o) => o.configId === "model");
        const currentModel =
            modelOpt !== undefined && "currentValue" in modelOpt ? String(modelOpt.currentValue) : "none";
        return currentModel === "" || currentModel === "none";
    } catch {
        return false;
    } finally {
        client.close();
    }
};

export const runCliOnboard = async (
    options: CliCommonOptions,
    io?: OnboardIo,
): Promise<number> => {
    const write = io?.write ?? ((text: string) => process.stderr.write(text));
    const askLine = io?.askLine ?? ((prompt: string) => defaultAskLine(prompt, write));
    const askSecret = io?.askSecret ?? ((prompt: string) => defaultAskSecret(prompt, write));

    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });

    try {
        await ensureDaemonConnected(client, options);
        const locals = await probeLocalCandidates(
            io?.ollamaOrigin ?? "http://127.0.0.1:11434",
            io?.llamaServerOrigin ?? "http://127.0.0.1:8080",
        );

        write("Plurnk setup — choose a model source:\n");
        let idx = 1;
        for (const loc of locals) {
            write(`  [${String(idx)}] ${loc.label}\n`);
            idx += 1;
        }
        const firstHostedIdx = idx;
        for (const hp of HOSTED_PROVIDERS) {
            write(`  [${String(idx)}] ${hp.label} (${hp.envKey})\n`);
            idx += 1;
        }

        const rawChoice = await askLine(`Choice [1-${String(idx - 1)}] (default 1): `);
        const choiceNum = rawChoice.length === 0 ? 1 : Number.parseInt(rawChoice, 10);
        if (!Number.isInteger(choiceNum) || choiceNum < 1 || choiceNum >= idx) {
            throw new ClientCliError(
                {
                    type: "https://problems.plurnk.xyz/client/usage",
                    title: "Invalid selection",
                    status: 400,
                    detail: `Expected a number between 1 and ${String(idx - 1)}.`,
                },
                64,
            );
        }

        const configPath = resolveOperatorConfigPath(options.env);
        let chosenAlias = "";
        let chosenSelector = "";

        if (choiceNum < firstHostedIdx) {
            const loc = locals[choiceNum - 1]!;
            chosenAlias = loc.alias;
            chosenSelector = loc.selector;
            upsertOperatorEnv(configPath, {
                [`PLURNK_MODEL_${chosenAlias}`]: chosenSelector,
                ...(loc.baseUrl !== undefined
                    ? { [`PLURNK_BASEURL_${chosenAlias}`]: loc.baseUrl }
                    : { [`PLURNK_BASEURL_${chosenAlias}`]: null }),
                PLURNK_MODEL: chosenAlias,
            });
            await client.action("models.list", { limit: 1 });
        } else {
            const hp = HOSTED_PROVIDERS[choiceNum - firstHostedIdx]!;
            const apiKey = await askSecret(`${hp.envKey} (input hidden): `);
            if (apiKey.length === 0) {
                throw new ClientCliError(
                    {
                        type: "https://problems.plurnk.xyz/client/usage",
                        title: "Missing API key",
                        status: 400,
                        detail: `${hp.envKey} cannot be empty.`,
                    },
                    64,
                );
            }
            upsertOperatorEnv(configPath, {
                [hp.envKey]: apiKey,
            });
            const catalog = await client.action<{
                readonly items?: ReadonlyArray<{ readonly selector?: string }>;
            }>("models.list", { provider: hp.id, limit: 100 });
            const selectors = (catalog.items ?? [])
                .map((m) => (typeof m?.selector === "string" ? m.selector : ""))
                .filter(Boolean);
            if (selectors.length === 0) {
                throw new ClientCliError(
                    {
                        type: "https://problems.plurnk.xyz/client/onboard/no-models",
                        title: "No ready models",
                        status: 502,
                        detail: `Saved ${hp.envKey} to ${configPath}, but the daemon reported 0 ready models for provider "${hp.id}". Run \`plurnk daemon reload\` or check \`plurnk models --provider ${hp.id} --all\`.`,
                    },
                    1,
                );
            }
            chosenAlias = hp.id;
            chosenSelector = selectors.find((s) => hp.preferred.test(s)) ?? selectors[0]!;
            upsertOperatorEnv(configPath, {
                [`PLURNK_MODEL_${chosenAlias}`]: chosenSelector,
                PLURNK_MODEL: chosenAlias,
            });
            await client.action("models.list", { provider: hp.id, limit: 1 });
        }

        write(`Verifying ${chosenSelector}...\n`);
        const checkSession = await openCliSession(client, {
            ...options,
            sessionId: undefined,
            model: chosenAlias,
        });
        try {
            await client.prompt(
                checkSession.sessionId,
                [{ type: "text", text: "Reply with OK." }],
                {
                    plurnk: {
                        interactive: false,
                        maxTurns: 1,
                        envelope: { auto: true },
                    },
                },
            );
        } finally {
            await client.deleteSession(checkSession.sessionId).catch(() => undefined);
        }
        write(`Saved to ${configPath} and verified ${chosenSelector}.\n`);
        return 0;
    } finally {
        client.close();
    }
};
