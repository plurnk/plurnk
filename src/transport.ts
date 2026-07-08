// The TUI's transport seam (plurnk-agui#1, Phase B): one interface, two impls —
// the raw daemon WS (today) and the AG-UI bridge — so tui.ts becomes
// transport-agnostic. The bridge impl UN-projects AG-UI `plurnk.*` customs back to
// the daemon-notification shapes the TUI already renders (plurnk.row IS the wire
// entry, plurnk.proposal IS the proposal, …), so the render + verb code is
// untouched; only the source of the bytes changes. Phase C wires tui.ts to this.

import type Rpc from "./rpc.ts";
import type { LogEntryWire, LoopUsage } from "./render.ts";
import type { ProposalParams } from "./proposal.ts";
import type { StreamEventPayload, StreamConcludedPayload } from "./stream.ts";
import type { TelemetryEvent } from "./telemetry.ts";
import { runViaBridge, rpcViaBridge, resolveViaBridge, type AguiEvent, type BridgeTarget } from "./agui.ts";

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

// Run-plane events, delivered in daemon-notification shapes — the SAME shapes the
// TUI's existing handlers consume, so they work unchanged under either transport.
export interface RunHandlers {
    onEntry: (entry: LogEntryWire) => void;
    onProposal: (p: ProposalParams) => void;
    onStream: (payload: StreamEventPayload | StreamConcludedPayload) => void;
    onTelemetry: (event: TelemetryEvent) => void;
    onQuiesced?: (payload: unknown) => void;
    onTerminated: (t: TerminatedInfo) => void;
}

export interface RunHandle { done: Promise<void>; cancel: () => void }

// loop.run knobs. NOTE (bridge gap, Phase C follow-up): the bridge's run endpoint
// currently fixes maxTurns/flags from ITS env and ignores per-run alias/model/flags
// — these ride forwardedProps.plurnk so the bridge can adopt them, but until it
// does, only WsTransport honors them.
export interface RunOpts { alias?: string; model?: string; flags?: Record<string, unknown>; maxTurns?: number; openPaths?: string[] }

export interface Transport {
    rpc<T = unknown>(method: string, params?: object): Promise<T>;
    run(prompt: string, opts: RunOpts, handlers: RunHandlers): RunHandle;
    inject(prompt: string): Promise<void>;
    resolve(r: { logEntryId: number; decision: "accept" | "reject" | "cancel"; body?: string; outcome?: string }): Promise<void>;
}

// ── WS transport — the raw daemon connection. The notification subscriptions are
// persistent (registered once); they forward to the CURRENT run's handlers (the
// TUI runs one loop at a time), and loop/terminated ends the run.
export default class WsTransport implements Transport {
    #rpc: Rpc;
    #current: RunHandlers | null = null;
    #onDone: (() => void) | null = null;

    constructor(rpc: Rpc) {
        this.#rpc = rpc;
        rpc.onNotification("log/entry", (p) => this.#current?.onEntry((p as { entry: LogEntryWire }).entry));
        rpc.onNotification("loop/proposal", (p) => this.#current?.onProposal(p as ProposalParams));
        rpc.onNotification("stream/event", (p) => this.#current?.onStream(p as StreamEventPayload));
        rpc.onNotification("stream/concluded", (p) => this.#current?.onStream(p as StreamConcludedPayload));
        rpc.onNotification("telemetry/event", (p) => this.#current?.onTelemetry((p as { event: TelemetryEvent }).event));
        rpc.onNotification("loop/quiesced", (p) => this.#current?.onQuiesced?.(p));
        rpc.onNotification("loop/terminated", (p) => {
            this.#current?.onTerminated(p as TerminatedInfo);
            const done = this.#onDone;
            this.#onDone = null;
            this.#current = null;
            done?.();
        });
    }

    rpc<T>(method: string, params?: object): Promise<T> { return this.#rpc.call(method, params) as Promise<T>; }

    run(prompt: string, opts: RunOpts, handlers: RunHandlers): RunHandle {
        this.#current = handlers;
        const done = new Promise<void>((res) => { this.#onDone = res; });
        void this.#rpc.call("loop.run", { prompt, ...opts });
        return { done, cancel: () => { void this.#rpc.call("loop.cancel", { reason: "user_stop" }).catch(() => {}); } };
    }

    async inject(prompt: string): Promise<void> { await this.#rpc.call("loop.inject", { prompt }); }
    async resolve(r: Parameters<Transport["resolve"]>[0]): Promise<void> { await this.#rpc.call("loop.resolve", r); }
}

// ── Bridge transport — the AG-UI exclusive portal. run() consumes the SSE and
// un-projects the `plurnk.*` customs; inject rides the management plane on the SAME
// thread (so it reaches the active loop, events on the open SSE); cancel aborts the
// fetch (the bridge cancels on hangup).
export class BridgeTransport implements Transport {
    #target: BridgeTarget;
    #threadId: string;
    #firstRun = true;
    #projectRoot?: string | null;

    constructor(target: BridgeTarget, threadId: string, projectRoot?: string | null) {
        this.#target = target;
        this.#threadId = threadId;
        this.#projectRoot = projectRoot;
    }

    rpc<T>(method: string, params?: object): Promise<T> {
        return rpcViaBridge<T>(this.#target, { threadId: this.#threadId, method, params });
    }

    run(prompt: string, opts: RunOpts, handlers: RunHandlers): RunHandle {
        const ac = new AbortController();
        // The thread's first run carries session options (projectRoot) + per-run knobs
        // via forwardedProps.plurnk (bridge adoption pending — see RunOpts).
        const forwardedProps = this.#firstRun || opts.alias !== undefined || opts.model !== undefined
            ? {
                ...(this.#firstRun && this.#projectRoot !== undefined && this.#projectRoot !== null ? { projectRoot: this.#projectRoot } : {}),
                ...(opts.alias !== undefined ? { alias: opts.alias } : {}),
                ...(opts.model !== undefined ? { model: opts.model } : {}),
                ...(opts.flags !== undefined ? { flags: opts.flags } : {}),
                ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
            }
            : undefined;
        this.#firstRun = false;
        const done = (async () => {
            try {
                for await (const e of runViaBridge(this.#target, { threadId: this.#threadId, prompt, forwardedProps }, ac.signal)) {
                    BridgeTransport.#dispatch(e, handlers);
                }
            } catch (err) {
                if (ac.signal.aborted) return;   // /stop — a clean cancel, not a failure
                throw err;
            }
        })();
        return { done, cancel: () => ac.abort() };
    }

    async inject(prompt: string): Promise<void> {
        await rpcViaBridge(this.#target, { threadId: this.#threadId, method: "loop.inject", params: { prompt } });
    }

    async resolve(r: Parameters<Transport["resolve"]>[0]): Promise<void> {
        await resolveViaBridge(this.#target, { threadId: this.#threadId, logEntryId: r.logEntryId, decision: r.decision, ...(r.body !== undefined ? { body: r.body } : {}) });
    }

    // Un-project AG-UI customs → daemon-notification shapes. Core AG-UI events
    // (TEXT_MESSAGE/THINKING/TOOL_CALL/STEP/STATE_DELTA/RUN_*) are for generic
    // frontends; the family client renders from plurnk.* only.
    static #dispatch(e: AguiEvent, h: RunHandlers): void {
        if (e.type !== "CUSTOM") return;
        const name = (e as { name?: string }).name;
        const value = (e as { value?: unknown }).value;
        if (name === "plurnk.row") h.onEntry(value as LogEntryWire);
        else if (name === "plurnk.proposal") h.onProposal(value as ProposalParams);
        else if (name === "plurnk.stream") h.onStream(value as StreamEventPayload | StreamConcludedPayload);
        else if (name === "plurnk.telemetry") h.onTelemetry(value as TelemetryEvent);
        else if (name === "plurnk.quiesced") h.onQuiesced?.(value);
        else if (name === "plurnk.terminated") h.onTerminated(value as TerminatedInfo);
    }
}
