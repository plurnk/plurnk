// Standard ACP v2 client built on `@agentclientprotocol/sdk` (Streamable HTTP + WebSocket)
// ({§cli-conformance}, {§cli-sessions-topology}, {§cli-inline-review}).

import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { createWebSocketStream, type WebSocketConstructor } from "@agentclientprotocol/sdk/experimental/ws-client";
import {
    client,
    methods,
    PROTOCOL_VERSION,
    type ArchiveSessionResponse,
    type AuthStatusResponse,
    type CancelTerminalResponse,
    type CancelToolCallResponse,
    type ClientConnection,
    type ContentBlock,
    type CreateElicitationResponse,
    type DeleteSessionResponse,
    type ForkSessionRequest,
    type ForkSessionResponse,
    type InitializeResponse,
    type ListProvidersResponse,
    type ListSessionsResponse,
    type LogoutAuthResponse,
    type NewSessionRequest,
    type NewSessionResponse,
    type PromptResponse,
    type RequestPermissionResponse,
    type ResumeSessionRequest,
    type ResumeSessionResponse,
    type SessionConfigValueId,
    type SessionOptionsRequest,
    type SessionOptionsResponse,
    type SessionStatusResponse,
    type SetSessionConfigOptionResponse,
    type SetSessionTitleResponse,
    type UnarchiveSessionResponse,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {
    ACP_ACTION_KINDS,
    type AcpClientOptions,
    type AuthStatusUpdateHandler,
    type ElicitationRequestHandler,
    type PermissionRequestHandler,
    type PlurnkActionContext,
    type PlurnkActionEntry,
    type PlurnkActionKind,
    type PlurnkActionMap,
    type PlurnkFamilyListResult,
    type ScheduleActionInput,
    type ScheduledStepReceipt,
    type ScheduledToolCall,
    type ScheduleRunResult,
    type SessionUpdateHandler,
} from "./acp-client-actions.ts";
import {
    classifyPreFlightDisconnect,
    fetchWithCredentialRetry,
    hydrateSessionUpdate,
    isTruthyKnob,
    NodeWebSocket,
    normalizeAcpUrl,
    PACKAGE_CLIENT_VERSION,
    reconnectBoundSessions,
    scrubAcpMeta,
    toAcpWebSocketUrl,
    wrapStreamWithMetaScrubber,
    type BoundSessionEntry,
} from "./acp-client-transport.ts";
import type { AcpSession } from "./acp-session.ts";
import Credential from "./credential.ts";

export {
    ACP_ACTION_KINDS,
    classifyPreFlightDisconnect,
    normalizeAcpUrl,
    scrubAcpMeta,
    toAcpWebSocketUrl,
    type AcpClientOptions,
    type AuthStatusUpdateHandler,
    type ElicitationRequestHandler,
    type PermissionRequestHandler,
    type PlurnkActionContext,
    type PlurnkActionEntry,
    type PlurnkActionKind,
    type PlurnkActionMap,
    type PlurnkFamilyListResult,
    type ScheduleActionInput,
    type ScheduledStepReceipt,
    type ScheduledToolCall,
    type ScheduleRunResult,
    type SessionUpdateHandler,
};

export class AcpClient {
    readonly #url: string;
    readonly #credential: Credential | null;
    readonly #staticHeaders: Record<string, string>;
    readonly #clientName: string;
    readonly #clientVersion: string;
    readonly #debugNoMeta: boolean;
    #connection: ClientConnection | null = null;
    #initResponse: InitializeResponse | null = null;
    #hasConnected = false;
    #explicitlyClosed = false;
    #reconnectPromise: Promise<ClientConnection> | null = null;
    readonly #boundSessions = new Map<string, BoundSessionEntry>();
    readonly #updateListeners = new Set<SessionUpdateHandler>();
    readonly #authStatusListeners = new Set<AuthStatusUpdateHandler>();
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
        this.#clientVersion = options.clientVersion ?? PACKAGE_CLIENT_VERSION;
        this.#debugNoMeta =
            typeof options.debugNoMeta === "boolean"
                ? options.debugNoMeta
                : isTruthyKnob(options.env?.PLURNK_CLIENT_DEBUG_NO_META);
        if (options.onSessionUpdate !== undefined) {
            this.#updateListeners.add(options.onSessionUpdate);
        }
        if (options.onAuthStatusUpdate !== undefined) {
            this.#authStatusListeners.add(options.onAuthStatusUpdate);
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

    onAuthStatusUpdate(listener: AuthStatusUpdateHandler): () => void {
        this.#authStatusListeners.add(listener);
        return () => {
            this.#authStatusListeners.delete(listener);
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

    async #resolveHeaders(): Promise<Record<string, string>> {
        const credHeaders = this.#credential !== null ? await this.#credential.headers(this.#url) : {};
        return {
            ...credHeaders,
            ...this.#staticHeaders,
        };
    }

    async #fetchWithAuth(
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
    ): Promise<Response> {
        return await fetchWithCredentialRetry(
            this.#credential,
            () => this.#resolveHeaders(),
            input,
            init,
        );
    }

    async connect(): Promise<InitializeResponse> {
        if (this.#connection !== null && !this.#connection.signal.aborted && this.#initResponse !== null) {
            return this.#initResponse;
        }
        this.#explicitlyClosed = false;

        const initialHeaders = await this.#resolveHeaders();
        const app = client({ name: this.#clientName });

        let updateChain = Promise.resolve();
        app.onNotification(methods.client.session.update, (ctx) => {
            updateChain = updateChain
                .then(async () => {
                    const hydrated = await hydrateSessionUpdate(
                        this.#url,
                        ctx.params,
                        (input, init) => this.#fetchWithAuth(input, init),
                    );
                    for (const listener of this.#updateListeners) {
                        await listener(hydrated);
                    }
                })
                .catch(() => undefined);
            return updateChain;
        });

        app.onNotification(methods.client.auth.statusUpdate, async (ctx) => {
            for (const listener of this.#authStatusListeners) {
                await listener(ctx.params);
            }
        });

        app.onRequest(methods.client.session.requestPermission, async (ctx): Promise<RequestPermissionResponse> => {
            if (this.#permissionHandler === undefined) {
                throw new Error("No permission handler registered on this client.");
            }
            return await this.#permissionHandler(ctx.params, ctx.signal);
        });

        app.onRequest(methods.client.elicitation.create, async (ctx): Promise<CreateElicitationResponse> => {
            if (this.#elicitationHandler === undefined) {
                throw new Error("No elicitation handler registered on this client.");
            }
            return await this.#elicitationHandler(ctx.params, ctx.signal);
        });

        const parsedUrl = new URL(this.#url);
        const isWebSocket = parsedUrl.protocol === "ws:" || parsedUrl.protocol === "wss:";

        const rawStream = isWebSocket
            ? createWebSocketStream(this.#url, {
                  WebSocket: NodeWebSocket as unknown as WebSocketConstructor,
                  headers: initialHeaders,
              })
            : createHttpStream(this.#url, {
                  fetch: async (input, init) => this.#fetchWithAuth(input, init),
              });
        const stream = this.#debugNoMeta ? wrapStreamWithMetaScrubber(rawStream) : rawStream;

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

        try {
            const initRes = await conn.agent.request(methods.agent.initialize, {
                protocolVersion: PROTOCOL_VERSION,
                info: {
                    name: this.#clientName,
                    title: "PLURNK Terminal Client",
                    version: this.#clientVersion,
                },
                capabilities: {
                    session: {
                        commands: { skill: {} },
                        promptSuggestions: {},
                    },
                    ...(this.#elicitationHandler !== undefined
                        ? { elicitation: { form: {} } }
                        : {}),
                },
            });
            this.#initResponse = initRes;
            this.#hasConnected = true;
            return initRes;
        } catch (err) {
            conn.close();
            if (this.#connection === conn) {
                this.#connection = null;
            }
            throw err;
        }
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
                await reconnectBoundSessions(conn, this.#boundSessions, options?.excludeSessionId);
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
            const classification = classifyPreFlightDisconnect(err, conn.signal);
            const isStalePreFlight = updatesDuringCall === 0 && classification.staleConnection;
            if (!isStalePreFlight || this.#explicitlyClosed) {
                throw err;
            }
            if (classification.credentialInvalid) {
                this.#credential?.invalidate();
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

    #recordSessionBinding(
        sessionId: string,
        cwd: string,
        meta?: Record<string, unknown> | null,
    ): void {
        const plurnkMeta = (meta?.plurnk ?? undefined) as Record<string, unknown> | undefined;
        const existing = this.#boundSessions.get(sessionId);
        const interactive =
            typeof plurnkMeta?.interactive === "boolean"
                ? plurnkMeta.interactive
                : existing?.interactive;
        const window =
            typeof plurnkMeta?.window === "boolean"
                ? plurnkMeta.window
                : existing?.window;
        this.#boundSessions.set(sessionId, {
            cwd,
            ...(interactive !== undefined ? { interactive } : {}),
            ...(window !== undefined ? { window } : {}),
            ...(existing?.session !== undefined ? { session: existing.session } : {}),
        });
    }

    trackSession(
        session: AcpSession,
        options?: {
            readonly cwd?: string;
            readonly interactive?: boolean;
            readonly window?: boolean;
        },
    ): void {
        const existing = this.#boundSessions.get(session.sessionId);
        const interactive = options?.interactive ?? session.interactive ?? existing?.interactive;
        const window = options?.window ?? session.window ?? existing?.window;
        if (interactive !== undefined) session.interactive = interactive;
        if (window !== undefined) session.window = window;
        this.#boundSessions.set(session.sessionId, {
            cwd: options?.cwd ?? existing?.cwd ?? process.cwd(),
            ...(interactive !== undefined ? { interactive } : {}),
            ...(window !== undefined ? { window } : {}),
            session,
        });
    }

    async newSession(cwd: string, extra?: Omit<NewSessionRequest, "cwd">): Promise<NewSessionResponse> {
        const res = await this.#withAutoReconnect((conn) =>
            conn.agent.request(methods.agent.session.new, { cwd, ...extra }),
        );
        this.#recordSessionBinding(res.sessionId, cwd, extra?._meta);
        return res;
    }

    async resumeSession(
        sessionId: string,
        cwd: string,
        extra?: Omit<ResumeSessionRequest, "sessionId" | "cwd">,
    ): Promise<ResumeSessionResponse> {
        const res = await this.#withAutoReconnect(
            (conn) => conn.agent.request(methods.agent.session.resume, { sessionId, cwd, ...extra }),
            { excludeSessionId: sessionId },
        );
        this.#recordSessionBinding(sessionId, cwd, extra?._meta);
        return res;
    }

    async listSessions(cwd?: string): Promise<ListSessionsResponse> {
        return await this.#withAutoReconnect((conn) =>
            conn.agent.request(methods.agent.session.list, { ...(cwd !== undefined ? { cwd } : {}) }),
        );
    }

    async listProviders(): Promise<ListProvidersResponse> {
        return await this.#withAutoReconnect((conn) => conn.agent.request(methods.agent.providers.list, {}));
    }

    async authStatus(): Promise<AuthStatusResponse> {
        return await this.#withAutoReconnect((conn) => conn.agent.request(methods.agent.auth.status, {}));
    }

    async logout(): Promise<LogoutAuthResponse | void> {
        return await this.#withAutoReconnect((conn) => conn.agent.request(methods.agent.auth.logout, {}));
    }

    async forkSession(
        sessionId: string,
        cwd: string,
        extra?: Omit<ForkSessionRequest, "sessionId" | "cwd"> & { readonly sessionName?: string },
    ): Promise<ForkSessionResponse> {
        const { sessionName, ...rest } = extra ?? {};
        const mergedMeta =
            sessionName !== undefined && sessionName.length > 0
                ? {
                      ...(rest._meta ?? {}),
                      plurnk: {
                          ...(((rest._meta as Record<string, unknown> | undefined)?.plurnk as
                              | Record<string, unknown>
                              | undefined) ?? {}),
                          sessionName,
                      },
                  }
                : rest._meta;
        const reqParams: ForkSessionRequest = {
            sessionId,
            cwd,
            ...rest,
            ...(mergedMeta !== undefined ? { _meta: mergedMeta } : {}),
        };
        const parentEntry = this.#boundSessions.get(sessionId);
        const res = await this.#withAutoReconnect((conn) =>
            conn.agent.request(methods.agent.session.fork, reqParams),
        );
        this.#boundSessions.set(res.sessionId, {
            cwd,
            ...(parentEntry?.interactive !== undefined ? { interactive: parentEntry.interactive } : {}),
            ...(parentEntry?.window !== undefined ? { window: parentEntry.window } : {}),
        });
        return res;
    }

    async deleteSession(sessionId: string): Promise<DeleteSessionResponse | void> {
        const res = await this.#withAutoReconnect((conn) =>
            conn.agent.request(methods.agent.session.delete, { sessionId }),
        );
        this.#boundSessions.delete(sessionId);
        return res;
    }

    async archiveSession(sessionId: string): Promise<ArchiveSessionResponse | void> {
        const res = await this.#withAutoReconnect((conn) =>
            conn.agent.request(methods.agent.session.archive, { sessionId }),
        );
        this.#boundSessions.delete(sessionId);
        return res;
    }

    async unarchiveSession(sessionId: string): Promise<UnarchiveSessionResponse | void> {
        return await this.#withAutoReconnect((conn) =>
            conn.agent.request(methods.agent.session.unarchive, { sessionId }),
        );
    }

    async sessionStatus(sessionId: string): Promise<SessionStatusResponse> {
        return await this.#withAutoReconnect((conn) =>
            conn.agent.request(methods.agent.session.status, { sessionId }),
        );
    }

    async sessionOptions(
        cwd: string,
        extra?: Omit<SessionOptionsRequest, "cwd">,
    ): Promise<SessionOptionsResponse> {
        return await this.#withAutoReconnect((conn) =>
            conn.agent.request(methods.agent.session.options, { cwd, ...extra }),
        );
    }

    async setSessionTitle(sessionId: string, title: string): Promise<SetSessionTitleResponse> {
        return await this.#withAutoReconnect((conn) =>
            conn.agent.request(methods.agent.session.setTitle, { sessionId, title }),
        );
    }

    async closeSession(sessionId: string): Promise<void> {
        await this.#withAutoReconnect((conn) => conn.agent.request(methods.agent.session.close, { sessionId }));
        this.#boundSessions.delete(sessionId);
    }

    untrackSession(sessionId: string): void {
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

    async cancelToolCall(sessionId: string, toolCallId: string): Promise<CancelToolCallResponse | void> {
        return await this.#withAutoReconnect((conn) =>
            conn.agent.request(methods.agent.toolCall.cancel, { sessionId, toolCallId }),
        );
    }

    async cancelTerminal(sessionId: string, terminalId: string): Promise<CancelTerminalResponse | void> {
        return await this.#withAutoReconnect((conn) =>
            conn.agent.request(methods.agent.terminal.cancel, { sessionId, terminalId }),
        );
    }

    action<K extends PlurnkActionKind>(
        kind: K,
        params?: PlurnkActionMap[K]["params"],
        context?: PlurnkActionContext,
    ): Promise<PlurnkActionMap[K]["result"]>;
    action<T = Record<string, unknown>, K extends string = string>(
        kind: K,
        params?: K extends PlurnkActionKind ? PlurnkActionMap[K]["params"] : Record<string, unknown>,
        context?: PlurnkActionContext,
    ): Promise<T>;
    async action<T = unknown>(
        kind: string,
        params: Record<string, unknown> = {},
        context?: PlurnkActionContext,
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
