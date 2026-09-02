import { ProblemError, clientWebNotInstalled } from "./diagnostics.ts";

export interface WebPortalLaunch {
    host?: string;
    port?: string;
    upstream: URL;
    token?: string;
    constraints: { workspace?: string; threadId?: string };
    workspaceProperties: Readonly<Record<string, unknown>>;
    // Already-resolved AG-UI properties. The optional presentation module
    // forwards this opaque record; it does not own client configuration.
    runProperties: Readonly<Record<string, unknown>>;
    prepareSession?(session: { workspace: string; threadId: string }): Promise<void>;
    autoAcceptProposals: boolean;
}

interface RunningWebPortal {
    origin: string;
    close(): Promise<void>;
}

interface WebModule {
    startClientPortal(options: WebPortalLaunch): Promise<RunningWebPortal>;
}

export type WebModuleLoader = () => Promise<WebModule>;

const loadWebModule: WebModuleLoader = async () => {
    const packageName = "@plurnk/plurnk-web";
    return await import(packageName) as WebModule;
};

const waitForStop = (): Promise<void> => new Promise((resolve) => {
    const stop = (): void => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
});

const packageMissing = (cause: unknown): boolean => {
    const error = cause as NodeJS.ErrnoException;
    return error?.code === "ERR_MODULE_NOT_FOUND"
        && /Cannot find package ['"]@plurnk\/plurnk-web['"]/.test(error.message);
};

export const launchWeb = async (
    options: WebPortalLaunch,
    dependencies: {
        load?: WebModuleLoader;
        wait?: () => Promise<void>;
        announce?: (origin: string) => void;
    } = {},
): Promise<number> => {
    let module: WebModule;
    try {
        module = await (dependencies.load ?? loadWebModule)();
    } catch (cause) {
        if (packageMissing(cause)) throw new ProblemError(clientWebNotInstalled(), 127);
        throw cause;
    }
    const portal = await module.startClientPortal(options);
    dependencies.announce?.(portal.origin);
    try {
        await (dependencies.wait ?? waitForStop)();
    } finally {
        await portal.close();
    }
    return 0;
};
