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

import type Rpc from "./rpc.ts";
import type { LogEntryWire, LoopUsage } from "./render.ts";
import type { ProposalParams } from "./proposal.ts";
import type { StreamEventPayload, StreamConcludedPayload } from "./stream.ts";
import type { TelemetryEvent } from "./telemetry.ts";
import { runViaBridge, actionViaBridge, resolveViaBridge, type AguiEvent, type BridgeTarget } from "./agui.ts";

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

// ── WS transport — the raw daemon connection. Persistent subscriptions render
// all session activity; run() awaits ITS loop's terminated (loopId-keyed, with a
// buffer for the ack-vs-terminated race).
export default class WsTransport implements Transport {
    #rpc: Rpc;
    #h: RunHandlers | null = null;
    #waiters = new Map<number, { resolve: (t: TerminatedInfo) => void; reject: (e: Error) => void }>();
    #buffer = new Map<number, TerminatedInfo>();
    #shuttingDown = false;

    constructor(rpc: Rpc) {
        this.#rpc = rpc;
        rpc.onNotification("log/entry", (p) => this.#h?.onEntry((p as { entry: LogEntryWire }).entry));
        rpc.onNotification("loop/proposal", (p) => this.#h?.onProposal(p as ProposalParams));
        rpc.onNotification("stream/event", (p) => this.#h?.onStream(p as StreamEventPayload));
        rpc.onNotification("stream/concluded", (p) => this.#h?.onStream(p as StreamConcludedPayload));
        rpc.onNotification("telemetry/event", (p) => this.#h?.onTelemetry((p as { event: TelemetryEvent }).event));
        rpc.onNotification("loop/quiesced", (p) => this.#h?.onQuiesced?.(p));
        rpc.onNotification("loop/terminated", (p) => {
            const { loopId, ...rest } = p as { loopId: number } & TerminatedInfo;
            const t: TerminatedInfo = { loopId, ...rest };
            this.#h?.onTerminated(t);
            const w = this.#waiters.get(loopId);
            if (w !== undefined) { this.#waiters.delete(loopId); w.resolve(t); return; }
            this.#buffer.set(loopId, t);
        });
        rpc.onClose(() => {
            if (this.#shuttingDown) return;
            for (const [, w] of this.#waiters) w.reject(new Error("connection to the daemon was lost"));
            this.#waiters.clear();
        });
    }

    #awaitTerminated(loopId: number): Promise<TerminatedInfo> {
        const buffered = this.#buffer.get(loopId);
        if (buffered !== undefined) { this.#buffer.delete(loopId); return Promise.resolve(buffered); }
        return new Promise((resolve, reject) => this.#waiters.set(loopId, { resolve, reject }));
    }

    rpc<T>(method: string, params?: object): Promise<T> { return this.#rpc.call(method, params) as Promise<T>; }
    subscribe(handlers: RunHandlers): void { this.#h = handlers; }
    shutdown(): void { this.#shuttingDown = true; }

    run(prompt: string, opts: RunOpts): RunHandle {
        const done = (async (): Promise<TerminatedInfo> => {
            const ack = await this.#rpc.call("loop.run", { prompt, ...opts }) as LoopAck;
            if (ack.error !== undefined) throw new RunAckError(ack.error, ack.status);
            // status 100 ack → the outcome rides loop/terminated; any other status is terminal.
            if (ack.finalStatus === 100 && ack.loopId !== undefined) return this.#awaitTerminated(ack.loopId);
            return { finalStatus: ack.finalStatus ?? ack.status ?? 0, hitMaxTurns: false };
        })();
        return { done, cancel: () => { void this.#rpc.call("loop.cancel", { reason: "user_stop" }).catch(() => {}); } };
    }

    async inject(prompt: string): Promise<void> { await this.#rpc.call("loop.inject", { prompt }); }
    async resolve(r: Parameters<Transport["resolve"]>[0]): Promise<void> { await this.#rpc.call("loop.resolve", r); }
    onClose(handler: () => void): void { this.#rpc.onClose(handler); }
    async useSession(name: string | undefined, params: Parameters<Transport["useSession"]>[1]): Promise<{ id: number; name: string }> {
        const p: { name?: string; projectRoot?: string | null; settings?: { client?: string; autoReadAgents?: boolean } } = {};
        if (name !== undefined) p.name = name;
        if (params.projectRoot !== undefined) p.projectRoot = params.projectRoot;
        if (params.client !== undefined || params.autoReadAgents !== undefined) {
            p.settings = {};
            if (params.client !== undefined) p.settings.client = params.client;
            if (params.autoReadAgents !== undefined) p.settings.autoReadAgents = params.autoReadAgents;
        }
        return this.#rpc.call("session.create", p) as Promise<{ id: number; name: string }>;
    }
}

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

    constructor(target: BridgeTarget, threadId: string, session: BridgeSessionOpts = {}) {
        this.#target = target;
        this.#threadId = threadId;
        this.#session = session;
    }

    // AG-UI+ dialect: verbs are §3 action runs (the /plurnk/rpc side-channel is dead).
    rpc<T>(method: string, params?: object): Promise<T> {
        return actionViaBridge<T>(this.#target, { threadId: this.#threadId, kind: method, params });
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
        const done = (async (): Promise<TerminatedInfo> => {
            let terminated: TerminatedInfo | null = null;
            let errStatus = 0;
            try {
                for await (const e of runViaBridge(this.#target, { threadId: this.#threadId, prompt, forwardedProps }, ac.signal)) {
                    if (e.type === "RUN_ERROR") {
                        const code = Number((e as { code?: string }).code);
                        errStatus = Number.isFinite(code) && code > 0 ? code : 500;
                    } else if (e.type === "CUSTOM") {
                        const t = this.#dispatch(e);
                        if (t !== null) terminated = t;
                    }
                }
            } catch (err) {
                if (ac.signal.aborted) return terminated ?? { finalStatus: 499, hitMaxTurns: false };
                throw err;
            }
            return terminated ?? { finalStatus: errStatus > 0 ? errStatus : 200, hitMaxTurns: false };
        })();
        return { done, cancel: () => ac.abort() };
    }

    // §4 — inject rides the action surface; the steered effect streams on the
    // original run's open SSE (the ack rides this action run).
    async inject(prompt: string): Promise<void> {
        await actionViaBridge(this.#target, { threadId: this.#threadId, kind: "loop.inject", params: { prompt } });
    }
    async resolve(r: Parameters<Transport["resolve"]>[0]): Promise<void> {
        await resolveViaBridge(this.#target, { threadId: this.#threadId, logEntryId: r.logEntryId, decision: r.decision, ...(r.body !== undefined ? { body: r.body } : {}) });
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
        else if (name === "plurnk.proposal") this.#h?.onProposal(value as ProposalParams);
        else if (name === "plurnk.stream") this.#h?.onStream(value as StreamEventPayload | StreamConcludedPayload);
        else if (name === "plurnk.telemetry") this.#h?.onTelemetry(value as TelemetryEvent);
        else if (name === "plurnk.quiesced") this.#h?.onQuiesced?.(value);
        else if (name === "plurnk.terminated") { const t = value as TerminatedInfo; this.#h?.onTerminated(t); return t; }
        return null;
    }
}
