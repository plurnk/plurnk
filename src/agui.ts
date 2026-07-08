// The Node consumer of the plurnk-agui bridge — the migration substrate for the
// terminal clients (plurnk-agui#1: CLI first, then TUI). A migrated client stops
// speaking raw WS to the daemon and instead POSTs a run to the bridge and
// consumes the AG-UI SSE projection. This module is that transport, mirroring the
// reference frontend (demo/index.html): POST / for a run, POST /resolve for a
// stopped-world proposal, POST /plurnk/rpc for the management escape hatch.
//
// Pure transport: it yields the daemon-authoritative AG-UI events; rendering (the
// waterfall, proposals, the gauge) stays with each client. plurnk fidelity rides
// the CUSTOM plurnk.* events (esp. plurnk.row — the full wire row).

// AG-UI event: a tagged union on `type`; consumers switch on it. Kept open — the
// bridge owns the vocabulary, we render what arrives (customs included).
export interface AguiEvent { type: string; [k: string]: unknown }

const jsonHeaders = (token?: string): Record<string, string> => ({
    "content-type": "application/json",
    ...(token !== undefined && token.length > 0 ? { authorization: `Bearer ${token}` } : {}),
});

export interface BridgeTarget { bridgeUrl: string; token?: string }

// Run one turn through the bridge, async-yielding each AG-UI event until the
// bridge ends the stream (it does so after RUN_FINISHED / RUN_ERROR). Breaking
// out of the iteration drops the connection, which the bridge treats as the abort
// signal (its req.on("close") cancels the loop) — hanging up IS cancellation.
export async function* runViaBridge(
    target: BridgeTarget,
    run: { threadId: string; prompt: string; runId?: string; forwardedProps?: Record<string, unknown> },
): AsyncGenerator<AguiEvent> {
    const res = await fetch(new URL("/", target.bridgeUrl), {
        method: "POST",
        headers: jsonHeaders(target.token),
        body: JSON.stringify({
            threadId: run.threadId,
            runId: run.runId,
            messages: [{ role: "user", content: run.prompt }],
            ...(run.forwardedProps !== undefined ? { forwardedProps: { plurnk: run.forwardedProps } } : {}),
        }),
    });
    if (!res.ok || res.body === null) {
        const detail = await res.text().catch(() => "");
        throw new Error(`bridge run failed: ${res.status}${detail.length > 0 ? ` — ${detail}` : ""}`);
    }
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frames are `data: <json>\n\n`; accumulate until a full frame is buffered
        // (a chunk can split a frame), then parse each complete one.
        let sep: number;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            if (frame.startsWith("data: ")) yield JSON.parse(frame.slice(6)) as AguiEvent;
        }
    }
}

// Answer a stopped-world proposal (file edit, MCP auth, [300] question) — the
// bridge passes it through to loop.resolve.
export const resolveViaBridge = async (
    target: BridgeTarget,
    resolution: { threadId: string; logEntryId: number; decision: "accept" | "reject" | "cancel"; body?: string },
): Promise<void> => {
    const res = await fetch(new URL("/resolve", target.bridgeUrl), {
        method: "POST",
        headers: jsonHeaders(target.token),
        body: JSON.stringify({
            threadId: resolution.threadId,
            logEntryId: resolution.logEntryId,
            decision: resolution.decision,
            ...(resolution.body !== undefined ? { body: resolution.body } : {}),
        }),
    });
    if (!res.ok) throw new Error(`bridge resolve failed: ${res.status}`);
};

// The management escape hatch: a daemon JSON-RPC method scoped to the thread's own
// session (§agui-management-plane). Returns the daemon's result verbatim.
export const rpcViaBridge = async <T = unknown>(
    target: BridgeTarget,
    call: { threadId: string; method: string; params?: object },
): Promise<T> => {
    const res = await fetch(new URL("/plurnk/rpc", target.bridgeUrl), {
        method: "POST",
        headers: jsonHeaders(target.token),
        body: JSON.stringify({ threadId: call.threadId, method: call.method, params: call.params ?? {} }),
    });
    if (!res.ok) throw new Error(`bridge rpc ${call.method} failed: ${res.status}`);
    const parsed = await res.json() as { result: T };
    return parsed.result;
};
