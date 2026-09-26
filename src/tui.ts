// TUI mode — interactive Plurnk client on pi-tui's main-screen renderer.
// Per TUI.md §3.
//
// Line language:
//   /verb [args]   command verbs (see VERBS); never call loop.run
//   named executable fences through op.parse
//   LOOK fences via op.look — inspect a uri's content for ME, not the model
//   ! cmd          op.exec via the daemon
//   ... msg         loop.inject — speak into the running model loop
//   ? text         select proposal review for this loop
//   : text         act (the default)
//   text           prompt
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { matchesKey, type AutocompleteItem, type AutocompleteProvider } from "@earendil-works/pi-tui";
import TuiSurface from "./tui-surface.ts";
import TerminalGuards from "./tui-guards.ts";
import CancelGesture from "./tui-cancel.ts";
import ModelText from "./model-text.ts";
import { paint } from "./color.ts";
import { extractOpenPaths } from "./openpaths.ts";
import { pathPartial, completePath, dslOpPartial, completeOps, dslStatement } from "./completion.ts";
// The verb wire: a structural caller (AG-UI+ actions underneath).
export interface VerbCaller { call(method: string, params?: object): Promise<unknown> }
import { renderReasoning, renderSummary, isOwnArrival, isResponseMessage, entryTarget, isEntryMaterialization, FanoutCollapse, renderPendingRow } from "./render.ts";
import { renderDescendantBlock, renderLogEntry } from "./render-message.ts";
import { indentDescendant, lineageWorker, markDescendant, type Descendant } from "./render.ts";
import { lookFence, renderLook, type LookResult } from "./look.ts";
import type { ReasoningUpdate } from "./reasoning-events.ts";
import type { LogEntryWire } from "./render.ts";
import { renderProposalMenu, keyToResolution, renderQuestionMenu, editInEditor } from "./proposal.ts";
import QuestionForm from "./QuestionForm.ts";
import { BridgeTransport, type ObservationHandle, type Transport } from "./transport.ts";
import type { ProposalParams, Resolution } from "./proposal.ts";
import { ProblemError, renderDiagnostic, report, clientSubcommandUnknownVerb, clientConversationLost, NO_MODEL_HINT } from "./diagnostics.ts";
import type { Notice } from "./diagnostics.ts";
import StreamTrace, { renderInline } from "./stream.ts";
import type { StreamEventPayload, StreamConcludedPayload } from "./stream.ts";
import { runModels, runWorkspaceList, runLogRead } from "./subcommands.ts";
import { promptPrefix, renderWorkerTopology, siblingPosition, traverse, workerNameFromTarget, workerPath, type Hop, type WorkerRow } from "./workers.ts";
import {
    Validator,
    type CapabilityPolicy,
    type LoopPolicyRequest,
    type ModelRoute,
    type OperationResult,
} from "@plurnk/plurnk-contracts";
import { formatCapabilityProjection, parseCapabilityPolicy, promptPolicy } from "./policy.ts";
import { handleMcp } from "./mcp.ts";
import { handleSkills } from "./skills.ts";
import { handleA2a } from "./a2a.ts";
import { handleSchedule } from "./schedule.ts";
import { handleMembers } from "./members.ts";
import { handleEnv } from "./env.ts";
import {
    formatWorkerReasoning,
    readWorkerReasoning,
    setWorkerReasoning,
    type WorkerReasoning,
} from "./reasoning.ts";
import { EMPTY_TALLY, accrueTurnAccounting, turnAccountingFromNotice, formatRouteIdentity, projectStatusGauge, conversationLost, renderStatusLine, tallyOutcome, type ClientStatus, type SessionTally, type StatusLifecycle, type TurnAccounting, type WorkerDoing } from "./status.ts";
import {
    COMMANDS,
    commandSpec,
    FAMILY_ACTIONS,
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
    return `  ${paint(`error: ${ModelText.plain(cause instanceof Error ? cause.message : String(cause))}`, "failure")}`;
};

// The loop.run ack/terminated bridge (fire-and-forget: ACK {finalStatus:100} then
// the outcome on loop/terminated; a synchronous 501/error surfaces immediately)
// now lives in the Transport (WsTransport's loopId-keyed done, TerminatedInfo).

interface WorkspaceResult { name: string }

// One verb vocabulary across the TUI and (where they exist) argv subcommands.
// Singular = CREATE, plural = LIST: /workspace makes a new workspace, /workspaces
// lists them; /worker forks a new worker, /workers lists them. The old /new was
// ambiguous (workspace or worker?) and is gone. /rename retargets the current
// workspace's mutable handle (a worker's name is immutable — no /rename for workers).
export const VERBS: readonly CommandName[] = COMMANDS.map(({ name }) => name);
export const TUI_HELP = renderCommandHelp();

// Case-sensitive quick-keys (Alt-m = `ESC m`, Alt-M = `ESC M` — distinct bytes).
// Delivered as Alt not Ctrl because Ctrl-<letter> collides with terminal and
// editor control keys. Alt-b/f/d remain the editor's word operations.
export const ALT_SHORTCUTS: Readonly<Record<string, string>> = Object.freeze({
    m: "/models", s: "/workspaces", R: "/workers", L: "/log",
    Y: "/yolo", N: "/workspace", M: "/members", x: "/stop", "?": "/help", e: "/editor",
    // {§cli-workers-topology} — vim's tree orientation: depth is horizontal, siblings vertical.
    h: "/parent", l: "/enter", j: "/older", k: "/newer",
});

// An Alt-<key> keypress (ESC then a single letter or `?`, no `[`/`O` → not an arrow
// or function key) mapped to its verb, or null. Case-sensitive.
// pi-tui's terminal buffer reassembles split escape sequences.
export const altShortcut = (forward: string): string | null => {
    const m = forward.match(/^\x1b([a-zA-Z?])$/);
    return m ? (ALT_SHORTCUTS[m[1]] ?? null) : null;
};

// Shift-Tab (`ESC [ Z`, the xterm back-tab) toggles yolo. It is a modifier on a key nothing else
// in the prompt uses, so it reads as a mode switch rather than a command, and it needs no empty
// line: an operator mid-sentence can change their mind about the next proposal. `altShortcut`
// cannot carry it — that grammar is deliberately `ESC <letter>` and excludes `[` sequences.
export const backTabShortcut = (forward: string): string | null =>
    forward === "\x1b[Z" ? "/yolo" : null;

// Recognize the client-only LOOK surface so it can be routed to `op.look`.
// The AG-UI observation action owns validation and the single LOOK→READ rewrite.
export const lookStatement = (line: string): string | null =>
    /^`{3,}LOOK(?![A-Za-z0-9_.+-])/.test(line) ? line : null;

export const linePolicy = promptPolicy;

// {§cli-log-entry-line-format} — the human's line in scrollback: bold, in the human's own colour, so
// the two voices read apart while the model's reply stays plain.
export const renderSubmittedInput = (text: string): string => text.split("\n")
    .map((line, index) => paint(`${index === 0 ? "› " : "  "}${line}`, "bold", "human"))
    .join("\n");

// A blank row above and below the line; an empty print is the surface's spacer.
export const printSubmittedInput = (print: (text: string) => void, text: string): void => {
    print("");
    print(renderSubmittedInput(text));
    print("");
};

export const resumeCommand = (workspace: string, worker: string): string => {
    const quote = (value: string): string => /^[A-Za-z0-9_.:/-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
    return `plurnk --workspace ${quote(workspace)} --worker ${quote(worker)}`;
};

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
    getFunctionalityAliases?: (family: FunctionalityFamily, scope?: "worker" | "workspace") => Promise<string[]>;
    getWorkerNames?: () => Promise<string[]>;
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
            try { aliases = await options.getFunctionalityAliases?.(command.family, command.scope) ?? []; }
            catch { /* completion failure is an empty result; the editor remains intact */ }
            return {
                suggestions: aliases
                    .filter((alias) => alias.startsWith(command.prefix))
                    .map((value) => ({ value, description: `${command.family} alias` })),
                prefix: command.prefix,
            };
        }
        const workerFrag = line.match(/^\/attach\s+(\S*)$/);
        if (workerFrag) {
            let names: string[] = [];
            try { names = await options.getWorkerNames?.() ?? []; }
            catch { /* completion failure is an empty result; the editor remains intact */ }
            return {
                suggestions: names.filter((name) => name.startsWith(workerFrag[1])).map((value) => ({ value, description: "worker" })),
                prefix: workerFrag[1],
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
        const reasoningFrag = line.match(/^\/effort\s+(\S*)$/);
        if (reasoningFrag) {
            return {
                suggestions: (options.getReasoningPolicies?.() ?? [])
                    .filter((policy) => policy.startsWith(reasoningFrag[1]))
                    .map((value) => ({ value, description: "reasoning effort" })),
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
    history: { addHistory(promptsNewestFirst: readonly string[]): void },
): Promise<void> => {
    try {
        const { prompts } = await rpc.call("workspace.prompts", { limit: 100 }) as { prompts?: string[] };
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
    // The header names the non-default. Review is what ships, so the header is silent about it and
    // calls out the session that turned it off — the mode where nobody sees the question.
    const yolo = opts.yolo === true ? " · yolo: on" : "";
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
    // /look <address> [<scope>] [pattern] — inspect a resource for the human ({§cli-inspection}).
    look: (rest: string) => Promise<void>;
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
        case "look": await ctx.look(rest); return;
        case "models": await runModels(rpc, {
            json: false,
            query: rest.length === 0 ? {} : { search: rest },
        }); return;
        case "workspaces": await runWorkspaceList(rpc, { json: false }); return;
        case "workers": {
            // {§cli-workers-topology} — the directory as a forest rooted at the bound worker.
            const { workers } = await rpc.call("workspace.workers") as { workers: WorkerRow[] };
            write(renderWorkerTopology(workers, ctx.getWorker()));
            return;
        }
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
                write(`${renderTuiFailure(cause)}\n`);
                return;
            }
            try {
                ctx.setReasoning(await readWorkerReasoning(rpc));
            } catch (cause) {
                write(`  reasoning refresh failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
            }
            return;
        case "effort":
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
                    ? await rpc.call("workspace.capabilities.get") as Record<string, CapabilityPolicy>
                    : await rpc.call("workspace.capabilities.set", {
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
                write(`${renderTuiFailure(cause)}\n`);
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
            ctx.attachWorker(forked.workerName);
            await refreshWorkerPolicy();
            write(`  worker: ${forked.workerName} (new)\n`);
            return;
        }
        case "attach": {
            // {§cli-workers-topology} — an existing worker is bound, a new name mints a
            // fresh conversation on the next run (the `--worker` path); the world stays.
            if (rest.length === 0) { write("  usage: /attach <name>\n"); return; }
            const { workers } = await rpc.call("workspace.workers") as { workers: WorkerRow[] };
            const known = workers.some((worker) => worker.name === rest);
            ctx.attachWorker(rest);
            await refreshWorkerPolicy();
            write(`  worker: ${rest} (${known ? "bound" : "new"})\n`);
            return;
        }
        case "parent":
        case "enter":
        case "older":
        case "newer": {
            // {§cli-workers-topology} — one hop over the workspace tree is a full attach: the prompt
            // then speaks to that worker. The directory is re-read on every hop; nothing is inferred.
            const { workers } = await rpc.call("workspace.workers") as { workers: WorkerRow[] };
            const { target, notice } = traverse(workers, ctx.getWorker(), verb as Hop);
            if (target === null) { write(`  (${notice ?? "nowhere to go"})\n`); return; }
            ctx.attachWorker(target.name);
            await refreshWorkerPolicy();
            const position = siblingPosition(workers, target.name);
            write(`  worker: ${target.name} [${workerPath(workers, target.name)}]${position === null ? "" : ` (${position.index}/${position.count})`}\n`);
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
        case "a2a": {
            await handleA2a(rest, rpc, write);
            return;
        }
        case "schedule": {
            await handleSchedule(rest, rpc, write);
            return;
        }
        case "members": {
            await handleMembers(rest, rpc, write);
            return;
        }
        case "env": {
            await handleEnv(rest, rpc, write);
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
    loopPolicy: LoopPolicyRequest; maxTurns?: number;
    projectRoot?: string | null; versionNotice?: string;
    workerName?: string;        // shown in the banner when explicitly set
    client?: string;            // #249 — frontend id, carried onto /workspace-created workspaces
    mcpConfiguration?: Readonly<Record<string, string>>;
}): Promise<void> => {
    let current = workspace;
    // Loop state, hoisted so the line handler and SIGINT can share it.
    let inFlight = false;
    // {plurnk#91} — the worker's current activity, painted while a loop runs.
    let doing: WorkerDoing | null = null;
    let pendingCommands = 0;
    let rebinding = false;
    let activeRun: ObservationHandle | null = null;
    const pendingInjections = new Set<Promise<void>>();
    let followAdmission = false;
    let printAbove: (text: string) => void = (text) => { process.stdout.write(`${text}\n`); };
    // {plurnk#104} — an alert block stands apart: a blank row above and below it.
    const printAlert = (block: string): void => { printAbove(""); printAbove(block); printAbove(""); };
    const cancelLoop = async (reason: string): Promise<unknown> => {
        const run = activeRun;
        const result = await transport.rpc("loop.cancel", { reason });
        run?.cancel();
        return result;
    };
    // One cancel path for every interrupt gesture (Ctrl-C, Esc, /stop): the
    // run's active drain cancels via loop.cancel; the pending loop resolves
    // 499 and the REPL continues. A failed cancel SURFACES — a stop button
    // that silently does nothing is the worst kind of broken. The latch and the
    // failure's disposition live in CancelGesture ({§cli-cancellation}).
    const gesture = new CancelGesture({
        cancel: cancelLoop,
        print: (line) => { printAbove(line); },
        close: () => { requestClose(); },
    });
    // Ephemeral progress projected into the prompt while background work is active.
    let lifecycle: StatusLifecycle = "idle";
    let authoritativeStatus: ClientStatus | null = null;
    let tally: SessionTally = EMPTY_TALLY;
    let accrued: TurnAccounting | null = null;
    let runningSince: number | null = null;
    let conversationWorkerId: number | null = null;
    // {plurnk#108} — the descendants the daemon introduced for this session's delegation observation.
    const descendants = new Map<number, Descendant>();
    const observedNames = new Set<string>();
    // {§cli-workers-topology} — where the session is in the tree: the prompt's path prefix and the
    // status line's sibling position, re-read from the directory on every hop or rebind.
    let workerPosition: { index: number; count: number } | null = null;
    // {plurnk#58} — the prompt prefix names workspace/loop/turn; the gauge is the only authority
    // for both numbers, and an unknown one is elided rather than guessed.
    let placeLoop: number | null = null;
    let placeTurn: number | null = null;
    let seenLoopId: number | null = null;
    let placeWorkers: readonly WorkerRow[] = [];
    let conversationWorker: string | null = opts.workerName ?? null;
    let searchFetching = false;
    let searchPercent: number | null = null;
    // A `?` prompt asks for review of that run; the request outranks the standing yolo setting.
    let reviewRequested = false;
    // Inspection: the REAL target URIs of prior operations the waterfall has shown
    // (oldest→newest, e.g. worker:///plan.md), each with the worker it was seen under, feed
    // the Alt-p/Alt-n cycler — not synthesized log-entry coordinates. lookCursor walks them.
    const priorTargets: Array<{ target: string; workerId: number | null }> = [];
    let lookCursor: number | null = null;
    // The cycler offers the bound conversation's targets only: a hop is a full attach, and an
    // address harvested under another worker would resolve against the wrong log.
    const lookCandidates = (): string[] => priorTargets
        .filter(({ workerId }) => workerId === null || conversationWorkerId === null || workerId === conversationWorkerId)
        .map(({ target }) => target);
    let liveReasoning: { messageId: string; rendered: string } | null = null;
    let pendingProposal: ProposalParams | null = null;
    let pendingQuestion: { interactionId: number; form: QuestionForm } | null = null;

    // Streams, coalesced: one start line, one conclusion line, and tiny concluded
    // outputs inlined (the single bounded content fetch the TUI makes — SPEC §5.3).
    const streams = new StreamTrace();
    // A client-typed execution's inline peek is part of its presentation: the op's summary and
    // the prompt wait for it, so the next command never races the read's turn on the daemon.
    const peeks: Promise<void>[] = [];
    const settlePeeks = async (): Promise<void> => { await Promise.all(peeks.splice(0)); };
    const fanout = new FanoutCollapse();
    let presentedTurn: string | null = null;

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
    surface.append(paint(header, "dim"));
    surface.append("");
    if (reasoningFailure !== undefined) printAlert(renderTuiFailure(reasoningFailure));

    // Client-owned lifecycle and model lead the input affordance; ephemeral
    // derivation, search, and branch work share its final activity position.
    const statusContext = () => ({
        workspace: current.name,
        worker: conversationWorker,
        position: workerPosition,
        child: workerSpawnModel === null ? null : resolvedModelLabel(workerSpawnModel),
        tally,
        accrued,
        runningSince,
        now: Date.now(),
        doing,
    });
    const paintPrompt = (): void => surface.setPrompt(promptPrefix(
        workerPath(placeWorkers, conversationWorker),
        { workspace: current.name, loopId: placeLoop, turn: placeTurn },
    ));
    const refreshTopology = async (): Promise<void> => {
        const { workers } = await transport.rpc("workspace.workers") as { workers: WorkerRow[] };
        workerPosition = siblingPosition(workers, conversationWorker);
        placeWorkers = workers;
        paintPrompt();
        reprompt();
    };
    const buildStatus = (): string => {
        if (authoritativeStatus !== null) {
            return renderStatusLine(authoritativeStatus, statusContext(), { yolo: opts.yolo });
        }
        const activity = searchFetching ? { label: "search", percent: searchPercent } : null;
        const model = workerModel === null
            ? opts.modelSelector ?? activeAlias ?? null
            : resolvedModelLabel(workerModel);
        return renderStatusLine({
            lifecycle: inFlight ? "running" : lifecycle,
            model,
            loopId: placeLoop,
            packetCount: null,
            activity,
            children: null,
        }, statusContext(), { yolo: opts.yolo });
    };
    const reprompt = (): void => surface.setStatus(buildStatus());
    paintPrompt();
    void refreshTopology().catch((cause: unknown) => { printAlert(renderTuiFailure(cause)); });
    const repromptPreserving = reprompt;
    surface.setAutocompleteProvider(makeAutocompleteProvider({
            getAliases: () => aliasCache,
            cwd: process.cwd(),
            // {§cli-workers-topology} — the directory plus the worker:// references
            // the waterfall has shown (the same harvest the LOOK cycler keeps).
            getWorkerNames: async () => {
                const { workers } = await transport.rpc("workspace.workers") as { workers: WorkerRow[] };
                const seen = priorTargets.map(({ target }) => workerNameFromTarget(target)).filter((name): name is string => name !== null);
                return [...new Set([...workers.map((worker) => worker.name), ...seen])];
            },
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
            getFunctionalityAliases: async (family, scope) => {
                const action = family === "env" && scope === "workspace" ? "workspace.env" : FAMILY_ACTIONS[family];
                const result = await transport.rpc(`${action}.list`, {}) as { definitions?: unknown };
                if (!Array.isArray(result.definitions)) throw new TypeError(`${action}.list returned an invalid result.`);
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
            surface.archiveResponses();
            liveReasoning = { messageId: update.messageId, rendered: "" };
            return;
        }
        if (liveReasoning === null || liveReasoning.messageId !== update.messageId) {
            throw new TypeError(`Reasoning ${update.phase} did not match the active message.`);
        }
        // Reasoning lives in the scroll while it streams and leaves with the turn: immutable history keeps
        // it at reasoning://<worker>/L/T, the transcript never does (a fat reasoning habit stays a third
        // of the screen, not the whole session).
        const rendered = renderReasoning(update.content);
        liveReasoning.rendered = rendered;
        if (update.phase === "content") {
            surface.setLive(rendered);
            return;
        }
        surface.setLive(null);
        liveReasoning = null;
    };

    const setLine = (text: string): void => surface.setInput(text);

    // Alt-p/Alt-n: walk the REAL target URIs of the bound conversation's prior operations and
    // put `/look <target>` into an EMPTY composer — an editable starting point (hand-edit
    // before Enter). A composer holding anything else is the user's; leave it alone.
    const cycleLook = (dir: "up" | "down"): void => {
        const current = surface.editor.getText();
        if (current.length > 0 && !current.startsWith("/look ")) return;
        const candidates = lookCandidates();
        lookCursor = cycleCoord(candidates.length, lookCursor, dir);
        if (lookCursor === null) return;
        setLine(`/look ${candidates[lookCursor]}`);
    };

    // Inspection is the human's, never the loop's ({§cli-inspection}): op.look validates and
    // rewrites the LOOK, resolves the READ as the bound conversation, and writes no log entry;
    // the readout prints above the composer. No lifecycle, summary, or tally, and no wait on
    // a running model.
    const runLook = async (lookText: string): Promise<void> => {
        try {
            const r = await transport.rpc("op.look", { text: lookText }) as LookResult;
            printAbove(renderLook(lookText, r));
        } catch (cause) {
            // An unsuccessful READ reaches the client as its exact Problem: that is the look's outcome.
            if (!(cause instanceof ProblemError)) throw cause;
            printAbove(renderLook(lookText, { status: cause.problem.status, problem: cause.problem }));
        }
    };
    const inspect = (lookText: string): void => {
        pendingCommands += 1;
        void runLook(lookText)
            .catch((cause: unknown) => { printAlert(renderTuiFailure(cause)); })
            .finally(() => { pendingCommands -= 1; });
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
                gesture.request("user_escape");
                return { consume: true };
            }
            if (surface.editor.getText().length > 0) surface.setInput("");
            return { consume: true };
        }
        if (matchesKey(text, "ctrl+c")) {
            if (inFlight && !gesture.requested) gesture.request("user_sigint");
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
        const verb = altShortcut(text) ?? backTabShortcut(text);
        if (verb !== null) { dispatchShortcut(verb); return { consume: true }; }
        return undefined;
    });
    void seedPromptHistory({ call: (m, p) => transport.rpc(m, p) }, surface);

    // Proposal lifecycle stays non-blocking. The editor remains available for
    // a/e/r/c or the equivalent typed verbs; only $EDITOR takes terminal custody.
    const proposalQueue: ProposalParams[] = [];
    const showNextProposal = (): void => {
        if (pendingProposal !== null || proposalQueue.length === 0) return;
        pendingProposal = proposalQueue.shift() as ProposalParams;
        printAbove(`${renderProposalMenu(pendingProposal)}\n`
            + paint("  resolve: a/e/r/c  or  /accept /reject /cancel /edit", "dim"));
    };
    const resolvePending = async (resolution: Resolution): Promise<void> => {
        const p = pendingProposal;
        if (p === null) return;
        pendingProposal = null;
        try {
            await transport.resolve({ logEntryId: p.logEntryId, ...resolution });
        } catch (cause) {
            printAlert(renderTuiFailure(cause));
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
            printAlert(renderTuiFailure(cause));
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
        if (notice.source === "engine:turn") {
            if (inFlight && notice.kind === "turn_awaiting_model") {
                doing = { phase: "awaiting", since: Date.now(), op: null, target: null };
                repromptPreserving();
            } else if (inFlight && notice.kind === "turn_generated" && doing?.phase === "awaiting") {
                doing = { phase: "working", since: Date.now(), op: null, target: null };
                repromptPreserving();
            }
            const accounting = turnAccountingFromNotice(notice);
            if (inFlight && accounting !== null) {
                accrued = accrueTurnAccounting(accrued, accounting);
                repromptPreserving();
            }
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
        printAlert(renderDiagnostic(notice));
    };

    transport.subscribe({
        onReasoning: presentReasoning,
        onDescendant: (descendant) => { descendants.set(descendant.workerId, descendant); observedNames.add(descendant.name); },
        onEntry: (entry) => {
            // The typed line at the prompt is the user's record — rendering the arrival
            // the bridge sourced to this thread would duplicate it (see isOwnArrival);
            // another actor's arrival renders with its sender (#79).
            if (isOwnArrival(entry, transport.threadId())) return;
            if (isEntryMaterialization(entry)) return;
            // {plurnk#108} — an observed descendant's own row: marked and stepped in per generation, and
            // never the turn presentation's, the status line's or the response area's business.
            const descendant = descendants.get(entry.worker_id ?? -1);
            if (descendant !== undefined) {
                if (streams.launch(entry)) return;
                printAbove(renderDescendantBlock(entry, descendant.name, descendant.depth, undefined, surface.columns || 80));
                return;
            }
            const lineage = lineageWorker(entry);
            if (lineage !== null && observedNames.has(lineage)) return;   // its own rows are observed; the parent's echo would repeat them
            const turn = `${entry.worker_id}/${entry.loop_seq}/${entry.turn_seq}`;
            if (entry.origin === "model" && turn !== presentedTurn) {
                surface.archiveResponses();
                for (const stale of streams.staleBefore(entry.loop_seq, entry.turn_seq, entry.worker_id)) printAbove(renderPendingRow(stale));
                presentedTurn = turn;
            }
            // Record this op's REAL target URI for the Alt-p/Alt-n LOOK cycler.
            const target = entryTarget(entry);
            if (target !== null) priorTargets.push({ target, workerId: entry.worker_id ?? null });
            if (inFlight && entry.origin === "model" && typeof entry.op === "string") {
                doing = { phase: "working", since: Date.now(), op: entry.op, target };
                repromptPreserving();
            }
            // {§cli-what-is-not-rendered} — a started execution appears when its outcome is known.
            if (streams.launch(entry)) return;
            // A glob READ's rows collapse to the authored statement once the last row is in.
            const verdict = fanout.admit(entry);
            if (verdict.kind === "suppressed") return;
            const rendered = renderLogEntry(entry, surface.columns || 80, verdict.kind === "collapsed" ? verdict.override : undefined);
            if (isResponseMessage(entry, transport.threadId())) surface.addResponse(entry);
            else printAbove(rendered);
        },
        onNotice: handleNotice,
        onProblem: (problem) => printAlert(renderDiagnostic(problem)),
        onStatus: (gauge) => {
            authoritativeStatus = projectStatusGauge(gauge.plurnk.status);
            // {§cli-conversation-lost} — a bound name answered with no history is a new conversation.
            if (conversationLost(seenLoopId, authoritativeStatus.loopId)) {
                printAlert(renderDiagnostic(clientConversationLost(current.name, conversationWorker ?? current.name)));
            }
            seenLoopId = authoritativeStatus.loopId;
            workerModel = modelRouteOrNull(gauge.plurnk.status.model);
            // {plurnk#58} — the place the next prompt goes to, straight from the gauge.
            placeLoop = authoritativeStatus.loopId;
            placeTurn = authoritativeStatus.packetCount;
            paintPrompt();
            repromptPreserving();
        },
        onStream: (payload) => {
            // One channel for the lifecycle: a conclusion carries its exact result and is the
            // execution's one row; start and growth events say nothing in the transcript.
            if (typeof (payload as { result?: { status?: unknown } }).result?.status === "number") {
                const p = payload as StreamConcludedPayload;
                const observed = descendants.get(p.workerId);
                const block = streams.concluded(p);
                printAbove(observed === undefined ? block : markDescendant(block, observed.name, observed.depth));
                // Every execution is asked for its output, the human's and the model's alike: a
                // preview of each channel inlines under its row ({plurnk#104}).
                peeks.push(transport.rpc("entry.read", { target: p.target, workerId: p.workerId }).then((r) => {
                    const channels = (r as { entry?: { channels?: Record<string, { content?: string }> } | null }).entry?.channels ?? {};
                    for (const name of ["stdout", "stderr"]) {
                        const content = channels[name]?.content;
                        if (typeof content === "string" && content.trim().length > 0) printAbove(observed === undefined ? renderInline(name, content) : indentDescendant(renderInline(name, content), observed.depth));
                    }
                }).catch(() => { /* peek is best-effort */ }).finally(() => { printAbove(""); }));
            } else {
                const line = streams.event(payload as StreamEventPayload);
                if (line !== null) printAbove(line);
            }
        },
        onProposal: (p, source = "model") => {
            if (opts.yolo && !(source === "model" && reviewRequested)) {
                void transport.resolve({ logEntryId: p.logEntryId, decision: "accept", outcome: "client_yolo" })
                    .catch((cause) => printAbove(`  ${paint(`auto-accept failed: ${cause instanceof Error ? cause.message : String(cause)}`, "failure")}`));
                return;
            }
            proposalQueue.push(p);
            showNextProposal();
        },
        onInterruptEnd: (id) => {
            if (id === `int:${pendingQuestion?.interactionId}`) pendingQuestion = null;
            if (id === `prop:${pendingProposal?.logEntryId}`) pendingProposal = null;
            const index = proposalQueue.findIndex((proposal) => id === `prop:${proposal.logEntryId}`);
            if (index !== -1) proposalQueue.splice(index, 1);
            showNextProposal();
        },
        onInteraction: (i) => {
            const form = new QuestionForm(i.responseSchema);
            pendingQuestion = { interactionId: i.interactionId, form };
            printAbove(renderQuestionMenu(`${i.message}\n${form.prompt}`, form.choices));
            reprompt();
        },
        // The summary is rendered from the run's own done below.
        onTerminated: () => {},
    });

    // The running loop's elapsed time ticks in the status row.
    const statusTick = setInterval(() => { if (inFlight) reprompt(); }, 1_000);
    statusTick.unref();

    // Verbs + read-only subcommands call rpc.call(...) only; route that through the
    // live transport (WS, or the bridge's management plane over /plurnk/rpc). A
    // .call-only adapter — no verb/subcommand here subscribes, so the other Rpc
    // methods are never reached.
    const verbRpc = {
        call: async (method: string, params?: object): Promise<unknown> => {
            const result = method === "loop.cancel"
                ? await cancelLoop(String((params as { reason?: string } | undefined)?.reason ?? "user_stop"))
                : await transport.rpc(method, params);
            await settlePeeks();
            return result;
        },
    } as VerbCaller;

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
        switchWorkspace: async (name) => {
            surface.archiveActivity();
            const workspace = await transport.useSession(name, { projectRoot: opts.projectRoot, client: opts.client });
            conversationWorker = workspace.name;
            conversationWorkerId = null;
            seenLoopId = null;
            return workspace;
        },
        getWorker: () => conversationWorker,
        attachWorker: (name) => {
            surface.archiveActivity();
            transport.useWorker(name, current.name);
            conversationWorker = name;
            conversationWorkerId = null;
            seenLoopId = null;
            void refreshTopology().catch((cause: unknown) => { printAlert(renderTuiFailure(cause)); });
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
        look: async (rest) => {
            const fence = lookFence(rest);
            if (fence === null) { printAbove("  /look <address> [<scope>] [pattern]"); return; }
            await runLook(fence);
        },
        // /editor · Alt-e: place the edited multiline value back in the composer;
        // Enter remains the only submit gesture.
        composeInEditor: async () => {
            let edited: string | null = null;
            try {
                edited = await surface.handOff(() => editInEditor(surface.editor.getExpandedText(), ".md"));
            } catch (cause) {
                printAlert(renderTuiFailure(cause));
            }
            if (edited === null) return;
            surface.setInput(edited.replace(/\n$/, ""));
        },
    };

    const dispatchVerb = async (line: string): Promise<void> => {
        const { verb } = parseSlash(line);
        const rebinds = commandSpec(verb)?.rebinds === true;
        if (rebinds && (inFlight || pendingCommands > 0)) {
            printAbove("  The conversation stays attached until its run and submitted commands settle; /stop cancels the run.");
            return;
        }
        if (rebinding && !["help", "quit", "stop", ""].includes(verb)) {
            printAbove("  Changing conversation; retry this command after the new binding is confirmed.");
            return;
        }
        pendingCommands += 1;
        if (rebinds) rebinding = true;
        try {
            if (await handleVerb(line, verbCtx) === "quit") requestClose();
        } catch (cause) {
            printAlert(renderTuiFailure(cause));
        } finally {
            pendingCommands -= 1;
            if (rebinds) rebinding = false;
            reprompt();
        }
    };
    dispatchShortcut = (line) => { void dispatchVerb(line); };

    return new Promise<void>((resolve) => {
        let closed = false;
        const close = (): void => {
            if (closed) return;
            closed = true;
            shuttingDown = true;
            transport.shutdown();
            removeInputListener();
            surface.stop();
            process.stdout.write(`  ${paint(`resume this workspace:  ${resumeCommand(current.name, conversationWorker ?? workspace.name)}`, "dim")}\n`);
            resolve();
        };
        requestClose = close;

        const submit = async (line: string): Promise<void> => {
            if (line.trim().length > 0) {
                if (!inFlight) surface.archiveActivity();
                printSubmittedInput(printAbove, line);
            }
            const trimmed = line.trim();
            if (trimmed === "/cancel" && pendingQuestion !== null) {
                const question = pendingQuestion;
                await transport.resolveInteraction(question.interactionId, "cancel");
                if (pendingQuestion === question) pendingQuestion = null;
                reprompt();
                return;
            }
            if (trimmed.startsWith("/") && (pendingQuestion === null || isCommandName(parseSlash(trimmed).verb))) {
                await dispatchVerb(trimmed);
                return;
            }
            // Named fields consume input before prompt injection. No answer is
            // sent until the form is complete; invalid input stays visible here.
            if (pendingQuestion !== null) {
                const question = pendingQuestion;
                const { interactionId, form } = question;
                const answer = form.submit(trimmed.startsWith("\\/") ? trimmed.slice(1) : line);
                if (answer.kind !== "complete") {
                    if (answer.kind === "invalid") printAbove(ModelText.plain(answer.message));
                    printAbove(renderQuestionMenu(form.prompt, form.choices));
                    reprompt();
                    return;
                }
                await transport.resolveInteraction(interactionId, answer.content);
                if (pendingQuestion === question) pendingQuestion = null;
                reprompt();
                return;
            }
            if (trimmed.length === 0) {
                reprompt();
                return;
            }

            if (rebinding) {
                printAbove("  Changing conversation; submit after the new binding is confirmed.");
                return;
            }
            // A typed LOOK fence is inspection, not a run ({§cli-inspection}).
            const statementText = dslStatement(trimmed);
            const typedLook = statementText !== null ? lookStatement(statementText) : null;
            if (typedLook !== null) { inspect(typedLook); reprompt(); return; }

            if (statementText !== null || trimmed.startsWith("!")) {
                pendingCommands += 1;
                const start = Date.now();
                try {
                    const result = statementText !== null
                        ? (await transport.rpc("op.parse", { text: statementText }) as { results: OperationResult[] }).results.at(-1) ?? { status: 0 }
                        : await transport.rpc("op.exec", { command: trimmed.replace(/^!+\s*/, "") }) as OperationResult;
                    await settlePeeks();
                    printAbove(renderSummary(0, Date.now() - start, result, false));
                } finally {
                    pendingCommands -= 1;
                    reprompt();
                }
                return;
            }

            if (inFlight) {
                if (trimmed.startsWith("?") || (trimmed.startsWith(":") && reviewRequested)) {
                    printAbove("  Explicit review policy selects a new loop; use ... to steer this run, or /stop before starting another.");
                    return;
                }
                const admitted = transport.inject(linePolicy(trimmed, opts.loopPolicy).prompt).then((result) => {
                    if (result.action === "enqueued_new_loop") followAdmission = true;
                });
                pendingInjections.add(admitted);
                try {
                    await admitted;
                    printAbove(`  ${paint("↳ added to the run", "dim")}`);
                } finally {
                    pendingInjections.delete(admitted);
                    reprompt();
                }
                return;
            }

            inFlight = true;
            lifecycle = "running";
            authoritativeStatus = null;
            accrued = null;
            doing = null;
            // Keep a live steer prompt for the duration of the loop so traces can
            // print above an editable injection row.
            reprompt();
            let start = Date.now();
            runningSince = start;
            try {
                // `?` selects proposal review; `:` uses the base policy.
                const { policy, prompt: promptText } = linePolicy(trimmed, opts.loopPolicy);
                reviewRequested = trimmed.startsWith("?");
                // {§worker-model-selection} — no model selector rides the loop: the
                // worker owns the model; /model and /child persisted it server-side.
                const loopParams: { policy: LoopPolicyRequest; maxTurns?: number; openPaths?: string[] } = { policy };
                if (opts.maxTurns !== undefined) loopParams.maxTurns = opts.maxTurns;
                const openPaths = extractOpenPaths(promptText);   // @file refs → daemon turn-0 READs (#260)
                if (openPaths.length > 0) loopParams.openPaths = openPaths;
                // The transport owns the ack→terminated bridge; done resolves
                // with the loop's outcome. A pre-stream HTTP failure surfaces as
                // an exact ProblemError (caught below; 501 gets the .env pointer).
                activeRun = transport.run(promptText, loopParams);
                for (;;) {
                    const t = await activeRun.done;
                    reviewRequested = false;
                    if (t !== null) {
                        const turnCount = t.turnIds?.length ?? 0;
                        if (t.workerId !== undefined && t.workerId !== conversationWorkerId) {
                            conversationWorkerId = t.workerId;
                            const { workers } = await transport.rpc("workspace.workers") as { workers: Array<{ id: number; name: string }> };
                            const hit = workers.find((worker) => worker.id === conversationWorkerId);
                            if (hit === undefined) throw new Error(`worker ${conversationWorkerId} concluded a loop but workspace.workers does not list it`);
                            conversationWorker = hit.name;
                            workerPosition = siblingPosition(workers as WorkerRow[], conversationWorker);
                            placeWorkers = workers as WorkerRow[];
                            paintPrompt();
                        }
                        lifecycle = t.result.status === 202 ? "parked"
                            : t.result.status === 499 ? "cancelled"
                                : t.result.status >= 400 ? "failed"
                                    : "completed";
                        const wallMs = Date.now() - start;
                        // {plurnk#104} — the delivered answer lands in scrollback first; its summary follows it.
                        surface.archiveResponses();
                        printAbove(renderSummary(turnCount, wallMs, t.result, t.hitMaxTurns, t.usage));
                        tally = tallyOutcome(tally, { turns: turnCount, wallMs, usage: t.usage });
                        accrued = null;
                    }
                    // No asynchronous presentation work follows this admission barrier:
                    // another prompt must not sneak into the completion/idle gap.
                    while (pendingInjections.size > 0) await Promise.allSettled([...pendingInjections]);
                    if (!followAdmission || shuttingDown) break;
                    followAdmission = false;
                    start = Date.now();
                    runningSince = start;
                    activeRun = transport.observe();
                }
            } catch (cause) {
                lifecycle = "failed";
                printAlert(renderTuiFailure(cause));
            } finally {
                runningSince = null;
                inFlight = false;
                doing = null;
                activeRun = null;
                gesture.release();
                pendingQuestion = null;   // loop ended (incl. cancel) → drop any unanswered question
                reviewRequested = false;
                followAdmission = false;
                reprompt();
            }
        };

        surface.editor.onSubmit = (line) => {
            if (line.trim().length > 0) surface.editor.addToHistory(line);
            void submit(line).catch((cause) => {
                printAlert(renderTuiFailure(cause));
                reprompt();
            });
        };
        reprompt();
        surface.start();
    }).finally(() => {
        clearInterval(statusTick);
        releaseGuards();
        surface.stop();
    });
};
