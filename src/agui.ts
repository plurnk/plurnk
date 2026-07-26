// The Node consumer of the plurnk-agui bridge — the migration substrate for the
// terminal clients (plurnk-agui#1: CLI first, then TUI). A migrated client stops
// speaking raw WS to the daemon and instead POSTs a run to the bridge and
// consumes the AG-UI SSE projection. This module is that transport, mirroring the
// standard AG-UI HTTP/SSE transport: POST / for runs, including interrupt
// resolution through RunAgentInput.resume.
//
// The official HttpAgent owns HTTP/SSE parsing and AG-UI event verification.
// This adapter only preserves the client's async-iterator surface; rendering
// (waterfall, proposals, gauge) stays local. Plurnk fidelity rides CUSTOM
// plurnk.* events (especially plurnk.row, the full wire row).

import { HttpAgent } from "@ag-ui/client";
import type { AGUIEvent, ResumeEntry, RunAgentInput } from "@ag-ui/core";

export type AguiEvent = AGUIEvent;

export interface BridgeTarget { bridgeUrl: string; token?: string }

// Run one turn through the bridge, async-yielding each AG-UI event until the
// bridge ends the stream (it does so after RUN_FINISHED / RUN_ERROR). Breaking
// out of the iteration drops the connection, which the bridge treats as the abort
// signal (its req.on("close") cancels the loop) — hanging up IS cancellation.
export async function* runViaBridge(
    target: BridgeTarget,
    run: { threadId: string; workspace?: string; prompt?: string; messages?: RunAgentInput["messages"]; resume?: ResumeEntry[]; runId?: string; forwardedProps?: Record<string, unknown> },
    signal?: AbortSignal,
): AsyncGenerator<AguiEvent> {
    const messages: RunAgentInput["messages"] = run.messages
        ?? (run.prompt !== undefined ? [{ id: crypto.randomUUID(), role: "user", content: run.prompt }] : []);
    const agent = new HttpAgent({
        url: new URL("/", target.bridgeUrl).href,
        headers: target.token !== undefined && target.token.length > 0
            ? { authorization: `Bearer ${target.token}` }
            : {},
    });
    const input: RunAgentInput = {
        threadId: run.threadId,
        runId: run.runId ?? crypto.randomUUID(),
        state: {},
        messages,
        tools: [],
        context: [],
        ...(run.resume !== undefined ? { resume: run.resume } : {}),
        // The workspace (world) is REQUIRED — a run has no existence without one. The
        // threadId names the CONVERSATION; it doubles as the workspace unless split.
        forwardedProps: { plurnk: { workspace: run.workspace ?? run.threadId, ...(run.forwardedProps ?? {}) } },
    };
    type QueueItem =
        | { kind: "event"; event: AguiEvent }
        | { kind: "error"; error: unknown }
        | { kind: "done" };
    const queue: QueueItem[] = [];
    let wake: (() => void) | null = null;
    const push = (item: QueueItem) => {
        queue.push(item);
        wake?.();
        wake = null;
    };
    const onAbort = () => agent.abortRun();
    signal?.addEventListener("abort", onAbort, { once: true });
    const subscription = agent.run(input).subscribe({
        // HttpAgent verifies each BaseEvent at the SDK boundary; AGUIEvent is
        // @ag-ui/core's narrower discriminated view of that validated value.
        next: (event) => push({ kind: "event", event: event as AguiEvent }),
        error: (error) => push({ kind: "error", error }),
        complete: () => push({ kind: "done" }),
    });
    if (signal?.aborted) onAbort();
    try {
        for (;;) {
            if (queue.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
            const item = queue.shift()!;
            if (item.kind === "event") {
                yield item.event;
                continue;
            }
            if (item.kind === "error") {
                throw item.error instanceof Error ? item.error : new Error(String(item.error));
            }
            return;
        }
    } finally {
        signal?.removeEventListener("abort", onAbort);
        subscription.unsubscribe();
        agent.abortRun();
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
