// CLI daemon passthrough, catalog `update`, and OIDC `login`/`logout` subcommands
// ({§cli-subcommands}, {§cli-problems-and-notices}).

import { spawn } from "node:child_process";
import { AcpClient } from "./acp-client.ts";
import {
    ClientCliError,
    ensureDaemonConnected,
    resolveServiceCommand,
    type CliCommonOptions,
} from "./cli-connection.ts";

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

export const runCliLogin = async (options: CliCommonOptions): Promise<number> => {
    const grant = await options.credential.login(options.url, {
        signal: AbortSignal.timeout(options.oauthTimeoutMs),
        write: (message) => (options.json ? process.stderr : process.stdout).write(message),
    });
    if (options.json) {
        process.stdout.write(
            `${JSON.stringify(
                {
                    status: "authorized",
                    issuer: grant.issuer,
                    clientId: grant.clientId,
                    expiresAt: grant.expiresAt,
                    grantsPath: options.credential.grantsPath(),
                },
                null,
                2,
            )}\n`,
        );
    } else {
        process.stdout.write(`authorized: ${grant.issuer} (${options.credential.grantsPath()})\n`);
    }
    return 0;
};

export const runCliLogout = async (options: CliCommonOptions): Promise<number> => {
    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
    });
    try {
        await client.connect();
        await client.logout();
    } catch {
        // best-effort ACP logout before local grant revocation
    } finally {
        client.close();
    }
    const { revoked, origin } = await options.credential.logout(options.url);
    if (options.json) {
        process.stdout.write(`${JSON.stringify({ status: revoked ? "revoked" : "none", origin }, null, 2)}\n`);
    } else {
        process.stdout.write(revoked ? `logged out: ${origin}\n` : `no stored grant for ${origin}\n`);
    }
    return 0;
};

const spawnServiceForeground = async (
    subcommandArgs: readonly string[],
    options: CliCommonOptions,
): Promise<number> => {
    const cmd = resolveServiceCommand(options.serviceBin, subcommandArgs);
    return await new Promise<number>((resolveCode, rejectErr) => {
        const child = spawn(cmd.file, cmd.args, {
            cwd: options.cwd,
            env: {
                ...process.env,
                ...options.env,
            },
            stdio: "inherit",
        });
        child.once("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "ENOENT") {
                rejectErr(
                    new ClientCliError(
                        {
                            type: "https://problems.plurnk.xyz/client/daemon/not-installed",
                            title: "Service not installed",
                            status: 503,
                            detail: "Could not find `plurnk-service` to run `plurnk daemon`. Install `@plurnk/plurnk-service` (`npm install -g --ignore-scripts @plurnk/plurnk-service`).",
                        },
                        127,
                    ),
                );
                return;
            }
            rejectErr(err);
        });
        child.once("close", (code, signal) => {
            resolveCode(code ?? (signal ? 1 : 0));
        });
    });
};

export const runCliDaemon = async (
    daemonArgs: readonly string[],
    options: CliCommonOptions,
): Promise<number> => {
    const sub = daemonArgs[0];
    if (sub === "restart") {
        if (daemonArgs.length > 1) {
            throw new ClientCliError(
                {
                    type: "https://problems.plurnk.xyz/client/usage",
                    title: "Invalid daemon arguments",
                    status: 400,
                    detail: "usage: plurnk daemon restart",
                },
                64,
            );
        }
        const stopCode = await spawnServiceForeground(["stop"], options);
        if (stopCode !== 0) return stopCode;
        const client = new AcpClient({
            url: options.url,
            credential: options.credential,
            env: options.env,
        });
        try {
            await ensureDaemonConnected(client, { ...options, autostart: true });
        } finally {
            client.close();
        }
        if (options.json) {
            process.stdout.write(`${JSON.stringify({ status: "restarted", url: options.url }, null, 2)}\n`);
        } else {
            process.stdout.write(`daemon: restarted (${options.url})\n`);
        }
        return 0;
    }
    const normalizedArgs =
        daemonArgs.length === 0
            ? ["config"]
            : sub === "status"
              ? ["config", ...daemonArgs.slice(1)]
              : daemonArgs;
    return await spawnServiceForeground(normalizedArgs, options);
};
