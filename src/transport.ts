// The TUI's transport seam (plurnk-agui#1, Phase B/C): one interface, two impls —
// the raw daemon WS (today) and the AG-UI bridge — so tui.ts becomes
// transport-agnostic. The bridge impl UN-projects AG-UI `plurnk.*` customs back to
// the daemon-notification shapes the TUI already renders (plurnk.row IS the wire
// entry, plurnk.proposal IS the proposal, …), so the render + verb code is
// untouched; only the source of the bytes changes.
//
// Handlers are PERSISTENT (subscribe once): the WS TUI renders a shared session's
// activity — a worker's rows, a second client's loop — even while this REPL is
// idle, so the notification handlers can't be scoped per-run. run() drives one
// loop and its `done` resolves with that loop's outcome (for the summary).

import type { LogEntryWire, LoopUsage } from "./render.ts";
import type { ProposalParams } from "./proposal.ts";
import type { StreamEventPayload, StreamConcludedPayload } from "./stream.ts";
import type { TelemetryEvent } from "./telemetry.ts";
import { runViaBridge, actionViaBridge, type AguiEvent, type BridgeTarget } from "./agui.ts";

// The terminal outcome, unified across transports (WS loop/terminated ≈ bridge
// plurnk.terminated + sessionId).
export interface TerminatedInfo {
    loopId?: number;
    finalStatus: number;
    hitMaxTurns: boolean;
    turnIds?: number[];
    usage?: LoopUsage;
    sessionId?: number | null;
}

// Run-plane events in daemon-notification shapes — the SAME shapes the TUI's
// existing handlers consume, so they work unchanged under either transport.
export interface RunHandlers {
    onEntry: (entry: LogEntryWire) => void;
    onProposal: (p: ProposalParams) => void;
    onStream: (payload: StreamEventPayload | StreamConcludedPayload) => void;
    onTelemetry: (event: TelemetryEvent) => void;
    onQuiesced?: (payload: unknown) => void;
    onTerminated: (t: TerminatedInfo) => void;
}

// A synchronous ACK error (501 no-provider, etc.) surfaced from run() with its
// status attached, so the caller can add the right hint (e.g. the .env pointer).
export class RunAckError extends Error {
    status?: number;
    constructor(message: string, status?: number) { super(message); this.status = status; }
}

export interface RunHandle { done: Promise<TerminatedInfo>; cancel: () => void }

// loop.run knobs. The bridge run endpoint reads alias/model/flags/maxTurns from
// forwardedProps.plurnk (agui 0.2.4); WS passes them straight to loop.run.
export interface RunOpts { alias?: string; model?: string; flags?: Record<string, unknown>; maxTurns?: number; openPaths?: string[] }

export interface Transport {
    rpc<T = unknown>(method: string, params?: object): Promise<T>;
    subscribe(handlers: RunHandlers): void;
    run(prompt: string, opts: RunOpts): RunHandle;
    inject(prompt: string): Promise<void>;
    resolve(r: { logEntryId: number; decision: "accept" | "reject" | "cancel"; body?: string; outcome?: string }): Promise<void>;
    onClose(handler: () => void): void;   // WS: the daemon socket dropped. Bridge: no-op (each run is its own SSE).
    shutdown(): void;   // suppress the connection-lost reject on an intentional quit
    // Switch to (or create) a named session. WS rebinds the connection via
    // session.create; the bridge re-maps its threadId (the bridge lazy-creates the
    // session on the next run). Returns the session handle for the header.
    useSession(name: string | undefined, params: { projectRoot?: string | null; client?: string; autoReadAgents?: boolean }): Promise<{ id: number; name: string }>;
}

interface LoopAck { loopId?: number; finalStatus?: number; status?: number; error?: string }
// ── Bridge transport — the AG-UI exclusive portal. run() consumes the SSE, feeds
// the persistent handlers via un-projection, and `done` resolves with the outcome
// from plurnk.terminated. inject rides /plurnk/rpc on the SAME thread (reaches the
// active loop, events on the open SSE); cancel aborts the SSE (bridge cancels).
// Session options that ride forwardedProps.plurnk on the thread's FIRST run
// (§agui-forwarded-props) — the bridge applies them at session.create.
export interface BridgeSessionOpts { projectRoot?: string | null; constraints?: unknown[]; settings?: object }

export class BridgeTransport implements Transport {
    #target: BridgeTarget;
    #threadId: string;
    #session: BridgeSessionOpts;
    #h: RunHandlers | null = null;
    #firstRun = true;
    #pendingResolve: ((r: { logEntryId: number; decision: string; body?: string }) => void) | null = null;

    constructor(target: BridgeTarget, threadId: string, session: BridgeSessionOpts = {}) {
        this.#target = target;
        this.#threadId = threadId;
        this.#session = session;
    }

    // AG-UI+ dialect: verbs are §3 action runs (the /plurnk/rpc side-channel is dead).
    // A verb is a §3 action run — and its stream ALSO carries whatever the dispatch
    // emitted (a raw-DSL op's rows, telemetry, streams). Feed those through the same
    // persistent handlers a run uses (the WS socket delivered every session row;
    // parity demands the action stream does too — e.g. the Alt-p cycler harvests
    // targets from onEntry).
    async rpc<T>(method: string, params?: object): Promise<T> {
        let result: T | undefined;
        let errmsg: string | undefined;
        for await (const e of runViaBridge(this.#target, { threadId: this.#threadId, messages: [], forwardedProps: { action: { kind: method, ...(params ?? {}) } } })) {
            if (e.type === "CUSTOM" && (e as { name?: unknown }).name === "plurnk.action.result") {
                const v = (e as unknown as { value: { ok: boolean; result?: T; error?: string } }).value;
                if (v.ok) result = v.result; else errmsg = v.error ?? "action failed";
                continue;
            }
            if (e.type === "CUSTOM") this.#dispatch(e);
        }
        if (errmsg !== undefined) throw new Error(`action ${method} failed: ${errmsg}`);
        return result as T;
    }
    subscribe(handlers: RunHandlers): void { this.#h = handlers; }
    shutdown(): void { /* the SSE is aborted per-run; nothing persistent to suppress */ }

    run(prompt: string, opts: RunOpts): RunHandle {
        const ac = new AbortController();
        // First run carries session options (projectRoot/constraints/settings — the
        // bridge applies them at session.create); every run forwards per-run knobs.
        const firstRunOpts = this.#firstRun
            ? {
                ...(this.#session.projectRoot !== undefined && this.#session.projectRoot !== null ? { projectRoot: this.#session.projectRoot } : {}),
                ...(this.#session.constraints !== undefined && this.#session.constraints.length > 0 ? { constraints: this.#session.constraints } : {}),
                ...(this.#session.settings !== undefined && Object.keys(this.#session.settings).length > 0 ? { settings: this.#session.settings } : {}),
            }
            : {};
        const fwd: Record<string, unknown> = {
            ...firstRunOpts,
            ...(opts.alias !== undefined ? { alias: opts.alias } : {}),
            ...(opts.model !== undefined ? { model: opts.model } : {}),
            ...(opts.flags !== undefined ? { flags: opts.flags } : {}),
            ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
        };
        this.#firstRun = false;
        const forwardedProps = Object.keys(fwd).length > 0 ? fwd : undefined;
        // AG-UI+ terminate-resume (§agui-plus): a stopped-world ends the run as a
        // request_approval/request_user_input TOOL_CALL (the loop stays paused
        // in-engine). resolve() supplies the decision; we POST the tool-result as the
        // resume run and keep consuming — done spans the whole pause/resume chain, so
        // the TUI's seam contract never changes.
        const done = (async (): Promise<TerminatedInfo> => {
            let terminated: TerminatedInfo | null = null;
            let errStatus = 0;
            let next: { prompt?: string; messages?: Array<Record<string, unknown>> } = { prompt };
            let fp = forwardedProps;
            for (;;) {
                let pausedProp: number | null = null;
                let toolId = "";
                let toolArgs = "";
                try {
                    for await (const e of runViaBridge(this.#target, { threadId: this.#threadId, ...next, forwardedProps: fp }, ac.signal)) {
                        if (e.type === "RUN_ERROR") {
                            const code = Number((e as { code?: string }).code);
                            errStatus = Number.isFinite(code) && code > 0 ? code : 500;
                        } else if (e.type === "TOOL_CALL_START") {
                            toolId = String((e as { toolCallId?: unknown }).toolCallId ?? "");
                            toolArgs = "";
                        } else if (e.type === "TOOL_CALL_ARGS" && toolId.startsWith("prop:")) {
                            toolArgs += String((e as { delta?: unknown }).delta ?? "");
                        } else if (e.type === "TOOL_CALL_END" && toolId.startsWith("prop:")) {
                            pausedProp = Number(toolId.slice(5));
                            const a = JSON.parse(toolArgs.length > 0 ? toolArgs : "{}") as Record<string, unknown>;
                            this.#h?.onProposal({ logEntryId: pausedProp, op: a.op, target: a.target, body: a.body, attrs: a.attrs, staleClobberRisk: a.staleClobberRisk } as unknown as ProposalParams);
                        } else if (e.type === "CUSTOM") {
                            const t = this.#dispatch(e);
                            if (t !== null) terminated = t;
                        }
                    }
                } catch (err) {
                    if (ac.signal.aborted) return terminated ?? { finalStatus: 499, hitMaxTurns: false };
                    throw err;
                }
                if (terminated !== null) return terminated;
                if (pausedProp === null) {
                    // NO fabricated success (fabrication audit, 2026-07-11): a stream that
                    // ends without terminal truth is a broken wire — 502, never 200.
                    return { finalStatus: errStatus > 0 ? errStatus : 502, hitMaxTurns: false };
                }
                // Paused: hold done open until the client resolves, then resume with the tool-result.
                const r = await new Promise<{ logEntryId: number; decision: string; body?: string }>((res) => { this.#pendingResolve = res; });
                next = { messages: [{ role: "tool", toolCallId: `prop:${r.logEntryId}`, content: JSON.stringify({ decision: r.decision, ...(r.body !== undefined ? { body: r.body } : {}) }) }] };
                fp = undefined;
            }
        })();
        return { done, cancel: () => ac.abort() };
    }

    // §4 — inject rides the action surface; the steered effect streams on the
    // original run's open SSE (the ack rides this action run).
    async inject(prompt: string): Promise<void> {
        await actionViaBridge(this.#target, { threadId: this.#threadId, kind: "loop.inject", params: { prompt } });
    }
    async resolve(r: Parameters<Transport["resolve"]>[0]): Promise<void> {
        // Terminate-resume: the decision releases the paused run loop, which POSTs the
        // tool-result resume. No paused run = a contract violation — fail hard.
        const pending = this.#pendingResolve;
        if (pending === null) throw new Error("resolve without a paused proposal run (terminate-resume contract)");
        this.#pendingResolve = null;
        pending(r);
    }
    onClose(_handler: () => void): void { /* each run is its own SSE — no persistent socket to watch */ }
    async useSession(name: string | undefined, _params: Parameters<Transport["useSession"]>[1]): Promise<{ id: number; name: string }> {
        // Re-map the threadId: subsequent runs address the bridge's agui-<threadId>
        // session (lazy-created on the next run, which re-forwards session opts). The
        // daemon session id is bridge-created, so it's unknown here (0).
        const threadId = name ?? `tui-${crypto.randomUUID().slice(0, 8)}`;
        this.#threadId = threadId;
        this.#firstRun = true;
        return { id: 0, name: threadId };
    }

    // Un-project one CUSTOM plurnk.* → the handlers; returns TerminatedInfo when it
    // was the terminal event, else null. Core AG-UI events are for generic frontends.
    #dispatch(e: AguiEvent): TerminatedInfo | null {
        const name = (e as { name?: string }).name;
        const value = (e as { value?: unknown }).value;
        if (name === "plurnk.row") this.#h?.onEntry(value as LogEntryWire);
        else if (name === "plurnk.stream") this.#h?.onStream(value as StreamEventPayload | StreamConcludedPayload);
        else if (name === "plurnk.telemetry") this.#h?.onTelemetry(value as TelemetryEvent);
        else if (name === "plurnk.quiesced") this.#h?.onQuiesced?.(value);
        else if (name === "plurnk.terminated") { const t = value as TerminatedInfo; this.#h?.onTerminated(t); return t; }
        return null;
    }
}
