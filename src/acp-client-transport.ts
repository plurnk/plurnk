// ACP v2 transport helpers: URL normalization, WebSocket header bridging, `_meta` scrubbing,
// pre-flight disconnect classification, OAuth `resource_link` hydration, and session replay
// ({§cli-invocation}, {§cli-rendering}, {§cli-sessions-topology}, {§cli-problems-and-notices}).

import { readFileSync } from "node:fs";
import {
    ContentBlock,
    methods,
    SessionUpdate,
    ToolCallContent,
    type ClientConnection,
    type UpdateSessionNotification,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { AcpSession } from "./acp-session.ts";
import type Credential from "./credential.ts";

const readPackageClientVersion = (): string => {
    try {
        const pkg = JSON.parse(
            readFileSync(new URL("../package.json", import.meta.url), "utf8"),
        ) as { readonly version?: unknown };
        if (typeof pkg.version === "string" && pkg.version.length > 0) {
            return pkg.version;
        }
    } catch {
        // fallback if package.json is unreadable
    }
    return "1.0.0";
};

export const PACKAGE_CLIENT_VERSION = readPackageClientVersion();

export class NodeWebSocket extends globalThis.WebSocket {
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

export const scrubAcpMeta = <T>(value: T): T => {
    if (Array.isArray(value)) {
        return value.map((item) => scrubAcpMeta(item)) as unknown as T;
    }
    if (value !== null && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            if (k === "_meta") {
                if (v !== null && typeof v === "object" && !Array.isArray(v)) {
                    const kept: Record<string, unknown> = {};
                    for (const [mk, mv] of Object.entries(v as Record<string, unknown>)) {
                        if (mk.startsWith("io.modelcontextprotocol/")) {
                            kept[mk] = scrubAcpMeta(mv);
                        }
                    }
                    if (Object.keys(kept).length > 0) {
                        out._meta = kept;
                    }
                }
                continue;
            }
            out[k] = scrubAcpMeta(v);
        }
        return out as T;
    }
    return value;
};

export const wrapStreamWithMetaScrubber = <M>(stream: {
    readonly readable: ReadableStream<M>;
    readonly writable: WritableStream<M>;
}): {
    readonly readable: ReadableStream<M>;
    readonly writable: WritableStream<M>;
} => {
    const readable = stream.readable.pipeThrough(
        new TransformStream<M, M>({
            transform(msg, controller) {
                controller.enqueue(scrubAcpMeta(msg));
            },
        }),
    );
    const writer = stream.writable.getWriter();
    const writable = new WritableStream<M>({
        async write(msg) {
            await writer.write(scrubAcpMeta(msg));
        },
        async close() {
            await writer.close();
        },
        async abort(reason) {
            await writer.abort(reason);
        },
    });
    return { readable, writable };
};

export const isTruthyKnob = (val: string | undefined): boolean =>
    val === "1" || val === "true" || val === "yes" || val === "on";

export const fetchWithCredentialRetry = async (
    credential: Credential | null,
    resolveHeaders: () => Promise<Record<string, string>>,
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
): Promise<Response> => {
    const currentHeaders = await resolveHeaders();
    const merged = new Headers(init?.headers);
    for (const [k, v] of Object.entries(currentHeaders)) {
        if (!merged.has(k)) merged.set(k, v);
    }
    const res = await globalThis.fetch(input, { ...init, headers: merged });
    if (res.status === 401 && credential !== null) {
        credential.invalidate();
        const refreshedHeaders = await resolveHeaders();
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
};

const fetchResourceLinkText = async (
    baseUrl: string,
    uri: string,
    fetchAuth: (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => Promise<Response>,
): Promise<string | null> => {
    let targetUrl: string;
    try {
        targetUrl = new URL(uri, baseUrl).href;
    } catch {
        return null;
    }
    if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
        return null;
    }
    try {
        const res = await fetchAuth(targetUrl, { method: "GET" });
        if (!res.ok) {
            void res.body?.cancel().catch(() => undefined);
            return null;
        }
        return await res.text();
    } catch {
        return null;
    }
};

export const hydrateSessionUpdate = async (
    baseUrl: string,
    params: UpdateSessionNotification,
    fetchAuth: (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => Promise<Response>,
): Promise<UpdateSessionNotification> => {
    const update = params.update;
    if (
        SessionUpdate.isUserMessageChunk(update) ||
        SessionUpdate.isAgentMessageChunk(update) ||
        SessionUpdate.isAgentThoughtChunk(update)
    ) {
        if (ContentBlock.isResourceLink(update.content)) {
            const fetched = await fetchResourceLinkText(baseUrl, update.content.uri, fetchAuth);
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
                    const fetched = await fetchResourceLinkText(baseUrl, block.uri, fetchAuth);
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
        const rawInputRec =
            update.rawInput && typeof update.rawInput === "object" && !Array.isArray(update.rawInput)
                ? (update.rawInput as Record<string, unknown>)
                : null;
        const hasInlineInputBody =
            typeof rawInputRec?.body === "string" ||
            (rawInputRec?.body !== null &&
                typeof rawInputRec?.body === "object" &&
                !Array.isArray(rawInputRec.body));
        if (
            !hasInlineInputBody &&
            (opName === "note" ||
                opName === "edit" ||
                opName === "work" ||
                opName === "fork" ||
                opName === "send") &&
            Array.isArray(update.content) &&
            update.content.some((c) => ToolCallContent.isContent(c) && ContentBlock.isResourceLink(c.content))
        ) {
            const hydratedContent: ToolCallContent[] = [];
            for (const item of update.content) {
                if (ToolCallContent.isContent(item) && ContentBlock.isResourceLink(item.content)) {
                    const fetched = await fetchResourceLinkText(baseUrl, item.content.uri, fetchAuth);
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
};

export interface BoundSessionEntry {
    cwd: string;
    interactive?: boolean;
    window?: boolean;
    session?: AcpSession;
}

export const reconnectBoundSessions = async (
    conn: ClientConnection,
    boundSessions: ReadonlyMap<string, BoundSessionEntry>,
    excludeSessionId?: string,
): Promise<void> => {
    for (const [sessionId, entry] of boundSessions) {
        if (sessionId === excludeSessionId) continue;
        const trackedSession = entry.session;
        const interactive = trackedSession?.interactive ?? entry.interactive;
        const window = trackedSession?.window ?? entry.window ?? true;
        trackedSession?.beginReplay();
        try {
            const resumed = await conn.agent.request(methods.agent.session.resume, {
                sessionId,
                cwd: entry.cwd,
                replayFrom: { type: "start" },
                _meta: {
                    plurnk: {
                        window,
                        ...(window ? { bodies: "link" } : {}),
                        ...(interactive !== undefined ? { interactive } : {}),
                    },
                },
            });
            if (trackedSession !== undefined) {
                if (resumed.configOptions && resumed.configOptions.length > 0) {
                    trackedSession.configOptions = [...resumed.configOptions];
                }
                if (Array.isArray(resumed.availableCommands)) {
                    trackedSession.availableCommands = [...resumed.availableCommands];
                }
                if (resumed._meta !== undefined && resumed._meta !== null) {
                    const prevPlurnk = (trackedSession.meta?.plurnk ?? {}) as Record<string, unknown>;
                    const nextPlurnk = (
                        (resumed._meta as Record<string, unknown>).plurnk ?? {}
                    ) as Record<string, unknown>;
                    trackedSession.meta = {
                        ...(trackedSession.meta ?? {}),
                        ...(resumed._meta as Record<string, unknown>),
                        plurnk: { ...prevPlurnk, ...nextPlurnk },
                    };
                }
            }
        } finally {
            await new Promise<void>((r) => setImmediate(r));
            trackedSession?.endReplay();
        }
    }
};
