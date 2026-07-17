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
    run: { threadId: string; workspace?: string; prompt?: string; messages?: Array<Record<string, unknown>>; runId?: string; forwardedProps?: Record<string, unknown> },
    signal?: AbortSignal,
): AsyncGenerator<AguiEvent> {
    // messages verbatim when given (a terminate-resume tool-result run, an action run);
    // else the prompt as the user message. AG-UI+ dialect (§agui-plus).
    const messages = run.messages ?? (run.prompt !== undefined ? [{ role: "user", content: run.prompt }] : []);
    const res = await fetch(new URL("/", target.bridgeUrl), {
        method: "POST",
        headers: jsonHeaders(target.token),
        signal,   // abort ⇒ drop the SSE ⇒ the bridge cancels the loop (its req.on close)
        body: JSON.stringify({
            threadId: run.threadId,
            runId: run.runId,
            messages,
            // The workspace (world) is REQUIRED — a run has no existence without one. The
            // threadId names the CONVERSATION (a run over the world, svc#366); it doubles
            // as the workspace name unless the caller splits them (--worker: thread ≠ world).
            forwardedProps: { plurnk: { workspace: run.workspace ?? run.threadId, ...(run.forwardedProps ?? {}) } },
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

// Resolve the WORLD (workspace) name for a conversation. An explicit name (--workspace)
// is used verbatim; otherwise the DAEMON mints a fresh, uniquely-named workspace via a
// no-name workspace.create — the paradigm the agui transition regressed into a literal
// "tui"/"cli" client label. Created WITH its options so creation is atomic with the
// project root (#140). No wire touch when a name is given.
export const resolveWorld = async (
    target: BridgeTarget,
    workspaceName: string | undefined,
    createParams: Record<string, unknown>,
): Promise<string> => {
    if (workspaceName !== undefined) return workspaceName;
    const created = await actionViaBridge<{ name: string }>(target, { threadId: "bootstrap", kind: "workspace.create", params: createParams });
    if (typeof created?.name !== "string" || created.name.length === 0) throw new Error("workspace.create returned no name — the daemon failed to mint a workspace");
    return created.name;
};

// AG-UI+ verb surface (§3): a management action rides its own run —
// forwardedProps.plurnk.action in, CUSTOM plurnk.action.result out, RUN_FINISHED.
// Replaces the retired /plurnk/rpc side-channel; the run envelope is the interface.
export const actionViaBridge = async <T = unknown>(
    target: BridgeTarget,
    req: { threadId: string; kind: string; params?: object },
): Promise<T> => {
    for await (const e of runViaBridge(target, { threadId: req.threadId, messages: [], forwardedProps: { action: { kind: req.kind, ...(req.params ?? {}) } } })) {
        if (e.type === "CUSTOM" && (e as { name?: unknown }).name === "plurnk.action.result") {
            const v = (e as unknown as { value: { ok: boolean; result?: T; error?: string } }).value;
            if (!v.ok) throw new Error(`action ${req.kind} failed: ${v.error ?? "unknown"}`);
            return v.result as T;
        }
    }
    throw new Error(`action ${req.kind}: the run ended without a plurnk.action.result`);
};
