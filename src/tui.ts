// TUI mode — interactive Plurnk client on pi-tui's main-screen renderer.
// Per TUI.md §3.
//
// Line language (converged with plurnk.nvim — one vocabulary, two surfaces):
//   /verb [args]   command verbs (see VERBS); never call loop.run
//   ## PLAN / ### OP raw DSL through op.parse
//   ### LOOK0 (uri) off-run READ — inspect a uri's content for ME, not the model
//   ! cmd          op.exec via the daemon
//   ... msg         loop.inject — speak into the running model loop
//   ? text         deny EXEC for this loop and keep proposal review client-owned
//   : text         act (the default)
//   text           prompt
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { matchesKey, type AutocompleteItem, type AutocompleteProvider } from "@earendil-works/pi-tui";
import TuiSurface from "./tui-surface.ts";
import TerminalGuards from "./tui-guards.ts";
import ModelText from "./model-text.ts";
import { extractOpenPaths } from "./openpaths.ts";
import { pathPartial, completePath, dslOpPartial, completeOps, dslStatement } from "./completion.ts";
// The verb wire: a structural caller (AG-UI+ actions underneath).
export interface VerbCaller { call(method: string, params?: object): Promise<unknown> }
import { renderLogEntry, renderReasoning, renderSummary, isPromptEntry, entryTarget, isEntryMaterialization } from "./render.ts";
import type { ReasoningUpdate } from "./reasoning-events.ts";
import type { LoopUsage } from "./render.ts";
import type { LogEntryWire } from "./render.ts";
import { renderProposalMenu, keyToResolution, renderQuestionMenu, questionChoices, answerForQuestion, editInEditor } from "./proposal.ts";
import { BridgeTransport, type BranchBatchEvent, type Transport } from "./transport.ts";
import type { ProposalParams, Resolution } from "./proposal.ts";
import { ProblemError, renderDiagnostic, report, clientSubcommandUnknownVerb, NO_MODEL_HINT } from "./diagnostics.ts";
import type { Notice } from "./diagnostics.ts";
import StreamTrace, { inlineable, renderInline } from "./stream.ts";
import type { StreamEventPayload, StreamConcludedPayload } from "./stream.ts";
import { runModels, runWorkspaceList, runWorkspaceWorkers, runLogRead } from "./subcommands.ts";
import {
    Validator,
    type CapabilityPolicy,
    type LoopPolicy,
    type ModelRoute,
    type OperationResult,
} from "@plurnk/plurnk-contracts";
import { formatCapabilityProjection, parseCapabilityPolicy, promptPolicy } from "./policy.ts";
import { handleMcp } from "./mcp.ts";
import { handleSkills } from "./skills.ts";
import { handleAgents } from "./agents.ts";
import { handleMembers } from "./members.ts";
import {
    formatWorkerReasoning,
    readWorkerReasoning,
    setWorkerReasoning,
    type WorkerReasoning,
} from "./reasoning.ts";
import { EMPTY_TALLY, derivationActivity, formatRouteIdentity, projectStatusGauge, renderStatusLine, tallyOutcome, type ClientStatus, type SessionTally, type StatusLifecycle } from "./status.ts";
import {
    COMMANDS,
    completeCommandSyntax,
    isCommandName,
    renderCommandHelp,
    type CommandName,
    type CommandSuggestion,
    type FunctionalityFamily,
} from "./commands.ts";

export const renderTuiFailure = (cause: unknown): string => {
    // A Problem may quote the model's own line; a thrown message may carry anything (plurnk#35).
    if (cause instanceof ProblemError) {
        return renderDiagnostic(ModelText.plainFields(cause.problem))
            + (cause.problem.status === 501 ? NO_MODEL_HINT : "");
    }
    return `  \x1b[31merror: ${ModelText.plain(cause instanceof Error ? cause.message : String(cause))}\x1b[0m`;
};

// The loop.run ack/terminated bridge (fire-and-forget: ACK {finalStatus:100} then
// the outcome on loop/terminated; a synchronous 501/error surfaces immediately)
// now lives in the Transport (WsTransport's loopId-keyed done, TerminatedInfo).

interface WorkspaceResult { id: number; name: string }

// One verb vocabulary across nvim's :AI/, the TUI, and (where they exist)
// the argv subcommands. Convergence is policy: divergence needs a reason.
// Singular = CREATE, plural = LIST: /workspace makes a new workspace, /workspaces
// lists them; /worker forks a new worker, /workers lists them. The old /new was
// ambiguous (workspace or worker?) and is gone. /rename retargets the current
// workspace's mutable handle (a worker's name is immutable — no /rename for workers).
export const VERBS: readonly CommandName[] = COMMANDS.map(({ name }) => name);
export const TUI_HELP = renderCommandHelp();

// Muscle-memory quick-keys, converged with plurnk.nvim's `<leader>a<letter>`
// mnemonics — SAME CASE as nvim (lowercase m/s/x, capital R/L/Y/N/M), which
// Alt-<letter> can carry (Alt-m = `ESC m`, Alt-M = `ESC M` — distinct bytes).
// Delivered as Alt not Ctrl because Ctrl-<letter> collides with terminal and
// editor control keys. Alt-b/f/d remain the editor's word operations.
export const ALT_SHORTCUTS: Readonly<Record<string, string>> = Object.freeze({
    m: "/models", s: "/workspaces", R: "/workers", L: "/log",
    Y: "/yolo", N: "/workspace", M: "/members", x: "/stop", h: "/help", e: "/editor",
});

// An Alt-<letter> keypress (ESC then a single letter, no `[`/`O` → not an arrow
// or function key) mapped to its verb, or null. Case-sensitive (mirrors nvim).
// pi-tui's terminal buffer reassembles split escape sequences.
export const altShortcut = (forward: string): string | null => {
    const m = forward.match(/^\x1b([a-zA-Z])$/);
    return m ? (ALT_SHORTCUTS[m[1]] ?? null) : null;
};

// Recognize the client-only LOOK surface so it can be routed to `op.look`.
// The AG-UI observation action owns validation and the single LOOK→READ rewrite.
export const lookStatement = (line: string): string | null =>
    line.startsWith("### LOOK") ? line : null;

export const linePolicy = promptPolicy;

export const renderSubmittedInput = (text: string, yolo: boolean): string =>
    text.split("\n").map((line, index) => `${index === 0 ? (yolo ? "🔥 " : "› ") : "  "}${line}`).join("\n");

// Alt-p / Alt-n cycle the LOOK target through prior operations (prev/next op).
// null = not a cycle key.
export const cycleKey = (forward: string): "up" | "down" | null =>
    forward === "\x1bp" ? "up" : forward === "\x1bn" ? "down" : null;

// Pure cursor math for the LOOK coordinate cycler over `count` seen coordinates
// (oldest→newest). Up walks toward older (start at newest), down toward newer.
// Returns the next index, or null when there's nothing to cycle.
export const cycleCoord = (count: number, cursor: number | null, dir: "up" | "down"): number | null => {
    if (count === 0) return null;
    if (cursor === null) return dir === "up" ? count - 1 : null;
    return dir === "up" ? Math.max(0, cursor - 1) : Math.min(count - 1, cursor + 1);
};


export const parseSlash = (line: string): { verb: string; rest: string } => {
    const m = line.match(/^\/(\S*)\s*(.*)$/);
    return { verb: m?.[1] ?? "", rest: (m?.[2] ?? "").trim() };
};

export interface CompletionOptions {
    getAliases: () => string[];
    cwd: string;
    getReasoningPolicies?: () => string[];
    getProviderModels?: (provider: string) => Promise<string[]>;
    getFunctionalityAliases?: (family: FunctionalityFamily) => Promise<string[]>;
}

export interface InputCompletion {
    suggestions: CommandSuggestion[];
    prefix: string;
}

// Command syntax comes from the registry. Paths read the local filesystem;
// model and Functionality aliases are fetched only when the cursor reaches a
// position that consumes them. A fragment holding a provider prefix
// (`/model openai/…`) completes lazily from one bounded, provider-scoped
// daemon catalog page ([§cli-plurnk-models]); the client never preloads or
// owns the Models.dev snapshot.
export const completeInput = async (line: string, options: CompletionOptions): Promise<InputCompletion> => {
        const command = completeCommandSyntax(line);
        if (command?.kind === "syntax") return { suggestions: command.suggestions, prefix: command.prefix };
        if (command?.kind === "aliases") {
            let aliases: string[] = [];
            try { aliases = await options.getFunctionalityAliases?.(command.family) ?? []; }
            catch { /* completion failure is an empty result; the editor remains intact */ }
            return {
                suggestions: aliases
                    .filter((alias) => alias.startsWith(command.prefix))
                    .map((value) => ({ value, description: `${command.family} alias` })),
                prefix: command.prefix,
            };
        }
        const aliasFrag = line.match(/^\/(model|child)\s+(\S*)$/);
        if (aliasFrag) {
            const fragment = aliasFrag[2];
            const provider = /^([A-Za-z0-9_-]+)\//.exec(fragment)?.[1];
            if (provider !== undefined) {
                let selectors: string[] = [];
                try { selectors = await options.getProviderModels?.(provider) ?? []; }
                catch { /* bounded remote completion is optional */ }
                return {
                    suggestions: selectors.filter((selector) => selector.startsWith(fragment))
                        .map((value) => ({ value, description: "model route" })),
                    prefix: fragment,
                };
            }
            const candidates = aliasFrag[1] === "child"
                ? ["inherit", ...options.getAliases().filter((alias) => alias !== "inherit")]
                : options.getAliases();
            return {
                suggestions: candidates.filter((alias) => alias.startsWith(fragment))
                    .map((value) => ({ value, description: value === "inherit" ? "inherit parent route" : "model alias" })),
                prefix: fragment,
            };
        }
        const reasoningFrag = line.match(/^\/reasoning\s+(\S*)$/);
        if (reasoningFrag) {
            return {
                suggestions: (options.getReasoningPolicies?.() ?? [])
                    .filter((policy) => policy.startsWith(reasoningFrag[1]))
                    .map((value) => ({ value, description: "reasoning policy" })),
                prefix: reasoningFrag[1],
            };
        }
        const op = dslOpPartial(line);
        if (op !== null) {
            const [values, prefix] = completeOps(op);
            return { suggestions: values.map((value) => ({ value, description: "Plurnk operation" })), prefix };
        }
        const partial = pathPartial(line);
        if (partial !== null) {
            const [values, prefix] = await completePath(partial, options.cwd);
            return { suggestions: values.map((value) => ({ value, description: "local path" })), prefix };
        }
        return { suggestions: [], prefix: line };
    };

export const makeAutocompleteProvider = (
    options: CompletionOptions,
): AutocompleteProvider => ({
    triggerCharacters: ["/", "#", "@"],
    getSuggestions: async (lines, cursorLine, cursorCol) => {
        const beforeCursor = lines.slice(0, cursorLine).concat(lines[cursorLine]?.slice(0, cursorCol) ?? "").join("\n");
        const { suggestions, prefix } = await completeInput(beforeCursor, options);
        if (suggestions.length === 0) return null;
        return {
            items: suggestions.map(({ value, description }): AutocompleteItem => ({ value, label: value, description })),
            prefix,
        };
    },
    applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
        const current = lines[cursorLine] ?? "";
        const before = current.slice(0, cursorCol);
        const after = current.slice(cursorCol);
        const replaceFrom = Math.max(0, before.length - prefix.length);
        const completed = `${before.slice(0, replaceFrom)}${item.value}`;
        const next = [...lines];
        next[cursorLine] = completed + after;
        return { lines: next, cursorLine, cursorCol: completed.length };
    },
});

// Seed editor history from prior workspace prompts. The server returns newest
// first; the surface owns the insertion order required by its editor.
export const seedPromptHistory = async (
    rpc: VerbCaller,
    workspaceId: number,
    history: { addHistory(promptsNewestFirst: readonly string[]): void },
): Promise<void> => {
    try {
        // Bridge mode has no client-known workspace id → omit it (the connection's
        // attached workspace answers); WS passes the real id.
        const params = workspaceId > 0 ? { id: workspaceId, limit: 100 } : { limit: 100 };
        const { prompts } = await rpc.call("workspace.prompts", params) as { prompts?: string[] };
        if (Array.isArray(prompts) && prompts.length > 0) history.addHistory(prompts);
    } catch { /* history is a convenience; never block the REPL */ }
};

// The one-line startup banner: version · workspace [· worker] · model · help. Pure so the
// model-label resolution is unit-testable. modelLabel = the client's explicit
// --model selector when set, else the daemon's active default
// (providers.list `active`), else an honest fallback.
export const buildHeader = (opts: {
    versionNotice?: string; workspaceName: string; workerName?: string; modelSelector?: string;
    activeAlias?: string; reasoningPolicy?: string | null; yolo?: boolean;
}): string => {
    const head = opts.versionNotice ?? "plurnk";
    const worker = opts.workerName !== undefined ? ` · worker: ${opts.workerName}` : "";
    const modelLabel = opts.modelSelector ?? opts.activeAlias ?? "(daemon default)";
    const reasoning = opts.reasoningPolicy === undefined || opts.reasoningPolicy === null
        ? ""
        : ` · reasoning: ${opts.reasoningPolicy}`;
    const yolo = opts.yolo ? " · yolo: on" : "";
    return `${head} · workspace: ${opts.workspaceName}${worker} · model: ${modelLabel}${reasoning}${yolo} · /help`;
};

// Verb dispatch, extracted from runTui so the handlers are unit-testable
// (stub rpc, collect writes, fake workspace/import). Verbs never call loop.run —
// they're run-tab furniture. Returns "quit" to close the REPL.
export interface VerbContext {
    rpc: VerbCaller;
    opts: { modelSelector?: string; yolo: boolean; projectRoot?: string | null; client?: string; mcpConfiguration?: Readonly<Record<string, string>> };
    // The worker's durable model truth ({§worker-model-selection}): the server's
    // resolved specs, updated by the set verbs. The display label AND the routing
    // both come from the server; the client never reasserts a model per loop.
    model: ResolvedModelSpec | null;
    spawnModel: ResolvedModelSpec | null;
    reasoning: WorkerReasoning;
    setModel: (spec: ResolvedModelSpec | null) => void;
    setSpawnModel: (spec: ResolvedModelSpec | null) => void;
    setReasoning: (reasoning: WorkerReasoning) => void;
    getWorkspace: () => WorkspaceResult;
    setWorkspace: (s: WorkspaceResult) => void;
    // Switch to (or create) a named workspace — transport-agnostic (WS rebind /
    // bridge threadId re-map). Returns the new workspace handle.
    switchWorkspace: (name: string | undefined) => Promise<WorkspaceResult>;
    // The bound conversation worker's name (null until a loop or /attach names it).
    getWorker: () => string | null;
    // Rebind the session's thread to a worker by name, world unchanged
    // ({§cli-workers-topology}); the daemon binds or mints on the next run.
    attachWorker: (name: string) => void;
    write: (s: string) => void;
    importFile: (path: string) => Promise<void>;
    // Resolve the pending proposal (no-op if none) — the typed no-modifier
    // fallback for the a/e/r/c review keys. `edit` opens $EDITOR.
    resolveProposal: (action: "accept" | "reject" | "cancel" | "edit") => Promise<void>;
    // Compose the prompt line in $EDITOR (plurnk#26) — places the result back
    // on the line (zsh edit-command-line convention); Enter submits.
    composeInEditor: () => Promise<void>;
}

export type ResolvedModelSpec = ModelRoute;

const modelRouteOrNull = (value: unknown): ResolvedModelSpec | null =>
    value === null ? null : Validator.assertModelRoute(value);

const workerModelProjection = (value: unknown): {
    model: ResolvedModelSpec | null;
    spawnModel: ResolvedModelSpec | null;
} => {
    if (value === null || typeof value !== "object") {
        throw new TypeError("worker.model.get returned no model projection");
    }
    const projection = value as { model?: unknown; spawnModel?: unknown };
    return {
        model: modelRouteOrNull(projection.model),
        spawnModel: modelRouteOrNull(projection.spawnModel),
    };
};

export const resolvedModelLabel = (spec: ResolvedModelSpec): string => formatRouteIdentity(spec);

export const handleVerb = async (line: string, ctx: VerbContext): Promise<"quit" | undefined> => {
    const { verb, rest } = parseSlash(line);
    const { rpc, opts, write } = ctx;
    const refreshWorkerPolicy = async (): Promise<void> => {
        const model = workerModelProjection(await rpc.call("worker.model.get"));
        ctx.setModel(model.model);
        ctx.setSpawnModel(model.spawnModel);
        ctx.setReasoning(await readWorkerReasoning(rpc));
    };
    if (verb.length === 0) {
        write(renderCommandHelp());
        return;
    }
    if (!isCommandName(verb)) {
        report(clientSubcommandUnknownVerb(`/${verb}`, [...VERBS]));
        return;
    }
    switch (verb) {
        case "help":
            write(renderCommandHelp(rest));
            return;
        case "models": await runModels(rpc, {
            json: false,
            query: rest.length === 0 ? {} : { search: rest },
        }); return;
        case "workspaces": await runWorkspaceList(rpc, { json: false }); return;
        case "workers": await runWorkspaceWorkers(rpc, ctx.getWorkspace().name, { json: false }); return;
        case "log": {
            const limit = rest.length > 0 ? Number(rest) : undefined;
            const filters = Number.isInteger(limit) && (limit as number) > 0 ? { limit: limit as number } : {};
            await runLogRead(rpc, { json: false, filters });
            return;
        }
        case "model":
            if (rest.length === 0) { write(`  model: ${ctx.model === null ? "(daemon default)" : resolvedModelLabel(ctx.model)}\n`); return; }
            // {§worker-model-selection} — /model is a server-backed durable selection:
            // the daemon resolves and persists onto the conversation worker; nothing
            // client-local rides the next loop.
            try {
                ctx.setModel(Validator.assertModelRoute(await rpc.call("worker.model.set", { selector: rest })));
                write(`  model: ${rest}\n`);
            } catch (cause) {
                write(`  model set failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
                return;
            }
            try {
                ctx.setReasoning(await readWorkerReasoning(rpc));
            } catch (cause) {
                write(`  reasoning refresh failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
            }
            return;
        case "reasoning":
            try {
                const reasoning = rest.length === 0
                    ? await readWorkerReasoning(rpc)
                    : await setWorkerReasoning(rpc, rest);
                ctx.setReasoning(reasoning);
                write(`${formatWorkerReasoning(reasoning).trimEnd().replace(/^/gm, "  ")}\n`);
            } catch (cause) {
                write(`${renderTuiFailure(cause)}\n`);
            }
            return;
        case "capabilities":
            try {
                const projection = rest.length === 0
                    ? await rpc.call("worker.capabilities.get") as Record<string, CapabilityPolicy>
                    : await rpc.call("worker.capabilities.set", {
                        policy: parseCapabilityPolicy("/capabilities", rest),
                    }) as Record<string, CapabilityPolicy>;
                write(`${formatCapabilityProjection(projection).trimEnd().replace(/^/gm, "  ")}\n`);
            } catch (cause) {
                write(`${renderTuiFailure(cause)}\n`);
            }
            return;
        case "child":
            if (rest.length === 0) { write(`  child: ${ctx.spawnModel === null ? "inherit" : resolvedModelLabel(ctx.spawnModel)}\n`); return; }
            try {
                // {§worker-model-selection} — inherit IS the server action (selector null
                // clears the override); the daemon returns null for it.
                ctx.setSpawnModel(modelRouteOrNull(await rpc.call(
                    "worker.child.set",
                    { selector: rest === "inherit" ? null : rest },
                )));
                write(`  child: ${rest}\n`);
            } catch (cause) {
                write(`  child set failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
            }
            return;
        case "yolo":
            opts.yolo = !opts.yolo;
            write(`  yolo: ${opts.yolo ? "ON" : "OFF"}\n`);
            return;
        case "workspace": {
            // New workspace — a fresh world. Transport-agnostic: WS rebinds the
            // client context in place; the transport re-maps its
            // threadId. Name is optional (auto-named/generated) and is a mutable
            // handle (/rename retargets it). client id (#249) + AGENTS override
            // (#268) ride the switch.
            ctx.setWorkspace(await ctx.switchWorkspace(rest.length > 0 ? rest : undefined));
            await refreshWorkerPolicy();
            write(`  workspace: ${ctx.getWorkspace().name} (new)\n`);
            return;
        }
        case "rename": {
            // workspace.rename — a workspace's name is a mutable handle on the world
            // (a run's is not). Mutates the attached workspace in place. svc#248.
            if (rest.length === 0) { write("  usage: /rename <name>\n"); return; }
            const renamed = await rpc.call("workspace.rename", { name: rest }) as WorkspaceResult;
            ctx.setWorkspace(renamed);
            write(`  workspace: ${renamed.name}\n`);
            return;
        }
        case "worker": {
            // New worker — run.fork branches this conversation, optionally
            // named at instantiation (immutable after). Bind to the fork so the
            // next prompt speaks there. The workspace (the world) is unchanged.
            const forked = await rpc.call("run.fork", rest.length > 0 ? { name: rest } : {}) as { workerId: number; workerName: string };
            await rpc.call("workspace.attach", { id: ctx.getWorkspace().id, workerId: forked.workerId });
            await refreshWorkerPolicy();
            write(`  worker: ${forked.workerName} (new)\n`);
            return;
        }
        case "attach": {
            // {§cli-workers-topology} — an existing worker is bound, a new name mints a
            // fresh conversation on the next run (the `--worker` path); the world stays.
            if (rest.length === 0) { write("  usage: /attach <name>\n"); return; }
            const { workers } = await rpc.call("workspace.workers", { id: ctx.getWorkspace().id }) as { workers: Array<{ name: string }> };
            const known = workers.some((worker) => worker.name === rest);
            ctx.attachWorker(rest);
            await refreshWorkerPolicy();
            write(`  worker: ${rest} (${known ? "bound" : "new"})\n`);
            return;
        }
        case "import":
            // Dump a LOCAL file's content into the multiline composer.
            if (rest.length === 0) { write("  usage: /import <path>\n"); return; }
            await ctx.importFile(rest);
            return;
        case "script": {
            // Run a .plk file: read its bytes, feed the DSL to op.parse. The op
            // traces broadcast via log/entry (rendered above the prompt by the
            // global handler); side-effecting ops pause for review like any client
            // op. The client never parses the file — the daemon owns the grammar.
            if (rest.length === 0) { write("  usage: /script <path>\n"); return; }
            const text = await readFile(resolve(rest), "utf8");   // fail-hard on a missing file
            const { results } = await rpc.call("op.parse", { text }) as { results: Array<{ status: number }> };
            const worst = results.reduce((w, r) => (r.status > w ? r.status : w), 0);
            write(`  script: ${results.length} op${results.length === 1 ? "" : "s"}${worst >= 400 ? `, worst status ${worst}` : " ok"}\n`);
            return;
        }
        case "mcp": {
            await handleMcp(rest, rpc, write, { overlay: opts.mcpConfiguration });
            return;
        }
        case "skills": {
            await handleSkills(rest, rpc, write);
            return;
        }
        case "agents": {
            await handleAgents(rest, rpc, write);
            return;
        }
        case "members": {
            await handleMembers(rest, rpc, write);
            return;
        }
        case "accept":
        case "reject":
        case "cancel":
        case "edit":
            // Typed no-modifier fallback for the a/e/r/c proposal review keys.
            await ctx.resolveProposal(verb as "accept" | "reject" | "cancel" | "edit");
            return;
        case "stop":
            await rpc.call("loop.cancel", { reason: "user_stop" });
            return;
        case "editor":
            await ctx.composeInEditor();
            return;
        case "quit":
            return "quit";
    }
    verb satisfies never;
};

export const runTui = async (transport: Transport, workspace: WorkspaceResult, opts: {
    // The explicit --model selector for this invocation ({§worker-model-selection}):
    // an explicit flag persistently selects the worker at startup.
    modelSelector?: string; modelExplicit?: boolean; reasoningPolicy?: string; reasoningExplicit?: boolean;
    yolo: boolean;
    loopPolicy: LoopPolicy; maxTurns?: number;
    projectRoot?: string | null; versionNotice?: string;
    workerName?: string;        // shown in the banner when explicitly set
    client?: string;            // #249 — frontend id, carried onto /workspace-created workspaces
    mcpConfiguration?: Readonly<Record<string, string>>;
}): Promise<void> => {
    let current = workspace;
    // Loop state, hoisted so the line handler and SIGINT can share it.
    let inFlight = false;
    let cancelRequested = false;
    let printAbove: (text: string) => void = (text) => { process.stdout.write(`${text}\n`); };
    // One cancel path for every interrupt gesture (Ctrl-C, Esc, /stop): the
    // run's active drain cancels via loop.cancel; the pending loop resolves
    // 499 and the REPL continues. A failed cancel SURFACES — a stop button
    // that silently does nothing is the worst kind of broken.
    const requestCancel = (reason: string): void => {
        if (cancelRequested) return;
        cancelRequested = true;
        printAbove("  \x1b[2mcancelling… (ctrl-c again to quit)\x1b[0m");
        void transport.rpc("loop.cancel", { reason }).catch((err: unknown) => {
            printAbove(`  \x1b[31mcancel failed: ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
        });
    };
    // Ephemeral progress projected into the prompt while background work is active.
    let lifecycle: StatusLifecycle = "idle";
    let authoritativeStatus: ClientStatus | null = null;
    let tally: SessionTally = EMPTY_TALLY;
    let runningSince: number | null = null;
    let conversationWorkerId: number | null = null;
    let conversationWorker: string | null = opts.workerName ?? null;
    let embedding = false;
    let embeddingPercent: number | null = null;
    let searchFetching = false;
    let searchPercent: number | null = null;
    let branchBatch: BranchBatchEvent | null = null;
    // LOOK off-run inspection: the REAL target URIs of prior operations the
    // waterfall has shown (oldest→newest, e.g. worker:///plan.md) feed the Alt-p/
    // Alt-n cycler — not synthesized log-entry coordinates. lookCursor walks them.
    const priorTargets: string[] = [];
    let lookCursor: number | null = null;
    let liveReasoning: { messageId: string; rendered: string } | null = null;
    let pendingProposal: ProposalParams | null = null;
    let pendingQuestion: { interactionId: number; schema: Record<string, unknown> } | null = null;

    // Streams, coalesced: one start line, one conclusion line, and tiny concluded
    // outputs inlined (the single bounded content fetch the TUI makes — SPEC §5.3).
    const streams = new StreamTrace();

    // A dropped connection can't carry a pending question's answer. shuttingDown
    // (set on an intentional quit) tells the transport to suppress its reject.
    let shuttingDown = false;
    transport.onClose(() => { if (!shuttingDown) pendingQuestion = null; });

    // Alias cache for /model completion + the active alias for the header —
    // one cheap RPC, refreshed never (aliases are daemon-boot-time config).
    // Awaited before the banner so the header can name the model the daemon
    // will actually use when --model is unset (providers.list
    // marks the boot-time default `active`).
    let aliasCache: string[] = [];
    const providerModelCache = new Map<string, string[]>();
    let activeAlias: string | undefined;
    // Alias list for completion + the header's active default. Both terminal gauges
    // ride the loop usage envelope; this client never reconstructs curation policy or
    // physical input capacity from ambient alias metadata.
    try {
        const r = await transport.rpc("providers.list") as { aliases?: Array<{ alias: string; active?: boolean }> };
        if (Array.isArray(r.aliases)) {
            aliasCache = r.aliases.map((a) => a.alias);
            activeAlias = r.aliases.find((a) => a.active)?.alias;
        }
    } catch { /* completion stays empty; header falls back to (daemon default) */ }

    // {§worker-model-selection} — the worker owns the model. Read the server truth
    // for the header and the /model /child display; an EXPLICIT --model persists
    // onto the worker at startup (a one-time durable selection, not a per-loop
    // reassertion).
    let workerModel: ResolvedModelSpec | null = null;
    let workerSpawnModel: ResolvedModelSpec | null = null;
    let workerReasoning: WorkerReasoning = { policy: null, supportedPolicies: [] };
    let reasoningFailure: unknown;
    // Model identity is control-plane truth, not decorative header data. A
    // transport failure or malformed projection leaves this client unable to
    // know which durable worker policy it is presenting, so admission fails
    // instead of silently relabeling the worker as the daemon default.
    const initialModel = workerModelProjection(await transport.rpc("worker.model.get"));
    workerModel = initialModel.model;
    workerSpawnModel = initialModel.spawnModel;
    if (opts.modelExplicit === true && opts.modelSelector !== undefined) {
        // A deliberate selection is part of invocation admission, not display
        // hydration. Refuse the TUI before it accepts input if the daemon cannot
        // persist it; continuing would silently run the worker's previous model.
        workerModel = Validator.assertModelRoute(
            await transport.rpc("worker.model.set", { selector: opts.modelSelector }),
        );
    }
    if (opts.reasoningExplicit === true && opts.reasoningPolicy !== undefined) {
        // Same admission rule as --model: an explicit policy must take effect or
        // the invocation fails before any model work can run under stale policy.
        workerReasoning = await setWorkerReasoning(
            { call: (method, params) => transport.rpc(method, params) },
            opts.reasoningPolicy,
        );
    } else {
        try {
            workerReasoning = await readWorkerReasoning({ call: (method, params) => transport.rpc(method, params) });
        } catch (cause) { reasoningFailure = cause; }
    }

    // One header line: version · workspace [· worker] · model · help (see buildHeader).
    const header = buildHeader({
        versionNotice: opts.versionNotice, workspaceName: current.name, workerName: opts.workerName,
        modelSelector: workerModel === null ? opts.modelSelector : resolvedModelLabel(workerModel), activeAlias,
        reasoningPolicy: workerReasoning.policy,
        yolo: opts.yolo,
    });
    const surface = new TuiSurface();
    const releaseGuards = TerminalGuards.install(surface);
    printAbove = (text) => surface.append(text);
    surface.append(`\x1b[2m${header}\x1b[0m`);
    surface.append("");
    if (reasoningFailure !== undefined) printAbove(renderTuiFailure(reasoningFailure));

    // Client-owned lifecycle and model lead the input affordance; ephemeral
    // derivation, search, and branch work share its final activity position.
    const statusContext = () => ({
        workspace: current.name,
        worker: conversationWorker,
        child: workerSpawnModel === null ? null : resolvedModelLabel(workerSpawnModel),
        tally,
        runningSince,
        now: Date.now(),
    });
    const buildStatus = (): string => {
        if (authoritativeStatus !== null) {
            return renderStatusLine(authoritativeStatus, statusContext(), { idleGlyph: opts.yolo ? "🔥" : "" });
        }
        const branchCompleted = Number(branchBatch?.completed);
        const branchTotal = Number(branchBatch?.total);
        const branchPercent = branchBatch !== null
            && Number.isFinite(branchCompleted)
            && Number.isFinite(branchTotal)
            && branchTotal > 0
            ? Math.floor((branchCompleted / branchTotal) * 100)
            : null;
        const activity = embedding ? { label: "indexing", percent: embeddingPercent }
            : searchFetching ? { label: "search", percent: searchPercent }
                : branchPercent !== null ? { label: "branches", percent: branchPercent }
                    : null;
        const model = workerModel === null
            ? opts.modelSelector ?? activeAlias ?? null
            : resolvedModelLabel(workerModel);
        return renderStatusLine({
            lifecycle: inFlight ? "running" : lifecycle,
            model,
            packetCount: null,
            activity,
        }, statusContext(), { idleGlyph: opts.yolo ? "🔥" : "" });
    };
    const reprompt = (): void => surface.setStatus(buildStatus());
    const repromptPreserving = reprompt;
    surface.setAutocompleteProvider(makeAutocompleteProvider({
            getAliases: () => aliasCache,
            cwd: process.cwd(),
            getReasoningPolicies: () => workerReasoning.supportedPolicies,
            getProviderModels: async (provider) => {
                // One bounded page per provider, cached for the session: lazy,
                // provider-scoped, never the whole catalog.
                const cached = providerModelCache.get(provider);
                if (cached !== undefined) return cached;
                const page = await transport.rpc("models.list", { provider, limit: 100 }) as { items?: Array<{ selector?: unknown }> };
                const selectors = (page.items ?? [])
                    .map(({ selector }) => selector)
                    .filter((selector): selector is string => typeof selector === "string");
                providerModelCache.set(provider, selectors);
                return selectors;
            },
            getFunctionalityAliases: async (family) => {
                const result = await transport.rpc(`worker.${family}.list`, {}) as { definitions?: unknown };
                if (!Array.isArray(result.definitions)) throw new TypeError(`worker.${family}.list returned an invalid result.`);
                return result.definitions
                    .map((definition) => definition !== null && typeof definition === "object"
                        ? (definition as { alias?: unknown }).alias
                        : undefined)
                    .filter((alias): alias is string => typeof alias === "string");
            },
        }));

    const presentReasoning = (update: ReasoningUpdate): void => {
        if (update.phase === "start") {
            if (liveReasoning !== null) throw new TypeError("A second reasoning message started before the first ended.");
            liveReasoning = { messageId: update.messageId, rendered: "" };
            return;
        }
        if (liveReasoning === null || liveReasoning.messageId !== update.messageId) {
            throw new TypeError(`Reasoning ${update.phase} did not match the active message.`);
        }
        const rendered = renderReasoning(update.content);
        liveReasoning.rendered = rendered;
        if (update.phase === "content") {
            surface.setLive(rendered);
            return;
        }
        surface.setLive(null);
        if (rendered.length > 0) printAbove(rendered);
        liveReasoning = null;
    };

    const setLine = (text: string): void => surface.setInput(text);

    // Alt-p/Alt-n: walk the REAL target URIs of prior operations and template a
    // `### LOOK0 (<that uri>)` line into the buffer — an editable starting point
    // (hand-edit before Enter). Nothing to cycle → leave the line be.
    const cycleLook = (dir: "up" | "down"): void => {
        lookCursor = cycleCoord(priorTargets.length, lookCursor, dir);
        if (lookCursor === null) return;
        setLine(`### LOOK0 (${priorTargets[lookCursor]})`);
    };

    // LOOK is a pure query: AG-UI validates and rewrites the original statement, then
    // resolves READ without writing a log entry. Run it on the conversation connection
    // so run-relative targets resolve against the right run.
    const runLook = async (lookText: string): Promise<OperationResult> => {
        const r = await transport.rpc("op.look", { text: lookText }) as OperationResult & { content: string | null };
        const content = r.content ?? "";
        printAbove(content.length > 0 ? content : `  \x1b[2m(look ${r.status}: no content)\x1b[0m`);
        return r;
    };

    // pi-tui owns multiline input, paste normalization, modern keyboard
    // negotiation, history navigation, wrapping, cursor placement, and IME.
    // Plurnk's listener consumes only product-level gestures before the editor.
    let onProposalKey: (key: string) => void = () => {};
    let dispatchShortcut: (verb: string) => void = () => {};
    let requestClose: () => void = () => {};
    const removeInputListener = surface.addInputListener((text) => {
        if (matchesKey(text, "escape")) {
            if (inFlight) {
                requestCancel("user_escape");
                return { consume: true };
            }
            if (surface.editor.getText().length > 0) surface.setInput("");
            return { consume: true };
        }
        if (matchesKey(text, "ctrl+c")) {
            if (inFlight && !cancelRequested) requestCancel("user_sigint");
            else requestClose();
            return { consume: true };
        }
        if (matchesKey(text, "ctrl+d") && surface.editor.getText().length === 0) {
            requestClose();
            return { consume: true };
        }
        // A pending proposal + an EMPTY prompt line: a single review key
        // (a/e/r/c) resolves it. Anything else — including typing `/accept` —
        // falls through to the editor, so the typed verb fallback works.
        if (pendingProposal !== null && surface.editor.getText().length === 0 && /^[aerc]$/i.test(text)) {
            onProposalKey(text);
            return { consume: true };
        }
        const dir = cycleKey(text);
        if (dir !== null) { cycleLook(dir); return { consume: true }; }
        const verb = altShortcut(text);
        if (verb !== null) { dispatchShortcut(verb); return { consume: true }; }
        return undefined;
    });
    void seedPromptHistory({ call: (m, p) => transport.rpc(m, p) }, current.id, surface);

    // Proposal lifecycle stays non-blocking. The editor remains available for
    // a/e/r/c or the equivalent typed verbs; only $EDITOR takes terminal custody.
    const proposalQueue: ProposalParams[] = [];
    const showNextProposal = (): void => {
        if (pendingProposal !== null || proposalQueue.length === 0) return;
        pendingProposal = proposalQueue.shift() as ProposalParams;
        printAbove(`${renderProposalMenu(pendingProposal)}\n`
            + "\x1b[2m  resolve: a/e/r/c  or  /accept /reject /cancel /edit\x1b[0m");
    };
    const resolvePending = async (resolution: Resolution): Promise<void> => {
        const p = pendingProposal;
        if (p === null) return;
        pendingProposal = null;
        try {
            await transport.resolve({ logEntryId: p.logEntryId, ...resolution });
        } catch (cause) {
            printAbove(renderTuiFailure(cause));
        }
        showNextProposal();
    };
    // `e`/`/edit` → $EDITOR through pi-tui's bounded terminal handoff.
    const editAndResolve = async (): Promise<void> => {
        const p = pendingProposal;
        if (p === null) return;
        let resolution: Resolution;
        try {
            resolution = (await surface.handOff(() => keyToResolution("e", p)))
                ?? { decision: "cancel", outcome: "edit_failed" };
        } catch (cause) {
            printAbove(renderTuiFailure(cause));
            resolution = { decision: "cancel", outcome: "edit_error" };
        }
        await resolvePending(resolution);
    };
    // Single review key: a/r/c resolve directly, e edits.
    onProposalKey = (key: string): void => {
        if (key.toLowerCase() === "e") { void editAndResolve(); return; }
        void keyToResolution(key, pendingProposal as ProposalParams)
            .then((r) => { if (r !== null) return resolvePending(r); });
    };
    // The persistent run-plane handlers — one set, wired once, driven by whichever
    // transport is live. Same bodies as the old inline rpc.onNotification handlers;
    // they render the shared workspace's activity whether this REPL started the loop
    // or a worker/second client did (multi-client observability).
    const handleNotice = (notice: Notice): void => {
        // engine:turn liveness is owned by the run state, not a waterfall line.
        if (notice.source === "engine:turn") return;
        // Derivation progress is ephemeral status, never an append-only waterfall.
        const derivation = derivationActivity(notice);
        if (derivation !== undefined) {
            embedding = derivation !== null && derivation.label !== "indexing failed";
            embeddingPercent = embedding && derivation !== null ? derivation.percent : null;
            if (derivation?.label === "indexing failed") printAbove(renderDiagnostic(notice));
            else repromptPreserving();
            return;
        }
        // Search acquisition is the same compact lifecycle shape: update the
        // prompt percentage, never append one notice line per tick.
        if (notice.kind === "search_progress" && notice.source.startsWith("exec:")) {
            searchFetching = notice.phase !== "complete" && notice.phase !== "failed";
            const percent = Number(notice.percent);
            searchPercent = searchFetching && Number.isFinite(percent) ? percent : null;
            repromptPreserving();
            return;
        }
        printAbove(renderDiagnostic(notice));
    };
    const handleBranchBatch = (event: BranchBatchEvent): void => {
        let rendered = false;
        if (event.state === "completed") {
            branchBatch = null;
            printAbove(`🌿 branch batch ${event.batchId} complete (${event.completed ?? event.total ?? 0}/${event.total ?? event.completed ?? 0})`);
            rendered = true;
        } else if (event.state === "failed") {
            branchBatch = null;
            printAbove(`\x1b[31m❌ branch batch ${event.batchId} failed: ${event.problem?.detail ?? "branch preflight failed"}\x1b[0m`);
            rendered = true;
        } else {
            branchBatch = event;
            if (event.state === "recovery_required") {
                printAbove(`\x1b[31m❌ branch batch ${event.batchId} requires recovery: ${event.problem?.detail ?? "inspect the workspace Git state"}\x1b[0m`);
                rendered = true;
            }
        }
        if (!rendered) repromptPreserving();
    };

    transport.subscribe({
        onReasoning: presentReasoning,
        onEntry: (entry) => {
            // The typed line at the prompt is the user's record — rendering the
            // prompt broadcast too would duplicate it (see isPromptEntry).
            if (isPromptEntry(entry)) return;
            if (isEntryMaterialization(entry)) return;
            // Record this op's REAL target URI for the Alt-p/Alt-n LOOK cycler.
            const target = entryTarget(entry);
            if (target !== null) priorTargets.push(target);
            printAbove(renderLogEntry(entry, surface.columns || 80));
        },
        onNotice: handleNotice,
        onProblem: (problem) => printAbove(renderDiagnostic(problem)),
        onBranchBatch: handleBranchBatch,
        onStatus: (gauge) => {
            authoritativeStatus = projectStatusGauge(gauge.plurnk.status);
            repromptPreserving();
        },
        onStream: (payload) => {
            // One channel for the lifecycle: concluded carries its exact result, a start
            // event carries state. One start line, one conclusion line, tiny outputs inlined.
            if (typeof (payload as { result?: { status?: unknown } }).result?.status === "number") {
                const p = payload as StreamConcludedPayload;
                printAbove(streams.concluded(p));
                void transport.rpc("entry.read", { target: p.target, workerId: p.workerId }).then((r) => {
                    const channels = (r as { entry?: { channels?: Record<string, { content?: string }> } | null }).entry?.channels ?? {};
                    for (const name of ["stdout", "stderr"]) {
                        const content = channels[name]?.content;
                        if (typeof content === "string" && inlineable(content)) printAbove(renderInline(name, content));
                    }
                }).catch(() => { /* peek is best-effort */ });
            } else {
                const line = streams.event(payload as StreamEventPayload);
                if (line !== null) printAbove(line);
            }
        },
        onProposal: (p) => {
            if (opts.yolo) {
                void transport.resolve({ logEntryId: p.logEntryId, decision: "accept", outcome: "client_yolo" })
                    .catch((cause) => printAbove(`  \x1b[31mauto-accept failed: ${cause instanceof Error ? cause.message : String(cause)}\x1b[0m`));
                return;
            }
            proposalQueue.push(p);
            showNextProposal();
        },
        onInteraction: (i) => {
            // The question tool paused its loop: render the standard message + the
            // schema's single-property enum choices; the line handler resolves the
            // typed answer back into the paused run.
            pendingQuestion = { interactionId: i.interactionId, schema: i.responseSchema };
            printAbove(renderQuestionMenu(i.message, questionChoices(i.responseSchema)));
            reprompt();
        },
        // The summary is rendered from the run's own done below.
        onTerminated: () => {},
    });

    // Startup warming begins while AG-UI is still establishing the workspace, before a
    // request-scoped SSE exists. Poll the engine's latest structured state until terminal;
    // later updates arrive as Notices on the run stream.
    let lastDerivationState = "";
    let derivationPoll: ReturnType<typeof setInterval> | null = null;
    const pollDerivation = async (): Promise<void> => {
        try {
            const { status } = await transport.rpc<{ status: Notice | null }>("workspace.derivation");
            if (status === null) {
                if (derivationPoll !== null) clearInterval(derivationPoll);
                derivationPoll = null;
                return;
            }
            const signature = JSON.stringify(status);
            if (signature !== lastDerivationState) {
                lastDerivationState = signature;
                handleNotice({ ...status, source: "engine:derivation", kind: "embed_progress" });
            }
            if (status.phase === "complete" || status.phase === "failed") {
                if (derivationPoll !== null) clearInterval(derivationPoll);
                derivationPoll = null;
            }
        } catch {
            // A real connection failure is surfaced by the transport's normal close path.
        }
    };
    derivationPoll = setInterval(() => { void pollDerivation(); }, 1_000);
    // The running loop's elapsed time ticks in the status row.
    const statusTick = setInterval(() => { if (inFlight) reprompt(); }, 1_000);
    statusTick.unref();
    void pollDerivation();

    // Verbs + read-only subcommands call rpc.call(...) only; route that through the
    // live transport (WS, or the bridge's management plane over /plurnk/rpc). A
    // .call-only adapter — no verb/subcommand here subscribes, so the other Rpc
    // methods are never reached.
    const verbRpc = { call: (method: string, params?: object): Promise<unknown> => transport.rpc(method, params) } as VerbCaller;

    // Verb dispatch runs through the testable module-level handleVerb; this
    // context injects the live workspace / opts / stdout / import glue.
    const verbCtx: VerbContext = {
        rpc: verbRpc, opts,
        get model(): ResolvedModelSpec | null { return workerModel; },
        get spawnModel(): ResolvedModelSpec | null { return workerSpawnModel; },
        get reasoning(): WorkerReasoning { return workerReasoning; },
        setModel: (spec) => { workerModel = spec; },
        setSpawnModel: (spec) => { workerSpawnModel = spec; },
        setReasoning: (reasoning) => { workerReasoning = reasoning; },
        getWorkspace: () => current,
        setWorkspace: (s) => { current = s; },
        switchWorkspace: (name) => transport.useSession(name, { projectRoot: opts.projectRoot, client: opts.client }),
        getWorker: () => conversationWorker,
        attachWorker: (name) => {
            transport.useWorker(name, current.name);
            conversationWorker = name;
            conversationWorkerId = null;
        },
        write: (text) => { printAbove(text); },
        importFile: async (rest) => {
            const abs = isAbsolute(rest) ? rest : resolve(process.cwd(), rest);
            let content: string;
            try { content = await readFile(abs, "utf8"); }
            catch (cause) { printAbove(`  not readable: ${cause instanceof Error ? cause.message : String(cause)}`); return; }
            surface.insertInput(content);
        },
        resolveProposal: async (action) => {
            if (pendingProposal === null) { printAbove("  (no pending proposal)"); return; }
            if (action === "edit") { await editAndResolve(); return; }
            await resolvePending({ decision: action });
        },
        // /editor · Alt-e: place the edited multiline value back in the composer;
        // Enter remains the only submit gesture.
        composeInEditor: async () => {
            let edited: string | null = null;
            try {
                edited = await surface.handOff(() => editInEditor(surface.editor.getExpandedText(), ".md"));
            } catch (cause) {
                printAbove(renderTuiFailure(cause));
            }
            if (edited === null) return;
            surface.setInput(edited.replace(/\n$/, ""));
        },
    };

    // Alt-<letter> shortcut → the same verb contract as typed `/verb`.
    dispatchShortcut = (verb: string): void => {
        void (async () => {
            try {
                if (await handleVerb(verb, verbCtx) === "quit") { requestClose(); return; }
            } catch (cause) {
                printAbove(renderTuiFailure(cause));
            }
            reprompt();
        })();
    };

    return new Promise<void>((resolve) => {
        let closed = false;
        const close = (): void => {
            if (closed) return;
            closed = true;
            shuttingDown = true;
            if (derivationPoll !== null) clearInterval(derivationPoll);
            transport.shutdown();
            removeInputListener();
            surface.stop();
            process.stdout.write(`  \x1b[2mresume this workspace:  plurnk --workspace ${current.name}\x1b[0m\n`);
            resolve();
        };
        requestClose = close;

        const submit = async (line: string): Promise<void> => {
            if (line.trim().length > 0) printAbove(renderSubmittedInput(line, opts.yolo));
            // A pending request-user-input question consumes the typed line as its
            // answer, BEFORE any verb/prompt/inject handling: a number picks an
            // enum choice, anything else is free response (or raw JSON for a
            // multi-property schema). Empty → re-ask. Resolves the paused run with
            // the standard ElicitResult payload.
            if (pendingQuestion !== null) {
                const content = answerForQuestion(line, pendingQuestion.schema);
                if (content === null) { reprompt(); return; }
                const { interactionId } = pendingQuestion;
                pendingQuestion = null;
                await transport.resolveInteraction(interactionId, { action: "accept", content })
                    .catch((e) => printAbove(`  \x1b[31manswer failed: ${e instanceof Error ? e.message : String(e)}\x1b[0m`));
                reprompt();
                return;
            }
            const trimmed = line.trim();
            if (trimmed.length === 0) {
                reprompt();
                return;
            }

            // Verbs: /stop and /help stay reachable while a loop is in
            // flight — /stop is precisely the mid-loop verb.
            if (trimmed.startsWith("/")) {
                const { verb } = parseSlash(trimmed);
                // /stop, /help, and the proposal verbs stay reachable mid-loop —
                // a proposal pauses the loop and must be resolvable by typing.
                // /quit is the universal escape: NEVER "busy"-blocked, so a wedged
                // or disconnected loop is always exitable (the daemon owns the loop;
                // quitting the client just drops the connection — resumable).
                const PASS = new Set(["stop", "help", "", "accept", "reject", "cancel", "edit", "quit"]);
                if (inFlight && !PASS.has(verb)) {
                    printAbove("  \x1b[2m(busy; /stop to cancel, /quit to exit, /help for the language)\x1b[0m");
                    return;
                }
                try {
                    if (await handleVerb(trimmed, verbCtx) === "quit") { close(); return; }
                } catch (cause) {
                    printAbove(renderTuiFailure(cause));
                }
                reprompt();
                return;
            }

            if (inFlight) {
                // A model loop is running. A prompt typed now is the "btw"
                // steering case (loop.inject, #193), NOT a conflict — inject it
                // into the live loop. (Raw DSL / exec are separate client-run
                // ops; keep them out of a running conversation for now.)
                if (dslStatement(trimmed) !== null || trimmed.startsWith("!")) {
                    printAbove("  \x1b[2m(loop running — /stop before a client op)\x1b[0m");
                    return;
                }
                const inject = trimmed.replace(/^(\.\.\.|[?:])\s*/, "");
                void transport.inject(inject)
                    .then(() => printAbove("  \x1b[2m↳ added to the run\x1b[0m"))
                    .catch((cause) => printAbove(`  \x1b[31minject failed: ${cause instanceof Error ? cause.message : String(cause)}\x1b[0m`));
                reprompt();
                return;
            }

            inFlight = true;
            lifecycle = "running";
            authoritativeStatus = null;
            // Keep a live steer prompt for the duration of the loop so traces can
            // print above an editable injection row.
            reprompt();
            const start = Date.now();
            runningSince = start;
            let turnCount = 0;
            let terminalResult: OperationResult = { status: 0 };
            let hitMaxTurns = false;
            let usage: LoopUsage | undefined;

            try {
                const statementText = dslStatement(trimmed);
                const lookText = statementText !== null ? lookStatement(statementText) : null;
                if (lookText !== null) {
                    // LOOK: off-run READ on the side connection — for me, not the model.
                    terminalResult = await runLook(lookText);
                } else if (statementText !== null) {
                    // Raw DSL: send to op.parse
                    const result = await transport.rpc("op.parse", { text: statementText }) as { results: OperationResult[] };
                    terminalResult = result.results[result.results.length - 1] ?? { status: 0 };
                } else if (trimmed.startsWith("!")) {
                    // `! cmd` — exec via the daemon (proposal-gated like any
                    // side effect; output streams as stream/event traces).
                    const command = trimmed.replace(/^!+\s*/, "");
                    terminalResult = await transport.rpc("op.exec", { command }) as OperationResult;
                } else {
                    // Prompt prefixes are client policy projections. `?` narrows
                    // the ordinary loop by denying EXEC and retaining review;
                    // `:` is the unmodified base policy.
                    const { policy, prompt: promptText } = linePolicy(trimmed, opts.loopPolicy);
                    // {§worker-model-selection} — no model selector rides the loop: the
                    // worker owns the model; /model and /child persisted it server-side.
                    const loopParams: { policy: LoopPolicy; maxTurns?: number; openPaths?: string[] } = { policy };
                    if (opts.maxTurns !== undefined) loopParams.maxTurns = opts.maxTurns;
                    const openPaths = extractOpenPaths(promptText);   // @file refs → daemon turn-0 READs (#260)
                    if (openPaths.length > 0) loopParams.openPaths = openPaths;
                    // The transport owns the ack→terminated bridge; done resolves
                    // with the loop's outcome. A pre-stream HTTP failure surfaces as
                    // an exact ProblemError (caught below; 501 gets the .env pointer).
                    const t = await transport.run(promptText, loopParams).done;
                    terminalResult = t.result;
                    hitMaxTurns = t.hitMaxTurns;
                    turnCount = t.turnIds?.length ?? 0;
                    usage = t.usage;
                    if (t.workerId !== undefined && t.workerId !== conversationWorkerId) {
                        conversationWorkerId = t.workerId;
                        const { workers } = await transport.rpc("workspace.workers") as { workers: Array<{ id: number; name: string }> };
                        const hit = workers.find((worker) => worker.id === conversationWorkerId);
                        if (hit === undefined) throw new Error(`worker ${conversationWorkerId} concluded a loop but workspace.workers does not list it`);
                        conversationWorker = hit.name;
                    }
                }
                lifecycle = terminalResult.status === 202 ? "parked"
                    : terminalResult.status === 499 ? "cancelled"
                        : terminalResult.status >= 400 ? "failed"
                            : "completed";
                const wallMs = Date.now() - start;
                printAbove(renderSummary(turnCount, wallMs, terminalResult, hitMaxTurns, usage));
            } catch (cause) {
                lifecycle = "failed";
                printAbove(renderTuiFailure(cause));
            } finally {
                tally = tallyOutcome(tally, { turns: turnCount, wallMs: Date.now() - start, usage });
                runningSince = null;
                inFlight = false;
                cancelRequested = false;
                pendingQuestion = null;   // loop ended (incl. cancel) → drop any unanswered question
                reprompt();
            }
        };

        surface.editor.onSubmit = (line) => {
            if (line.trim().length > 0) surface.editor.addToHistory(line);
            void submit(line);
        };
        reprompt();
        surface.start();
    }).finally(() => {
        clearInterval(statusTick);
        releaseGuards();
        surface.stop();
    });
};
