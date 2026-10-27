// Standard ACP v2 client built on `@agentclientprotocol/sdk` (Streamable HTTP + WebSocket).

import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { createWebSocketStream, type WebSocketConstructor } from "@agentclientprotocol/sdk/experimental/ws-client";
import {
    PROTOCOL_VERSION,
    client,
    methods,
    type ClientConnection,
    type ContentBlock,
    type CreateElicitationRequest,
    type CreateElicitationResponse,
    type DeleteSessionResponse,
    type ForkSessionResponse,
    type InitializeResponse,
    type ListProvidersResponse,
    type ListSessionsResponse,
    type NewSessionRequest,
    type NewSessionResponse,
    type PromptResponse,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type ResumeSessionRequest,
    type ResumeSessionResponse,
    type SessionConfigValueId,
    type SetSessionConfigOptionResponse,
    type UpdateSessionNotification,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import Credential from "./credential.ts";

class NodeWebSocket extends globalThis.WebSocket {
    constructor(
        url: string,
        protocols?: string | string[],
        options?: { headers?: Record<string, string> },
    ) {
        if (options?.headers !== undefined && Object.keys(options.headers).length > 0) {
            super(url, {
                ...(protocols !== undefined
                    ? { protocols: Array.isArray(protocols) ? protocols : [protocols] }
                    : {}),
                headers: options.headers,
            } as unknown as string[]);
        } else if (protocols !== undefined) {
            super(url, protocols);
        } else {
            super(url);
        }
    }
}

export const normalizeAcpUrl = (rawUrl: string): string => {
    const url = new URL(rawUrl);
    if (url.pathname === "/" || url.pathname === "") {
        url.pathname = "/acp";
    }
    return url.toString();
};

export const toAcpWebSocketUrl = (rawUrl: string): string => {
    const url = new URL(normalizeAcpUrl(rawUrl));
    if (url.protocol === "http:") url.protocol = "ws:";
    else if (url.protocol === "https:") url.protocol = "wss:";
    return url.toString();
};

export type SessionUpdateHandler = (notification: UpdateSessionNotification) => void | Promise<void>;

export type PermissionRequestHandler = (
    request: RequestPermissionRequest,
    signal: AbortSignal,
) => Promise<RequestPermissionResponse>;

export type ElicitationRequestHandler = (
    request: CreateElicitationRequest,
    signal: AbortSignal,
) => Promise<CreateElicitationResponse>;

export interface AcpClientOptions {
    readonly url: string;
    readonly token?: string;
    readonly credential?: Credential;
    readonly env?: Record<string, string | undefined>;
    readonly headers?: Readonly<Record<string, string>>;
    readonly clientName?: string;
    readonly clientVersion?: string;
    readonly onSessionUpdate?: SessionUpdateHandler;
    readonly onPermissionRequest?: PermissionRequestHandler;
    readonly onElicitationRequest?: ElicitationRequestHandler;
    readonly onDisconnect?: () => void | Promise<void>;
}

export class AcpClient {
    readonly #url: string;
    readonly #credential: Credential | null;
    readonly #staticHeaders: Record<string, string>;
    readonly #clientName: string;
    readonly #clientVersion: string;
    #connection: ClientConnection | null = null;
    #initResponse: InitializeResponse | null = null;
    #hasConnected = false;
    #explicitlyClosed = false;
    #suppressReplayNotifications = false;
    #reconnectPromise: Promise<ClientConnection> | null = null;
    readonly #boundSessions = new Map<string, string>();
    readonly #updateListeners = new Set<SessionUpdateHandler>();
    readonly #disconnectListeners = new Set<() => void | Promise<void>>();
    #permissionHandler: PermissionRequestHandler | undefined;
    #elicitationHandler: ElicitationRequestHandler | undefined;

    constructor(options: AcpClientOptions) {
        this.#url = normalizeAcpUrl(options.url);
        this.#credential = options.credential ?? (options.token ? null : new Credential(options.env));
        this.#staticHeaders = {
            ...(options.headers ?? {}),
            ...(options.token !== undefined && options.token.length > 0
                ? { Authorization: `Bearer ${options.token}` }
                : {}),
        };
        this.#clientName = options.clientName ?? "@plurnk/plurnk";
        this.#clientVersion = options.clientVersion ?? "1.0.0";
        if (options.onSessionUpdate !== undefined) {
            this.#updateListeners.add(options.onSessionUpdate);
        }
        if (options.onDisconnect !== undefined) {
            this.#disconnectListeners.add(options.onDisconnect);
        }
        this.#permissionHandler = options.onPermissionRequest;
        this.#elicitationHandler = options.onElicitationRequest;
    }

    get url(): string {
        return this.#url;
    }

    get wsUrl(): string {
        return toAcpWebSocketUrl(this.#url);
    }

    get initializeResponse(): InitializeResponse | null {
        return this.#initResponse;
    }

    get closed(): Promise<void> {
        return this.#connection?.closed ?? Promise.resolve();
    }

    get signal(): AbortSignal | undefined {
        return this.#connection?.signal;
    }

    onSessionUpdate(listener: SessionUpdateHandler): () => void {
        this.#updateListeners.add(listener);
        return () => {
            this.#updateListeners.delete(listener);
        };
    }

    onDisconnect(listener: () => void | Promise<void>): () => void {
        this.#disconnectListeners.add(listener);
        return () => {
            this.#disconnectListeners.delete(listener);
        };
    }

    setPermissionHandler(handler: PermissionRequestHandler | undefined): void {
        this.#permissionHandler = handler;
    }

    setElicitationHandler(handler: ElicitationRequestHandler | undefined): void {
        this.#elicitationHandler = handler;
    }

    async connect(): Promise<InitializeResponse> {
        if (this.#connection !== null && !this.#connection.signal.aborted && this.#initResponse !== null) {
            return this.#initResponse;
        }
        this.#explicitlyClosed = false;

        const credHeaders = this.#credential !== null ? await this.#credential.headers(this.#url) : {};
        const headers: Record<string, string> = {
            ...credHeaders,
            ...this.#staticHeaders,
        };

        const app = client({ name: this.#clientName });

        app.onNotification(methods.client.session.update, async (ctx) => {
            if (this.#suppressReplayNotifications) return;
            for (const listener of this.#updateListeners) {
                await listener(ctx.params);
            }
        });

        app.onRequest(methods.client.session.requestPermission, async (ctx): Promise<RequestPermissionResponse> => {
            if (this.#permissionHandler === undefined) {
                return { outcome: { outcome: "cancelled" } };
            }
            return await this.#permissionHandler(ctx.params, ctx.signal);
        });

        app.onRequest(methods.client.elicitation.create, async (ctx): Promise<CreateElicitationResponse> => {
            if (this.#elicitationHandler === undefined) {
                return { action: "cancel" };
            }
            return await this.#elicitationHandler(ctx.params, ctx.signal);
        });

        const parsedUrl = new URL(this.#url);
        const isWebSocket = parsedUrl.protocol === "ws:" || parsedUrl.protocol === "wss:";

        const stream = isWebSocket
            ? createWebSocketStream(this.#url, {
                  WebSocket: NodeWebSocket as unknown as WebSocketConstructor,
                  headers,
              })
            : createHttpStream(this.#url, {
                  fetch: async (input, init) => {
                      const merged = new Headers(init?.headers);
                      for (const [k, v] of Object.entries(headers)) {
                          if (!merged.has(k)) merged.set(k, v);
                      }
                      return await globalThis.fetch(input, { ...init, headers: merged });
                  },
              });

        const conn = app.connect(stream);
        this.#connection = conn;
        void conn.closed.finally(() => {
            if (this.#connection === conn) {
                this.#connection = null;
                this.#initResponse = null;
                if (!this.#explicitlyClosed) {
                    for (const listener of this.#disconnectListeners) {
                        void Promise.resolve(listener()).catch(() => undefined);
                    }
                }
            }
        });

        const initRes = await conn.agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            info: {
                name: this.#clientName,
                title: "PLURNK Terminal Client",
                version: this.#clientVersion,
            },
            capabilities: {
                elicitation: {
                    form: {},
                },
            },
        });
        this.#initResponse = initRes;
        this.#hasConnected = true;
        return initRes;
    }

    async #ensureConnection(options?: { readonly excludeSessionId?: string }): Promise<ClientConnection> {
        if (this.#connection !== null && !this.#connection.signal.aborted) {
            return this.#connection;
        }
        if (!this.#hasConnected) {
            throw new Error("AcpClient is not connected; call connect() first.");
        }
        if (this.#reconnectPromise !== null) {
            return await this.#reconnectPromise;
        }
        this.#reconnectPromise = (async () => {
            this.#connection = null;
            this.#initResponse = null;
            await this.connect();
            const conn = this.#connection as ClientConnection | null;
            if (conn === null) {
                throw new Error("AcpClient failed to reconnect.");
            }
            if (this.#boundSessions.size > 0) {
                this.#suppressReplayNotifications = true;
                try {
                    for (const [sessionId, cwd] of this.#boundSessions) {
                        if (sessionId === options?.excludeSessionId) continue;
                        await conn.agent.request(methods.agent.session.resume, {
                            sessionId,
                            cwd,
                        });
                    }
                } finally {
                    this.#suppressReplayNotifications = false;
                }
            }
            return conn;
        })();
        try {
            return await this.#reconnectPromise;
        } finally {
            this.#reconnectPromise = null;
        }
    }

    async #withAutoReconnect<T>(
        fn: (conn: ClientConnection) => Promise<T>,
        options?: { readonly excludeSessionId?: string },
    ): Promise<T> {
        const conn = await this.#ensureConnection(options);
        let updatesDuringCall = 0;
        const off = this.onSessionUpdate(() => {
            updatesDuringCall += 1;
        });
        try {
            return await fn(conn);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const isStalePreFlight =
                updatesDuringCall === 0 &&
                (msg.includes("ACP HTTP stream is closed") || msg.includes("Unknown Acp-Connection-Id"));
            if (!isStalePreFlight || this.#explicitlyClosed) {
                throw err;
            }
            if (this.#connection === conn) {
                this.#connection = null;
                this.#initResponse = null;
            }
            const reconnected = await this.#ensureConnection(options);
            return await fn(reconnected);
        } finally {
            off();
        }
    }

    async newSession(cwd: string, extra?: Omit<NewSessionRequest, "cwd">): Promise<NewSessionResponse> {
        const res = await this.#withAutoReconnect((conn) =>
            conn.agent.request(methods.agent.session.new, {
                cwd,
                ...extra,
            }),
        );
        this.#boundSessions.set(res.sessionId, cwd);
        return res;
    }

    async resumeSession(
        sessionId: string,
        cwd: string,
        extra?: Omit<ResumeSessionRequest, "sessionId" | "cwd">,
    ): Promise<ResumeSessionResponse> {
        const res = await this.#withAutoReconnect(
            (conn) =>
                conn.agent.request(methods.agent.session.resume, {
                    sessionId,
                    cwd,
                    ...extra,
                }),
            { excludeSessionId: sessionId },
        );
        this.#boundSessions.set(sessionId, cwd);
        return res;
    }

    async listSessions(cwd?: string): Promise<ListSessionsResponse> {
        return await this.#withAutoReconnect((conn) =>
            conn.agent.request(methods.agent.session.list, {
                ...(cwd !== undefined ? { cwd } : {}),
            }),
        );
    }

    async listProviders(): Promise<ListProvidersResponse> {
        return await this.#withAutoReconnect((conn) => conn.agent.request(methods.agent.providers.list, {}));
    }

    async forkSession(sessionId: string, cwd: string): Promise<ForkSessionResponse> {
        const res = await this.#withAutoReconnect((conn) =>
            conn.agent.request(methods.agent.session.fork, {
                sessionId,
                cwd,
            }),
        );
        this.#boundSessions.set(res.sessionId, cwd);
        return res;
    }

    async deleteSession(sessionId: string): Promise<DeleteSessionResponse | void> {
        const res = await this.#withAutoReconnect((conn) =>
            conn.agent.request(methods.agent.session.delete, { sessionId }),
        );
        this.#boundSessions.delete(sessionId);
        return res;
    }

    async closeSession(sessionId: string): Promise<void> {
        await this.#withAutoReconnect((conn) => conn.agent.request(methods.agent.session.close, { sessionId }));
        this.#boundSessions.delete(sessionId);
    }

    async setConfigOption(
        sessionId: string,
        configId: string,
        value: SessionConfigValueId | boolean,
    ): Promise<SetSessionConfigOptionResponse> {
        const req = typeof value === "boolean"
            ? { sessionId, configId, type: "boolean" as const, value }
            : { sessionId, configId, type: "id" as const, value };
        return await this.#withAutoReconnect((conn) =>
            conn.agent.request(methods.agent.session.setConfigOption, req),
        );
    }

    async prompt(
        sessionId: string,
        prompt: string | ContentBlock | ContentBlock[],
        meta?: Record<string, unknown>,
    ): Promise<PromptResponse> {
        const blocks: ContentBlock[] = typeof prompt === "string"
            ? [{ type: "text", text: prompt }]
            : Array.isArray(prompt)
                ? prompt
                : [prompt];
        return await this.#withAutoReconnect((conn) =>
            conn.agent.request(methods.agent.session.prompt, {
                sessionId,
                prompt: blocks,
                ...(meta !== undefined ? { _meta: meta } : {}),
            }),
        );
    }

    async cancel(sessionId: string): Promise<void> {
        await this.#withAutoReconnect((conn) => conn.agent.notify(methods.agent.session.cancel, { sessionId }));
    }

    async action<T = unknown>(
        kind: string,
        params: Record<string, unknown> = {},
        context?: {
            readonly workspace?: string;
            readonly workspaceId?: number;
            readonly session?: string;
            readonly sessionId?: string;
            readonly cwd?: string;
        },
    ): Promise<T> {
        if (!this.#hasConnected) {
            await this.connect();
        }
        return await this.#withAutoReconnect((conn) =>
            conn.agent.request<T>("_plurnk/action", {
                kind,
                params,
                ...(context?.workspace !== undefined ? { workspace: context.workspace } : {}),
                ...(context?.workspaceId !== undefined ? { workspaceId: context.workspaceId } : {}),
                ...(context?.session !== undefined ? { session: context.session } : {}),
                ...(context?.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
                ...(context?.cwd !== undefined ? { cwd: context.cwd } : {}),
            }),
        );
    }

    close(): void {
        this.#explicitlyClosed = true;
        this.#hasConnected = false;
        this.#boundSessions.clear();
        if (this.#connection !== null) {
            this.#connection.close();
            this.#connection = null;
            this.#initResponse = null;
        }
    }
}
