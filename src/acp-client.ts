// Standard ACP v2 client built on `@agentclientprotocol/sdk` (Streamable HTTP + WebSocket).

import { createHttpStream } from "@agentclientprotocol/sdk/experimental/http-client";
import { createWebSocketStream, type WebSocketConstructor } from "@agentclientprotocol/sdk/experimental/ws-client";
import {
    ContentBlock,
    PROTOCOL_VERSION,
    SessionUpdate,
    ToolCallContent,
    client,
    methods,
    type ArchiveSessionResponse,
    type AuthStatusResponse,
    type AuthStatusUpdateNotification,
    type CancelTerminalResponse,
    type CancelToolCallResponse,
    type ClientConnection,
    type CreateElicitationRequest,
    type CreateElicitationResponse,
    type DeleteSessionResponse,
    type ForkSessionResponse,
    type InitializeResponse,
    type ListProvidersResponse,
    type ListSessionsResponse,
    type LogoutAuthResponse,
    type NewSessionRequest,
    type NewSessionResponse,
    type PromptResponse,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
    type ResumeSessionRequest,
    type ResumeSessionResponse,
    type SessionConfigValueId,
    type SessionStatusResponse,
    type SetSessionConfigOptionResponse,
    type SetSessionTitleResponse,
    type UnarchiveSessionResponse,
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

export type AuthStatusUpdateHandler = (notification: AuthStatusUpdateNotification) => void | Promise<void>;

export type PermissionRequestHandler = (
    request: RequestPermissionRequest,
    signal: AbortSignal,
) => Promise<RequestPermissionResponse>;

export type ElicitationRequestHandler = (
    request: CreateElicitationRequest,
    signal: AbortSignal,
) => Promise<CreateElicitationResponse>;

export interface PlurnkActionContext {
    readonly workspace?: string;
    readonly workspaceId?: number;
    readonly session?: string;
    readonly sessionId?: string;
    readonly cwd?: string;
}

export interface PlurnkActionEntry<
    P extends Record<string, unknown> = Record<string, unknown>,
    R = Record<string, unknown>,
> {
    readonly params: P;
    readonly result: R;
}

export interface PlurnkFamilyListResult extends Record<string, unknown> {
    readonly definitions?: ReadonlyArray<Record<string, unknown>>;
}

export interface PlurnkActionMap {
    readonly ping: PlurnkActionEntry<Record<string, unknown>, { readonly ok?: boolean } & Record<string, unknown>>;
    readonly discover: PlurnkActionEntry<Record<string, unknown>, Record<string, unknown>>;
    readonly "models.list": PlurnkActionEntry<
        { readonly refresh?: boolean } & Record<string, unknown>,
        {
            readonly defaultModel?: unknown;
            readonly aliases?: ReadonlyArray<Record<string, unknown>>;
            readonly providers?: ReadonlyArray<Record<string, unknown>>;
        } & Record<string, unknown>
    >;
    readonly "service.update": PlurnkActionEntry<Record<string, unknown>, Record<string, unknown>>;
    readonly "workspace.list": PlurnkActionEntry<
        Record<string, unknown>,
        { readonly workspaces?: ReadonlyArray<Record<string, unknown>> } & Record<string, unknown>
    >;
    readonly "workspace.create": PlurnkActionEntry<
        {
            readonly name?: string;
            readonly projectRoot?: string;
            readonly settings?: Record<string, unknown>;
        } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.attach": PlurnkActionEntry<
        { readonly name?: string; readonly workspaceId?: number; readonly projectRoot?: string } & Record<
            string,
            unknown
        >,
        Record<string, unknown>
    >;
    readonly "workspace.sessions": PlurnkActionEntry<
        Record<string, unknown>,
        { readonly sessions?: ReadonlyArray<Record<string, unknown>> } & Record<string, unknown>
    >;
    readonly "log.read": PlurnkActionEntry<
        { readonly limit?: number; readonly before?: number; readonly after?: number } & Record<string, unknown>,
        { readonly entries?: ReadonlyArray<Record<string, unknown>> } & Record<string, unknown>
    >;
    readonly "workspace.prompts": PlurnkActionEntry<
        { readonly limit?: number } & Record<string, unknown>,
        { readonly prompts?: readonly string[] } & Record<string, unknown>
    >;
    readonly "session.loops": PlurnkActionEntry<
        Record<string, unknown>,
        {
            readonly loops?: ReadonlyArray<{
                readonly sequence?: number;
                readonly id?: number;
                readonly session?: string;
                readonly status?: number;
                readonly prompt?: string;
                readonly summary?: string;
            }>;
        } & Record<string, unknown>
    >;
    readonly "workspace.share": PlurnkActionEntry<
        { readonly outputDir?: string } & Record<string, unknown>,
        { readonly path?: string; readonly outputDir?: string } & Record<string, unknown>
    >;
    readonly "workspace.rename": PlurnkActionEntry<
        { readonly name: string } & Record<string, unknown>,
        { readonly name?: string } & Record<string, unknown>
    >;
    readonly "workspace.archive": PlurnkActionEntry<
        { readonly archived?: boolean } & Record<string, unknown>,
        { readonly id?: number; readonly archived_at?: string | null } & Record<string, unknown>
    >;
    readonly "workspace.rollback": PlurnkActionEntry<
        { readonly to: number } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "entry.read": PlurnkActionEntry<
        { readonly id?: number; readonly uri?: string } & Record<string, unknown>,
        { readonly content?: string; readonly text?: string } & Record<string, unknown>
    >;
    readonly "op.parse": PlurnkActionEntry<
        { readonly text: string; readonly execute?: boolean } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.capabilities.get": PlurnkActionEntry<Record<string, unknown>, Record<string, unknown>>;
    readonly "workspace.capabilities.set": PlurnkActionEntry<Record<string, unknown>, Record<string, unknown>>;
    readonly "workspace.skills.list": PlurnkActionEntry<Record<string, unknown>, PlurnkFamilyListResult>;
    readonly "workspace.skills.discover": PlurnkActionEntry<
        { readonly source?: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.skills.add": PlurnkActionEntry<
        { readonly alias: string; readonly source?: string; readonly ref?: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.skills.replace": PlurnkActionEntry<
        { readonly alias: string; readonly source?: string; readonly ref?: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.skills.enable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.skills.disable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.skills.remove": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.personas.list": PlurnkActionEntry<Record<string, unknown>, PlurnkFamilyListResult>;
    readonly "workspace.personas.discover": PlurnkActionEntry<
        { readonly query?: string; readonly source?: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.personas.add": PlurnkActionEntry<
        {
            readonly alias: string;
            readonly source?: string;
            readonly description?: string;
            readonly body?: string;
            readonly model?: string;
            readonly effort?: string;
        } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.personas.replace": PlurnkActionEntry<
        {
            readonly alias: string;
            readonly source?: string;
            readonly description?: string;
            readonly body?: string;
            readonly model?: string;
            readonly effort?: string;
        } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.personas.enable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.personas.disable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.personas.remove": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.members.list": PlurnkActionEntry<Record<string, unknown>, PlurnkFamilyListResult>;
    readonly "workspace.members.discover": PlurnkActionEntry<
        { readonly query?: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.members.add": PlurnkActionEntry<
        { readonly files: readonly string[] } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.members.enable": PlurnkActionEntry<
        { readonly file: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.members.disable": PlurnkActionEntry<
        { readonly file: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.members.remove": PlurnkActionEntry<
        { readonly file: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.env.list": PlurnkActionEntry<Record<string, unknown>, PlurnkFamilyListResult>;
    readonly "workspace.env.discover": PlurnkActionEntry<
        { readonly query?: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.env.add": PlurnkActionEntry<
        { readonly alias: string; readonly value: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.env.replace": PlurnkActionEntry<
        { readonly alias: string; readonly value: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.env.enable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.env.disable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.env.remove": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "session.env.list": PlurnkActionEntry<Record<string, unknown>, PlurnkFamilyListResult>;
    readonly "session.env.discover": PlurnkActionEntry<
        { readonly query?: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "session.env.add": PlurnkActionEntry<
        { readonly alias: string; readonly value: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "session.env.replace": PlurnkActionEntry<
        { readonly alias: string; readonly value: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "session.env.enable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "session.env.disable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "session.env.remove": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.mcp.list": PlurnkActionEntry<Record<string, unknown>, PlurnkFamilyListResult>;
    readonly "workspace.mcp.discover": PlurnkActionEntry<
        { readonly query?: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.mcp.add": PlurnkActionEntry<
        (
            | { readonly alias: string; readonly type: "streamable-http"; readonly url: string }
            | {
                  readonly alias: string;
                  readonly type: "stdio";
                  readonly command: string;
                  readonly args?: readonly string[];
              }
        ) &
            Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.mcp.replace": PlurnkActionEntry<
        (
            | { readonly alias: string; readonly type: "streamable-http"; readonly url: string }
            | {
                  readonly alias: string;
                  readonly type: "stdio";
                  readonly command: string;
                  readonly args?: readonly string[];
              }
        ) &
            Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.mcp.enable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.mcp.disable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.mcp.remove": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.schedule.list": PlurnkActionEntry<Record<string, unknown>, PlurnkFamilyListResult>;
    readonly "workspace.schedule.discover": PlurnkActionEntry<
        { readonly rule?: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.schedule.add": PlurnkActionEntry<
        {
            readonly alias: string;
            readonly rule: string;
            readonly target: string;
            readonly prompt: string;
        } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.schedule.replace": PlurnkActionEntry<
        {
            readonly alias: string;
            readonly rule: string;
            readonly target: string;
            readonly prompt: string;
        } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.schedule.enable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.schedule.disable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.schedule.remove": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.mcp.oauth.begin": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        { readonly authorizationUrl?: string } & Record<string, unknown>
    >;
    readonly "workspace.mcp.oauth.complete": PlurnkActionEntry<
        { readonly alias: string; readonly code?: string; readonly callbackUrl?: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.mcp.complete": PlurnkActionEntry<Record<string, unknown>, Record<string, unknown>>;
    readonly "workspace.mcp.skills": PlurnkActionEntry<Record<string, unknown>, Record<string, unknown>>;
}

export type PlurnkActionKind = keyof PlurnkActionMap;

export const ACP_ACTION_KINDS = [
    "ping",
    "discover",
    "models.list",
    "service.update",
    "workspace.list",
    "workspace.create",
    "workspace.attach",
    "workspace.sessions",
    "log.read",
    "workspace.prompts",
    "session.loops",
    "workspace.share",
    "workspace.rename",
    "workspace.archive",
    "workspace.rollback",
    "entry.read",
    "op.parse",
    "workspace.capabilities.get",
    "workspace.capabilities.set",
    "workspace.skills.list",
    "workspace.skills.discover",
    "workspace.skills.add",
    "workspace.skills.replace",
    "workspace.skills.enable",
    "workspace.skills.disable",
    "workspace.skills.remove",
    "workspace.personas.list",
    "workspace.personas.discover",
    "workspace.personas.add",
    "workspace.personas.replace",
    "workspace.personas.enable",
    "workspace.personas.disable",
    "workspace.personas.remove",
    "workspace.members.list",
    "workspace.members.discover",
    "workspace.members.add",
    "workspace.members.enable",
    "workspace.members.disable",
    "workspace.members.remove",
    "workspace.env.list",
    "workspace.env.discover",
    "workspace.env.add",
    "workspace.env.replace",
    "workspace.env.enable",
    "workspace.env.disable",
    "workspace.env.remove",
    "session.env.list",
    "session.env.discover",
    "session.env.add",
    "session.env.replace",
    "session.env.enable",
    "session.env.disable",
    "session.env.remove",
    "workspace.mcp.list",
    "workspace.mcp.discover",
    "workspace.mcp.add",
    "workspace.mcp.replace",
    "workspace.mcp.enable",
    "workspace.mcp.disable",
    "workspace.mcp.remove",
    "workspace.schedule.list",
    "workspace.schedule.discover",
    "workspace.schedule.add",
    "workspace.schedule.replace",
    "workspace.schedule.enable",
    "workspace.schedule.disable",
    "workspace.schedule.remove",
    "workspace.mcp.oauth.begin",
    "workspace.mcp.oauth.complete",
    "workspace.mcp.complete",
    "workspace.mcp.skills",
] as const satisfies readonly PlurnkActionKind[];

type _AssertExhaustivePlurnkActionKinds = Exclude<
    PlurnkActionKind,
    (typeof ACP_ACTION_KINDS)[number]
> extends never
    ? true
    : never;
const _exhaustivePlurnkActionKinds: _AssertExhaustivePlurnkActionKinds = true;
void _exhaustivePlurnkActionKinds;

const CREDENTIAL_PROBLEM_CODES = new Set([
    "acp/http/bearer-token-invalid",
    "acp/http/credential-revoked",
]);

const CREDENTIAL_PROBLEM_TYPES = new Set([
    "https://problems.plurnk.xyz/acp/http/bearer-token-invalid",
    "https://problems.plurnk.xyz/acp/http/credential-revoked",
]);

const isCredentialProblemRecord = (rec: Record<string, unknown>): boolean =>
    (typeof rec.code === "string" && CREDENTIAL_PROBLEM_CODES.has(rec.code)) ||
    (typeof rec.type === "string" && CREDENTIAL_PROBLEM_TYPES.has(rec.type));

export const classifyPreFlightDisconnect = (
    err: unknown,
    connSignal?: AbortSignal,
): { readonly staleConnection: boolean; readonly credentialInvalid: boolean } => {
    if (!err || typeof err !== "object") {
        return { staleConnection: false, credentialInvalid: false };
    }
    const errRec = err as {
        readonly status?: unknown;
        readonly code?: unknown;
        readonly body?: unknown;
        readonly data?: unknown;
        readonly message?: unknown;
    };

    const directStatus = typeof errRec.status === "number" ? errRec.status : undefined;
    const dataRec =
        errRec.data !== null && typeof errRec.data === "object"
            ? (errRec.data as Record<string, unknown>)
            : undefined;
    const dataStatus = typeof dataRec?.status === "number" ? dataRec.status : undefined;
    const status = directStatus ?? dataStatus;

    // 409 Conflict (e.g. session already active or state conflict) is a domain refusal, never a dropped connection.
    if (status === 409) {
        return { staleConnection: false, credentialInvalid: false };
    }

    let bodyRec: Record<string, unknown> | undefined;
    if (typeof errRec.body === "string" && errRec.body.trim().startsWith("{")) {
        try {
            const parsed = JSON.parse(errRec.body) as unknown;
            if (parsed !== null && typeof parsed === "object") {
                bodyRec = parsed as Record<string, unknown>;
            }
        } catch {
            // Non-JSON response body
        }
    } else if (errRec.body !== null && typeof errRec.body === "object") {
        bodyRec = errRec.body as Record<string, unknown>;
    }

    const credentialInvalid =
        status === 401 ||
        (dataRec !== undefined && isCredentialProblemRecord(dataRec)) ||
        (bodyRec !== undefined && isCredentialProblemRecord(bodyRec));
    if (credentialInvalid) {
        return { staleConnection: true, credentialInvalid: true };
    }

    const dataType = typeof dataRec?.type === "string" ? dataRec.type : undefined;
    const isDomainProblem =
        dataType !== undefined && !dataType.startsWith("https://problems.plurnk.xyz/acp/http/");
    if (isDomainProblem) {
        return { staleConnection: false, credentialInvalid: false };
    }

    // HTTP 404 on an active ACP stream (HttpResponseError or SDK http-stream 404 wrapper)
    // indicates an expired or unknown Acp-Connection-Id on the server.
    if (directStatus === 404 || (dataStatus === 404 && !isDomainProblem)) {
        return { staleConnection: true, credentialInvalid: false };
    }

    // If the error is a structured JSON-RPC domain error (numeric code without transport abort), do not reconnect.
    if (typeof errRec.code === "number" && !connSignal?.aborted) {
        return { staleConnection: false, credentialInvalid: false };
    }

    // Transport stream closure aborts conn.signal or throws the SDK's uncoded "ACP HTTP stream is closed" Error.
    if (
        connSignal?.aborted === true ||
        (errRec.code === undefined &&
            status === undefined &&
            errRec.message === "ACP HTTP stream is closed")
    ) {
        return { staleConnection: true, credentialInvalid: false };
    }

    return { staleConnection: false, credentialInvalid: false };
};

export interface AcpClientOptions {
    readonly url: string;
    readonly token?: string;
    readonly credential?: Credential;
    readonly env?: Record<string, string | undefined>;
    readonly headers?: Readonly<Record<string, string>>;
    readonly clientName?: string;
    readonly clientVersion?: string;
    readonly onSessionUpdate?: SessionUpdateHandler;
    readonly onAuthStatusUpdate?: AuthStatusUpdateHandler;
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
    #reconnectPromise: Promise<ClientConnection> | null = null;
    readonly #boundSessions = new Map<string, string>();
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
        this.#clientVersion = options.clientVersion ?? "1.0.0";
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
        const currentHeaders = await this.#resolveHeaders();
        const merged = new Headers(init?.headers);
        for (const [k, v] of Object.entries(currentHeaders)) {
            if (!merged.has(k)) merged.set(k, v);
        }
        const res = await globalThis.fetch(input, { ...init, headers: merged });
        if (res.status === 401 && this.#credential !== null) {
            this.#credential.invalidate();
            const refreshedHeaders = await this.#resolveHeaders();
            if (
                refreshedHeaders.authorization !== undefined &&
                refreshedHeaders.authorization !== currentHeaders.authorization
            ) {
                void res.body?.cancel().catch(() => undefined);
                const retryMerged = new Headers(init?.headers);
                for (const [k, v] of Object.entries(refreshedHeaders)) {
                    if (!retryMerged.has(k)) retryMerged.set(k, v);
                }
                return await globalThis.fetch(input, { ...init, headers: retryMerged });
            }
        }
        return res;
    }

    async #fetchResourceLinkText(uri: string): Promise<string | null> {
        let targetUrl: string;
        try {
            targetUrl = new URL(uri, this.#url).href;
        } catch {
            return null;
        }
        if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
            return null;
        }
        try {
            const res = await this.#fetchWithAuth(targetUrl, { method: "GET" });
            if (!res.ok) {
                void res.body?.cancel().catch(() => undefined);
                return null;
            }
            return await res.text();
        } catch {
            return null;
        }
    }

    async #hydrateSessionUpdate(params: UpdateSessionNotification): Promise<UpdateSessionNotification> {
        const update = params.update;
        if (
            SessionUpdate.isUserMessageChunk(update) ||
            SessionUpdate.isAgentMessageChunk(update) ||
            SessionUpdate.isAgentThoughtChunk(update)
        ) {
            if (ContentBlock.isResourceLink(update.content)) {
                const fetched = await this.#fetchResourceLinkText(update.content.uri);
                if (fetched !== null) {
                    return {
                        ...params,
                        update: {
                            ...update,
                            content: { type: "text", text: fetched },
                        },
                    };
                }
            }
            return params;
        }
        if (
            SessionUpdate.isUserMessage(update) ||
            SessionUpdate.isAgentMessage(update) ||
            SessionUpdate.isAgentThought(update)
        ) {
            if (Array.isArray(update.content) && update.content.some((b) => ContentBlock.isResourceLink(b))) {
                const hydratedBlocks: ContentBlock[] = [];
                for (const block of update.content) {
                    if (ContentBlock.isResourceLink(block)) {
                        const fetched = await this.#fetchResourceLinkText(block.uri);
                        if (fetched !== null) {
                            hydratedBlocks.push({ type: "text", text: fetched });
                            continue;
                        }
                    }
                    hydratedBlocks.push(block);
                }
                return {
                    ...params,
                    update: {
                        ...update,
                        content: hydratedBlocks,
                    },
                };
            }
            return params;
        }
        if (SessionUpdate.isToolCallUpdate(update)) {
            const metaOp = (update._meta as { plurnk?: { op?: unknown } } | undefined)?.plurnk?.op;
            const opName = (
                typeof update.name === "string"
                    ? update.name
                    : typeof metaOp === "string"
                      ? metaOp
                      : ""
            ).toLowerCase();
            if (
                (opName === "note" ||
                    opName === "edit" ||
                    opName === "work" ||
                    opName === "fork" ||
                    opName === "kill" ||
                    opName === "send") &&
                Array.isArray(update.content) &&
                update.content.some((c) => ToolCallContent.isContent(c) && ContentBlock.isResourceLink(c.content))
            ) {
                const hydratedContent: ToolCallContent[] = [];
                for (const item of update.content) {
                    if (ToolCallContent.isContent(item) && ContentBlock.isResourceLink(item.content)) {
                        const fetched = await this.#fetchResourceLinkText(item.content.uri);
                        if (fetched !== null) {
                            hydratedContent.push({
                                ...item,
                                content: { type: "text", text: fetched },
                            });
                            continue;
                        }
                    }
                    hydratedContent.push(item);
                }
                return {
                    ...params,
                    update: {
                        ...update,
                        content: hydratedContent,
                    },
                };
            }
            return params;
        }
        return params;
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
                    const hydrated = await this.#hydrateSessionUpdate(ctx.params);
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

        const stream = isWebSocket
            ? createWebSocketStream(this.#url, {
                  WebSocket: NodeWebSocket as unknown as WebSocketConstructor,
                  headers: initialHeaders,
              })
            : createHttpStream(this.#url, {
                  fetch: async (input, init) => this.#fetchWithAuth(input, init),
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

        try {
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
                for (const [sessionId, cwd] of this.#boundSessions) {
                    if (sessionId === options?.excludeSessionId) continue;
                    await conn.agent.request(methods.agent.session.resume, {
                        sessionId,
                        cwd,
                        replayFrom: { type: "start" },
                    });
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

    async authStatus(): Promise<AuthStatusResponse> {
        return await this.#withAutoReconnect((conn) => conn.agent.request(methods.agent.auth.status, {}));
    }

    async logout(): Promise<LogoutAuthResponse | void> {
        return await this.#withAutoReconnect((conn) => conn.agent.request(methods.agent.auth.logout, {}));
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
    action<T = Record<string, unknown>>(
        kind: PlurnkActionKind | (string & {}),
        params?: Record<string, unknown>,
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
