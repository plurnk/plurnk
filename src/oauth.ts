import type { ChildProcess } from "node:child_process";
import { addAbortListener, once } from "node:events";
import { createServer } from "node:http";

interface ReceptionOptions {
    readonly signal: AbortSignal;
    readonly write: (text: string) => void;
    readonly openBrowser?: (url: string) => Promise<ChildProcess | void>;
}

// {§cli-mcp-oauth-callback} Only reception belongs here; the daemon validates and exchanges the grant.
export const receiveAuthorization = async <T>(
    authorizationUrl: string,
    complete: (callbackUrl: string) => Promise<T>,
    { signal, write, openBrowser = async (url) => (await import("open")).default(url) }: ReceptionOptions,
): Promise<T> => {
    signal.throwIfAborted();
    const authorization = new URL(authorizationUrl);
    const states = authorization.searchParams.getAll("state");
    const redirects = authorization.searchParams.getAll("redirect_uri");
    if (states.length !== 1 || states[0].length === 0 || redirects.length !== 1) {
        throw new Error("MCP authorization must supply one state and redirect_uri.");
    }
    const redirect = new URL(redirects[0]);
    if (redirect.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(redirect.hostname)
        || redirect.port === "0" || redirect.username || redirect.password || redirect.hash) {
        throw new Error("Automatic OAuth reception requires an HTTP loopback IP redirect with a usable port. Submit the callback URL directly for other redirects.");
    }
    if (authorization.protocol !== "https:" && !(authorization.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(authorization.hostname))) {
        throw new Error("OAuth authorization must use HTTPS (or HTTP loopback).");
    }
    const completed = Promise.withResolvers<T>();
    let consumed = false;
    const browserObservers = new DisposableStack();
    const browserFailed = (cause: unknown): void => {
        if (browserObservers.disposed) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        try { write(`  Could not open the browser: ${message}. Open the authorization URL above on this machine.\n`); }
        catch (error) { completed.reject(error); }
    };
    const browserExited = (code: number | null, exitSignal: NodeJS.Signals | null): void => {
        if (code !== 0) browserFailed(new Error(`launcher exited ${exitSignal ?? code}`));
    };
    const server = createServer((request, response) => {
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.setHeader("cache-control", "no-store");
        response.setHeader("referrer-policy", "no-referrer");
        if (request.method !== "GET") { response.writeHead(405).end(); return; }
        if (request.headers.host !== redirect.host || !request.url?.startsWith("/") || request.url.startsWith("//")) {
            response.writeHead(400).end(); return;
        }
        const callback = URL.parse(request.url, redirect.href);
        if (callback === null || callback.origin !== redirect.origin) { response.writeHead(400).end(); return; }
        if (callback.pathname !== redirect.pathname) { response.writeHead(404).end(); return; }
        const parameters = callback.searchParams;
        const ambiguous = [...new Set(parameters.keys())].some((key) => parameters.getAll(key).length !== 1);
        const responseCount = Number(parameters.has("code")) + Number(parameters.has("error"));
        const changedQuery = [...redirect.searchParams].some(([key, value]) => parameters.get(key) !== value);
        if (ambiguous || changedQuery || parameters.get("state") !== states[0] || responseCount !== 1
            || parameters.get("code") === "" || parameters.get("error") === "") {
            response.writeHead(400).end(); return;
        }
        if (consumed) { response.writeHead(409).end(); return; }
        consumed = true;
        void Promise.resolve().then(() => complete(callback.href)).then(
            (result) => response.end("Authorization completed. You may close this window.", () => completed.resolve(result)),
            (cause: unknown) => response.writeHead(400).end("Authorization could not be completed. Return to the client for details.", () => completed.reject(cause)),
        );
    });
    const abort = addAbortListener(signal, () => completed.reject(signal.reason));
    const failed = (error: Error): void => completed.reject(error);
    server.on("error", failed);
    try {
        const listening = once(server, "listening", { signal });
        server.listen({ port: redirect.port.length === 0 ? 80 : Number(redirect.port), host: redirect.hostname.replace(/^\[|\]$/gu, ""), signal });
        // Observe completion failures even while binding; occupied ports must not leave a rejection behind.
        await Promise.race([listening, completed.promise]);
        const opening = Promise.resolve().then(() => openBrowser(authorization.href)).then((child) => {
            if (child === undefined || browserObservers.disposed) return;
            if (child.exitCode !== null || child.signalCode !== null) browserExited(child.exitCode, child.signalCode);
            else {
                child.once("close", browserExited);
                browserObservers.defer(() => child.off("close", browserExited));
            }
        }, browserFailed);
        const [result] = await Promise.all([completed.promise, opening]);
        return result;
    } finally {
        browserObservers.dispose();
        abort[Symbol.dispose]();
        server.off("error", failed);
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
};
