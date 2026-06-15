// WebSocket JSON-RPC client. Shared by CLI and TUI. Per TUI.md §1.

import { WebSocket } from "ws";

interface JsonRpcResponse {
    jsonrpc: "2.0";
    id: number;
    result?: unknown;
    error?: { code: number; message: string; data?: unknown };
}

// A daemon-supplied JSON-RPC error response, surfaced as a typed throw so
// the catch boundary can classify it (client:rpc:error) without parsing the
// message string. Carries the failed method (unknown at the boundary, known
// here) and the daemon's numeric code.
export class RpcError extends Error {
    readonly method: string;
    readonly code: number;
    constructor(method: string, code: number, message: string) {
        super(`rpc error ${code}: ${message}`);
        this.name = "RpcError";
        this.method = method;
        this.code = code;
    }
}

interface JsonRpcNotification {
    jsonrpc: "2.0";
    method: string;
    params?: unknown;
}

export interface RpcOptions {
    url: string;
}

export default class Rpc {
    #url: string;
    #ws: WebSocket | null = null;
    #nextId = 1;
    #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; method: string }>();
    #notificationHandlers = new Map<string, Array<(params: unknown) => void>>();

    constructor({ url }: RpcOptions) {
        this.#url = url;
    }

    async connect(): Promise<void> {
        if (this.#ws !== null) throw new Error("rpc: already connected");
        const ws = new WebSocket(this.#url);
        await new Promise<void>((resolve, reject) => {
            ws.once("open", () => resolve());
            ws.once("error", (err) => reject(err));
        });
        this.#ws = ws;
        ws.on("message", (data) => this.#onMessage(data));
        ws.on("close", () => {
            for (const [, pending] of this.#pending) {
                pending.reject(new Error("rpc: connection closed before response"));
            }
            this.#pending.clear();
            this.#ws = null;
        });
    }

    async call(method: string, params?: object): Promise<unknown> {
        if (this.#ws === null) throw new Error("rpc: not connected");
        const id = this.#nextId++;
        const payload: { jsonrpc: string; id: number; method: string; params?: object } = { jsonrpc: "2.0", id, method };
        if (params !== undefined) payload.params = params;
        return new Promise<unknown>((resolve, reject) => {
            this.#pending.set(id, { resolve, reject, method });
            this.#ws?.send(JSON.stringify(payload));
        });
    }

    onNotification(method: string, handler: (params: unknown) => void): void {
        const existing = this.#notificationHandlers.get(method);
        if (existing === undefined) this.#notificationHandlers.set(method, [handler]);
        else existing.push(handler);
    }

    async close(): Promise<void> {
        if (this.#ws === null) return;
        const ws = this.#ws;
        await new Promise<void>((resolve) => {
            ws.once("close", () => resolve());
            ws.close();
        });
        this.#ws = null;
    }

    #onMessage(data: unknown): void {
        const text = typeof data === "string" ? data : (data as Buffer).toString("utf8");
        const parsed = JSON.parse(text) as JsonRpcResponse | JsonRpcNotification;
        if ("id" in parsed && parsed.id !== undefined) {
            const pending = this.#pending.get(parsed.id);
            if (pending === undefined) return;
            this.#pending.delete(parsed.id);
            if (parsed.error !== undefined) {
                pending.reject(new RpcError(pending.method, parsed.error.code, parsed.error.message));
            } else {
                pending.resolve(parsed.result);
            }
            return;
        }
        if ("method" in parsed && parsed.method !== undefined) {
            const handlers = this.#notificationHandlers.get(parsed.method);
            if (handlers === undefined) return;
            for (const h of handlers) h(parsed.params);
        }
    }
}
