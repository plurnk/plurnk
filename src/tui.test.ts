// Unit tests for the TUI verb handlers (handleVerb), extracted from runTui so
// they're testable with a stubbed rpc — the npm equivalent of plurnk.nvim's
// spec 23. Verbs never call loop.run; they're run-tab furniture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleVerb, completeInput, seedPromptHistory, buildHeader, altShortcut, lookStatement, cycleKey, cycleCoord, linePolicy, renderSubmittedInput, renderTuiFailure, resolvedModelLabel, runTui, TUI_HELP, type VerbContext, type ResolvedModelSpec } from "./tui.ts";
import { clientRuntimeError, ProblemError } from "./diagnostics.ts";
import type { Transport } from "./transport.ts";

const REVIEW_POLICY = { capabilities: {}, proposals: "review" as const };

test("help is a compact grouped index over commands and interaction grammar", () => {
    assert.match(TUI_HELP, /inspect\s+\/help \/models/);
    assert.match(TUI_HELP, /functionality\s+\/mcp \/skills \/agents \/members/);
    assert.match(TUI_HELP, /language\s+## PLAN0/);
    assert.match(TUI_HELP, /\/help <verb>/);
});

test("handleVerb /help <verb> renders contextual registry usage without RPC", async () => {
    const ctx = makeCtx();
    await handleVerb("/help mcp", ctx);
    assert.deepEqual(ctx.calls, []);
    assert.match(ctx.out.join(""), /\/mcp discover <url\|command>/);
    assert.match(ctx.out.join(""), /\/mcp oauth <alias> <callback-url>/);
});

test("renderTuiFailure preserves exact Problem fields and recovery", () => {
    const problem = {
        ...clientRuntimeError("The action failed."),
        recovery: "Correct the action and retry.",
    };
    const out = renderTuiFailure(new ProblemError(problem));
    assert.match(out, /client:runtime:error/);
    assert.match(out, /The action failed\./);
    assert.match(out, /Correct the action and retry\./);
});

test("{§worker-model-selection}: TUI admission fails when durable model truth cannot be read", async () => {
    const calls: string[] = [];
    const transport: Transport = {
        rpc: async <T>(method: string): Promise<T> => {
            calls.push(method);
            if (method === "providers.list") return { aliases: [] } as T;
            if (method === "worker.model.get") throw new Error("model control plane unavailable");
            throw new Error(`unexpected RPC ${method}`);
        },
        subscribe: () => { throw new Error("the TUI subscribed after failed admission"); },
        run: () => { throw new Error("the TUI ran a model after failed admission"); },
        inject: async () => { throw new Error("the TUI injected after failed admission"); },
        resolve: async () => { throw new Error("the TUI resolved after failed admission"); },
        resolveInteraction: async () => { throw new Error("the TUI resolved an interaction after failed admission"); },
        onClose: () => {},
        shutdown: () => {},
        useSession: async () => { throw new Error("the TUI switched workspaces after failed admission"); },
        useWorker: () => {},
    };

    await assert.rejects(
        runTui(transport, { id: 1, name: "world" }, { yolo: false, loopPolicy: REVIEW_POLICY }),
        /model control plane unavailable/,
    );
    assert.deepEqual(calls, ["providers.list", "worker.model.get"]);
});

test("{§worker-model-selection}: TUI admission rejects a malformed durable model projection", async () => {
    const transport: Transport = {
        rpc: async <T>(method: string): Promise<T> => (method === "providers.list"
            ? { aliases: [] }
            : { model: { provider: "openai" }, spawnModel: null }) as T,
        subscribe: () => { throw new Error("the TUI subscribed after failed admission"); },
        run: () => { throw new Error("the TUI ran a model after failed admission"); },
        inject: async () => { throw new Error("the TUI injected after failed admission"); },
        resolve: async () => { throw new Error("the TUI resolved after failed admission"); },
        resolveInteraction: async () => { throw new Error("the TUI resolved an interaction after failed admission"); },
        onClose: () => {},
        shutdown: () => {},
        useSession: async () => { throw new Error("the TUI switched workspaces after failed admission"); },
        useWorker: () => {},
    };

    await assert.rejects(
        runTui(transport, { id: 1, name: "world" }, { yolo: false, loopPolicy: REVIEW_POLICY }),
        /invalid ModelRoute/,
    );
});

// ─── altShortcut (Alt-<letter> quick-keys, nvim muscle-memory convergence) ──

test("altShortcut: lowercase mnemonics map (nvim's lowercase: m, s, x)", () => {
    assert.equal(altShortcut("\x1bm"), "/models");
    assert.equal(altShortcut("\x1bs"), "/workspaces");
    assert.equal(altShortcut("\x1bx"), "/stop");
});

test("altShortcut: CASE matches nvim — capitals are distinct (R/L/Y/N/M)", () => {
    assert.equal(altShortcut("\x1bR"), "/workers");   // nvim <leader>aR
    assert.equal(altShortcut("\x1bM"), "/members");   // nvim <leader>aM
    assert.equal(altShortcut("\x1bY"), "/yolo");      // nvim <leader>aY
    // lowercase of a capital-mnemonic is NOT mapped — case is significant.
    assert.equal(altShortcut("\x1br"), null);
});

test("altShortcut: an unmapped Alt-letter → null (falls through to the editor)", () => {
    assert.equal(altShortcut("\x1bz"), null);
});

test("altShortcut: a plain letter or an arrow-key sequence is NOT a shortcut", () => {
    assert.equal(altShortcut("m"), null);       // plain typing
    assert.equal(altShortcut("\x1b[A"), null);  // up-arrow (ESC [ A)
    assert.equal(altShortcut("\x1b"), null);    // bare ESC
});

// ─── lookStatement (recognition for op.look routing) ─────────────────────

test("lookStatement: preserves the exact heading", () => {
    assert.equal(lookStatement("### LOOK0 (worker:///plan.md)"), "### LOOK0 (worker:///plan.md)");
    assert.equal(lookStatement("### LOOK0 (log:///1/2/3)"), "### LOOK0 (log:///1/2/3)");
});

test("lookStatement: preserves signal, target, scope, and body", () => {
    assert.equal(lookStatement("### LOOK0 [2] (a.ts) <1,40>"), "### LOOK0 [2] (a.ts) <1,40>");
    assert.equal(lookStatement("### LOOK0 (users.json)\n$.name"), "### LOOK0 (users.json)\n$.name");
});

test("lookStatement: keeps suffix tolerance but not a second case grammar", () => {
    assert.equal(lookStatement("### LOOK_lane (a.md)"), "### LOOK_lane (a.md)");
    assert.equal(lookStatement("## look1 (a.md)"), null);
});

test("lookStatement: rejects non-LOOK operations; trailing word characters are a legal suffix", () => {
    assert.equal(lookStatement("### READ0 (a.md)"), null);
    assert.equal(lookStatement("### EDIT0 (a.md)\nx"), null);
    assert.equal(lookStatement("### LOOKUP (a.md)"), "### LOOKUP (a.md)");
    assert.equal(lookStatement("plain prompt"), null);
});

// ─── cycleKey (Alt-p/Alt-n → LOOK prior-op cycler) ───────────────────────
// pi-tui's terminal buffer delivers each normalized key sequence intact.

test("cycleKey: Alt-p cycles prev/older (up), Alt-n next/newer (down)", () => {
    assert.equal(cycleKey("\x1bp"), "up");
    assert.equal(cycleKey("\x1bn"), "down");
});

test("cycleKey: a plain arrow or bare letter is NOT a cycle key", () => {
    assert.equal(cycleKey("\x1b[A"), null);     // plain up → editor navigation/history
    assert.equal(cycleKey("\x1b[1;2A"), null);  // Shift-Up CSI belongs to the editor
    assert.equal(cycleKey("p"), null);          // plain typing
    assert.equal(cycleKey("\x1bm"), null);      // an Alt verb shortcut, not a cycle key
});

// ─── cycleCoord (pure cursor math for the LOOK cycler) ───────────────────

test("cycleCoord: first 'up' starts at the newest coordinate", () => {
    assert.equal(cycleCoord(3, null, "up"), 2);
});

test("cycleCoord: 'up' walks toward older and clamps at the oldest", () => {
    assert.equal(cycleCoord(3, 2, "up"), 1);
    assert.equal(cycleCoord(3, 1, "up"), 0);
    assert.equal(cycleCoord(3, 0, "up"), 0);   // clamp
});

test("cycleCoord: 'down' walks toward newer and clamps at the newest", () => {
    assert.equal(cycleCoord(3, 0, "down"), 1);
    assert.equal(cycleCoord(3, 2, "down"), 2);   // clamp
});

test("cycleCoord: 'down' with no prior cycle is a no-op (null)", () => {
    assert.equal(cycleCoord(3, null, "down"), null);
});

test("cycleCoord: nothing seen yet → null (nothing to cycle)", () => {
    assert.equal(cycleCoord(0, null, "up"), null);
});

// ─── buildHeader (startup banner: version · workspace · model · help) ──────

test("buildHeader: shows the client's explicit --model selector", () => {
    const h = buildHeader({ versionNotice: "plurnk client v1", workspaceName: "sess", modelSelector: "openrouter/anthropic/claude-opus", activeAlias: "haiku" });
    assert.equal(h, "plurnk client v1 · workspace: sess · model: openrouter/anthropic/claude-opus · /help");
});

test("buildHeader: with no client model, names the daemon's active default", () => {
    const h = buildHeader({ workspaceName: "sess", activeAlias: "haiku" });
    assert.match(h, /model: haiku/);
    assert.match(h, /^plurnk · workspace: sess ·/);  // version notice absent → "plurnk"
});

test("buildHeader: no client model and no resolvable active → honest fallback", () => {
    const h = buildHeader({ workspaceName: "sess" });
    assert.match(h, /model: \(daemon default\)/);
});

test("buildHeader: yolo on → shows 'yolo: on'; off/unset → no yolo segment", () => {
    assert.match(buildHeader({ workspaceName: "sess", yolo: true }), /· yolo: on ·/);
    assert.doesNotMatch(buildHeader({ workspaceName: "sess", yolo: false }), /yolo/);
    assert.doesNotMatch(buildHeader({ workspaceName: "sess" }), /yolo/);
});

test("buildHeader: workerName present → shown between workspace and model; absent → omitted", () => {
    assert.equal(
        buildHeader({ workspaceName: "plurnk", workerName: "meta", activeAlias: "jennifer" }),
        "plurnk · workspace: plurnk · worker: meta · model: jennifer · /help",
    );
    assert.doesNotMatch(buildHeader({ workspaceName: "plurnk" }), /worker/);
});

test("buildHeader: reasoning is a distinct durable policy label", () => {
    assert.match(
        buildHeader({ workspaceName: "plurnk", activeAlias: "grok", reasoningPolicy: "adaptive" }),
        /· model: grok · reasoning: adaptive ·/,
    );
    assert.doesNotMatch(buildHeader({ workspaceName: "plurnk", activeAlias: "grok" }), /reasoning:/);
});

interface Stub extends VerbContext { calls: Array<{ method: string; params?: unknown }>; out: string[]; imports: string[]; resolved: string[]; composed: boolean[]; attached: string[] }

const makeCtx = (results: Record<string, unknown> = {}, opts: Partial<VerbContext["opts"]> = {}): Stub => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const out: string[] = [];
    const imports: string[] = [];
    const resolved: string[] = [];
    const composed: boolean[] = [];
    let workspace = { id: 1, name: "sess" };
    let worker: string | null = "sess";
    const attached: string[] = [];
    const modelState = {
        model: null as ResolvedModelSpec | null,
        spawnModel: null as ResolvedModelSpec | null,
        reasoning: { policy: null, supportedPolicies: [] } as VerbContext["reasoning"],
    };
    const defaults: Record<string, unknown> = {
        "worker.model.get": { model: null, spawnModel: null },
        "worker.reasoning.get": { policy: null, supportedPolicies: [] },
    };
    return {
        rpc: {
            call: async (method: string, params?: unknown) => {
                calls.push({ method, params });
                const r = Object.hasOwn(results, method) ? results[method] : defaults[method];
                return typeof r === "function" ? (r as (p: unknown) => unknown)(params) : (r ?? {});
            },
        } as unknown as VerbContext["rpc"],
        opts: { yolo: false, ...opts },
        get model() { return modelState.model; },
        get spawnModel() { return modelState.spawnModel; },
        get reasoning() { return modelState.reasoning; },
        setModel: (spec) => { modelState.model = spec; },
        setSpawnModel: (spec) => { modelState.spawnModel = spec; },
        setReasoning: (reasoning) => { modelState.reasoning = reasoning; },
        getWorkspace: () => workspace,
        setWorkspace: (s) => { workspace = s; },
        getWorker: () => worker,
        attachWorker: (name) => { attached.push(name); worker = name; },
        switchWorkspace: async (name) => {
            calls.push({ method: "workspace.create", params: { name } });
            const r = results["workspace.create"];
            workspace = ((typeof r === "function" ? (r as (p: unknown) => unknown)({ name }) : r) ?? { id: 2, name: name ?? "new" }) as { id: number; name: string };
            return workspace;
        },
        write: (s) => { out.push(s); },
        importFile: async (p) => { imports.push(p); },
        resolveProposal: async (action) => { resolved.push(action); },
        composeInEditor: async () => { composed.push(true); },
        calls, out, imports, resolved, composed, attached,
    };
};

// ─── /attach (bind or mint a conversation worker by name) ─────────────
test("[§cli-workers-topology] handleVerb /attach <known> rebinds the thread and reports the bound worker", async () => {
    const ctx = makeCtx({ "workspace.workers": { workers: [{ id: 1, name: "sess" }, { id: 2, name: "sess-fork" }] } });
    await handleVerb("/attach sess-fork", ctx);
    assert.deepEqual(ctx.attached, ["sess-fork"]);
    assert.deepEqual(ctx.calls[0], { method: "workspace.workers", params: { id: 1 } });
    assert.ok(ctx.calls.some((c) => c.method === "worker.model.get"), "policy is re-read for the newly bound worker");
    assert.equal(ctx.out.join(""), "  worker: sess-fork (bound)\n");
});

test("[§cli-workers-topology] handleVerb /attach <new> rebinds and reports a fresh conversation", async () => {
    const ctx = makeCtx({ "workspace.workers": { workers: [{ id: 1, name: "sess" }] } });
    await handleVerb("/attach recheck", ctx);
    assert.deepEqual(ctx.attached, ["recheck"]);
    assert.equal(ctx.out.join(""), "  worker: recheck (new)\n");
});

test("handleVerb /attach without a name prints usage and binds nothing", async () => {
    const ctx = makeCtx();
    await handleVerb("/attach", ctx);
    assert.deepEqual(ctx.attached, []);
    assert.equal(ctx.out.join(""), "  usage: /attach <name>\n");
});

// ─── /members (file members Functionality family through AG-UI+) ─────

test("[§cli-file-members] handleVerb /members lists this worker's file members", async () => {
    const ctx = makeCtx({
        "worker.members.list": {
            definitions: [
                { alias: "docs", origin: "service", state: "active", definition: { glob: "docs/**" }, detail: { effect: "include", pattern: "docs/**", matched: 12, files: [], ignored: 3 } },
                { alias: "no-tokenizer", origin: "worker", state: "disabled", definition: { glob: "!**/tokenizer.json" } },
            ],
        },
    });
    await handleVerb("/members", ctx);
    await handleVerb("/members", ctx);
    assert.deepEqual(ctx.calls, [{ method: "worker.members.list", params: {} }, { method: "worker.members.list", params: {} }]);
    assert.match(ctx.out.join(""), /docs\s+service\s+active\s+include docs\/\*\* → 12 files \(3 ignored\)/);
    assert.match(ctx.out.join(""), /no-tokenizer\s+worker\s+disabled\s+exclude \*\*\/tokenizer\.json/);
});

test("[§cli-file-members] handleVerb /members add posts one exact { glob } definition", async () => {
    const ctx = makeCtx({ "worker.members.add": { status: 201, alias: "no-tokenizer", definition: { alias: "no-tokenizer", state: "active" } } });
    await handleVerb("/members add no-tokenizer !**/tokenizer.json", ctx);
    assert.deepEqual(ctx.calls, [{ method: "worker.members.add", params: { alias: "no-tokenizer", definition: { glob: "!**/tokenizer.json" } } }]);
    assert.match(ctx.out.join(""), /added: no-tokenizer \(active\)/);
});

test("handleVerb /rename → workspace.rename, adopts the returned name", async () => {
    const ctx = makeCtx({ "workspace.rename": { id: 1, name: "renamed" } });
    await handleVerb("/rename renamed", ctx);
    assert.deepEqual(ctx.calls, [{ method: "workspace.rename", params: { name: "renamed" } }]);
    assert.equal(ctx.getWorkspace().name, "renamed");
    assert.match(ctx.out.join(""), /workspace: renamed/);
});

test("handleVerb /rename with no name → usage, no rpc", async () => {
    const ctx = makeCtx();
    await handleVerb("/rename", ctx);
    assert.equal(ctx.calls.length, 0);
    assert.match(ctx.out.join(""), /usage: \/rename/);
});

test("handleVerb /worker [name] → run.fork (new worker) then binds to it", async () => {
    const ctx = makeCtx({
        "run.fork": { workerId: 42, workerName: "main-fork" },
        "workspace.attach": { id: 1, name: "sess", workerId: 42, workerName: "main-fork" },
    });
    await handleVerb("/worker branch-a", ctx);
    assert.deepEqual(ctx.calls[0], { method: "run.fork", params: { name: "branch-a" } });
    assert.deepEqual(ctx.calls[1], { method: "workspace.attach", params: { id: 1, workerId: 42 } });
    assert.match(ctx.out.join(""), /worker: main-fork \(new\)/);
});

test("handleVerb /worker with no name → run.fork with no name (auto <parent>-fork)", async () => {
    const ctx = makeCtx({
        "run.fork": { workerId: 42, workerName: "main-fork" },
        "workspace.attach": { id: 1, name: "sess", workerId: 42, workerName: "main-fork" },
    });
    await handleVerb("/worker", ctx);
    assert.deepEqual(ctx.calls[0], { method: "run.fork", params: {} });
});

test("[§cli-proposal-review][§cli-review-menu-interactive] handleVerb /accept /reject /cancel /edit → resolveProposal(action) — typed no-modifier fallback", async () => {
    for (const action of ["accept", "reject", "cancel", "edit"] as const) {
        const ctx = makeCtx();
        await handleVerb(`/${action}`, ctx);
        assert.deepEqual(ctx.resolved, [action], `/${action} resolves the pending proposal`);
        assert.equal(ctx.calls.length, 0, "the verb never touches the wire directly");
    }
});

// ─── state verbs ─────────────────────────────────────────────────────

test("handleVerb /yolo → toggles opts.yolo and reports", async () => {
    const ctx = makeCtx({}, { yolo: false });
    await handleVerb("/yolo", ctx);
    assert.equal(ctx.opts.yolo, true);
    assert.match(ctx.out.join(""), /yolo: ON/);
    await handleVerb("/yolo", ctx);
    assert.equal(ctx.opts.yolo, false);
});

test("{§worker-model-selection}: handleVerb /model sets server-side and mirrors the resolved spec; bare /model shows it", async () => {
    const ctx = makeCtx({
        "worker.model.set": { alias: "gpt", provider: "openai", model: "gpt-4" },
        "worker.reasoning.get": { policy: "adaptive", supportedPolicies: ["off", "adaptive", "high"] },
    });
    await handleVerb("/model gpt", ctx);
    assert.deepEqual(ctx.calls[0], { method: "worker.model.set", params: { selector: "gpt" } });
    assert.deepEqual(ctx.calls[1], { method: "worker.reasoning.get", params: undefined });
    assert.deepEqual(ctx.model, { alias: "gpt", provider: "openai", model: "gpt-4" }, "the server-resolved spec is the display truth");
    assert.deepEqual(ctx.reasoning.supportedPolicies, ["off", "adaptive", "high"], "model changes refresh daemon-supported reasoning completion");
    await handleVerb("/model", ctx);
    assert.match(ctx.out.join(""), /model: gpt/);
});

test("{§worker-model-selection}: an exact route remains alias-free in control and display", async () => {
    const route = { provider: "google", model: "gemini-3-flash" };
    const ctx = makeCtx({
        "worker.model.set": route,
        "worker.reasoning.get": { policy: "adaptive", supportedPolicies: ["off", "adaptive", "high"] },
    });
    await handleVerb("/model google/gemini-3-flash", ctx);
    assert.deepEqual(ctx.calls[0], {
        method: "worker.model.set",
        params: { selector: "google/gemini-3-flash" },
    });
    assert.deepEqual(ctx.model, route);
    assert.equal(resolvedModelLabel(ctx.model as ResolvedModelSpec), "google/gemini-3-flash");
    await handleVerb("/model", ctx);
    assert.match(ctx.out.join(""), /model: google\/gemini-3-flash/);
});

test("handleVerb /reasoning inspects and sets durable daemon policy", async () => {
    const ctx = makeCtx({
        "worker.reasoning.get": { policy: "adaptive", supportedPolicies: ["off", "adaptive", "high"] },
        "worker.reasoning.set": { policy: "high", supportedPolicies: ["off", "adaptive", "high"] },
    });
    await handleVerb("/reasoning", ctx);
    await handleVerb("/reasoning high", ctx);
    assert.deepEqual(ctx.calls, [
        { method: "worker.reasoning.get", params: undefined },
        { method: "worker.reasoning.set", params: { policy: "high" } },
    ]);
    assert.equal(ctx.reasoning.policy, "high");
    assert.match(ctx.out.join(""), /reasoning: adaptive/);
    assert.match(ctx.out.join(""), /reasoning: high/);
    assert.match(ctx.out.join(""), /supported: off, adaptive, high/);
});

test("handleVerb /reasoning preserves a daemon rejection", async () => {
    const ctx = makeCtx({
        "worker.reasoning.set": () => { throw new Error("Reasoning policy 'medium' is not supported by xai/grok-4.6."); },
    });
    await handleVerb("/reasoning medium", ctx);
    assert.equal(ctx.reasoning.policy, null);
    assert.match(ctx.out.join(""), /Reasoning policy 'medium' is not supported/);
});

test("[§cli-child-provider-selection]{§worker-model-selection}: handleVerb /child persists the override and inherit clears it", async () => {
    const ctx = makeCtx({
        "worker.child.set": (p: unknown) => (p as { selector: string | null }).selector === null
            ? null
            : { alias: "fireslow", provider: "fireworks", model: "deepseek" },
    });
    await handleVerb("/child fireslow", ctx);
    assert.deepEqual(ctx.calls[0], { method: "worker.child.set", params: { selector: "fireslow" } });
    assert.equal(ctx.spawnModel?.alias, "fireslow");
    await handleVerb("/child", ctx);
    assert.match(ctx.out.join(""), /child: fireslow/);
    await handleVerb("/child inherit", ctx);
    assert.deepEqual(ctx.calls[1], { method: "worker.child.set", params: { selector: null } });
    assert.equal(ctx.spawnModel, null);
    assert.match(ctx.out.join(""), /child: inherit/);
});

test("{§worker-model-selection}: a failed /model surfaces the server's rejection", async () => {
    const ctx = makeCtx({ "worker.model.set": () => { throw new Error("No provider is configured for this worker."); } });
    await handleVerb("/model mystery", ctx);
    assert.equal(ctx.model, null, "the failed set changes nothing client-side");
    assert.match(ctx.out.join(""), /model set failed: No provider is configured/);
});

test("{§worker-model-selection}: /model rejects a malformed route projection", async () => {
    const ctx = makeCtx({ "worker.model.set": { provider: "openai" } });
    await handleVerb("/model broken", ctx);
    assert.equal(ctx.model, null);
    assert.match(ctx.out.join(""), /model set failed: invalid ModelRoute/);
});

test("handleVerb /workspace → workspace.create (new) + setWorkspace", async () => {
    const ctx = makeCtx({
        "workspace.create": { id: 9, name: "fresh" },
        "worker.model.get": { model: { alias: "new-model", provider: "openai", model: "new" }, spawnModel: null },
        "worker.reasoning.get": { policy: "adaptive", supportedPolicies: ["off", "adaptive", "high"] },
    });
    await handleVerb("/workspace fresh", ctx);
    assert.deepEqual(ctx.calls[0], { method: "workspace.create", params: { name: "fresh" } });
    assert.equal(ctx.getWorkspace().name, "fresh");
    assert.equal(ctx.model?.alias, "new-model");
    assert.equal(ctx.reasoning.policy, "adaptive");
    assert.match(ctx.out.join(""), /workspace: fresh \(new\)/);
});

test("handleVerb /editor → composeInEditor; Alt-e maps to it (plurnk#26)", async () => {
    const ctx = makeCtx();
    await handleVerb("/editor", ctx as unknown as VerbContext);
    assert.deepEqual(ctx.composed, [true], "/editor invokes the $EDITOR composition hook");
    assert.equal(altShortcut("\x1be"), "/editor");
});

test("handleVerb /stop → loop.cancel", async () => {
    const ctx = makeCtx();
    await handleVerb("/stop", ctx);
    assert.deepEqual(ctx.calls, [{ method: "loop.cancel", params: { reason: "user_stop" } }]);
});

test("handleVerb /quit → returns 'quit'", async () => {
    assert.equal(await handleVerb("/quit", makeCtx()), "quit");
});

test("handleVerb unknown verb → no rpc (reports unknown)", async () => {
    const ctx = makeCtx();
    await handleVerb("/bogus", ctx);
    assert.equal(ctx.calls.length, 0);
});

// ─── /import ─────────────────────────────────────────────────────────

test("handleVerb /import <path> → delegates to importFile", async () => {
    const ctx = makeCtx();
    await handleVerb("/import notes.md", ctx);
    assert.deepEqual(ctx.imports, ["notes.md"]);
    assert.equal(ctx.calls.length, 0);
});

test("handleVerb /import with no path → usage, no importFile", async () => {
    const ctx = makeCtx();
    await handleVerb("/import", ctx);
    assert.equal(ctx.imports.length, 0);
    assert.match(ctx.out.join(""), /usage: \/import/);
});

// ─── /script (run a .plk file → op.parse) ────────────────────────────

test("handleVerb /script <path> → reads the file, ships its DSL to op.parse, summarizes", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "plk-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "go.plk");
    await writeFile(file, "### EDIT0 (file://a.md)\nhi\n\n### READ0 (file://a.md)\n");
    const ctx = makeCtx({ "op.parse": { results: [{ status: 200 }, { status: 200 }] } });
    await handleVerb(`/script ${file}`, ctx);
    const parse = ctx.calls.find((c) => c.method === "op.parse");
    assert.ok(parse, "op.parse was called");
    assert.match((parse!.params as { text: string }).text, /### EDIT0 \(file:\/\/a\.md\)/);   // raw file text, unparsed by the client
    assert.match(ctx.out.join(""), /script: 2 ops ok/);
});

test("handleVerb /script surfaces the worst op status", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "plk-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "bad.plk");
    await writeFile(file, "### READ0 (file://gone.md)\n");
    const ctx = makeCtx({ "op.parse": { results: [{ status: 404 }] } });
    await handleVerb(`/script ${file}`, ctx);
    assert.match(ctx.out.join(""), /script: 1 op, worst status 404/);
});

test("handleVerb /script with no path → usage, no op.parse", async () => {
    const ctx = makeCtx();
    await handleVerb("/script", ctx);
    assert.equal(ctx.calls.length, 0);
    assert.match(ctx.out.join(""), /usage: \/script/);
});

test("handleVerb /script on a missing file → throws (fail-hard, surfaced by the caller)", async () => {
    const ctx = makeCtx({ "op.parse": { results: [] } });
    await assert.rejects(handleVerb("/script /no/such/file.plk", ctx));
    assert.equal(ctx.calls.length, 0);   // never reaches op.parse
});

// ─── /mcp (workspace MCP lifecycle through AG-UI+) ───────────────────

test("[§cli-workspace-mcp-controls] handleVerb /mcp lists workspace servers", async () => {
    const ctx = makeCtx({
        "worker.mcp.list": {
            definitions: [
                { alias: "gitea", origin: "worker", state: "active", definition: { name: "gitea", transport: "http", url: "https://gitea.test/mcp", tools: ["issue_read"] }, detail: { tools: ["issue_read", "issue_search"] } },
                { alias: "local", origin: "service", state: "disabled", definition: { name: "local", transport: "stdio", command: "local-mcp", args: [] }, detail: { tools: [] } },
            ],
        },
    });
    await handleVerb("/mcp", ctx);
    assert.deepEqual(ctx.calls, [{ method: "worker.mcp.list", params: {} }]);
    assert.match(ctx.out.join(""), /gitea\s+active\s+http\s+https:\/\/gitea\.test\/mcp\s+1\/2 tools/);
    assert.match(ctx.out.join(""), /local\s+disabled\s+stdio\s+local-mcp\s+0 tools\s+\(service\)/);
});

// ─── seedPromptHistory (svc#238) ─────────────────────────────────────

test("seedPromptHistory delegates newest-first workspace prompts to the editor surface", async () => {
    const calls: Array<{ m: string; p?: unknown }> = [];
    const rpc = { call: async (m: string, p?: unknown) => { calls.push({ m, p }); return { prompts: ["latest", "older"] }; } } as unknown as VerbContext["rpc"];
    const received: string[][] = [];
    const history = { addHistory: (prompts: readonly string[]) => received.push([...prompts]) };
    await seedPromptHistory(rpc, 7, history);
    assert.deepEqual(calls, [{ m: "workspace.prompts", p: { id: 7, limit: 100 } }]);
    assert.deepEqual(received, [["latest", "older"]]);
});

test("seedPromptHistory: empty / error → history untouched", async () => {
    let calls = 0;
    const history = { addHistory: () => { calls += 1; } };
    await seedPromptHistory({ call: async () => ({ prompts: [] }) } as unknown as VerbContext["rpc"], 1, history);
    await seedPromptHistory({ call: async () => { throw new Error("nope"); } } as unknown as VerbContext["rpc"], 1, history);
    assert.equal(calls, 0);
});

test("[§cli-prompt-prefixes-converged-with-plurnknvim-and-the-tui] linePolicy: '?' attenuates EXEC; ':' preserves ordinary policy", () => {
    assert.deepEqual(linePolicy("? what is truth"), {
        policy: { capabilities: { deny: [{ operation: "EXEC" }] }, proposals: "review" },
        prompt: "what is truth",
    });
    assert.deepEqual(linePolicy(": do the thing"), {
        policy: { capabilities: {}, proposals: "review" },
        prompt: "do the thing",
    });
});

test("linePolicy: '?' intersects the base policy and selects review", () => {
    const base = { capabilities: { deny: [{ traits: ["web"] as [string] }] }, proposals: "accept" as const };
    assert.deepEqual(linePolicy("hello", base), { policy: base, prompt: "hello" });
    assert.deepEqual(linePolicy("? hello", base), {
        policy: {
            capabilities: { deny: [{ operation: "EXEC" }, { traits: ["web"] }] },
            proposals: "review",
        },
        prompt: "hello",
    });
});

test("linePolicy: '...' strips without altering the base policy", () => {
    assert.deepEqual(linePolicy("... btw also"), {
        policy: { capabilities: {}, proposals: "review" },
        prompt: "btw also",
    });
});

test("submitted multiline input becomes durable scrollback without the retired identity glyph", () => {
    assert.equal(renderSubmittedInput("first\nsecond", true), "🔥 first\n  second");
    assert.equal(renderSubmittedInput("first", false), "› first");
});

// ─── completion (/model provider-scoped catalog completion, plurnk#22) ───

test("[§cli-plurnk-models] /model completion: aliases synchronously, provider prefixes lazily from one bounded catalog page", async () => {
    const fetched: string[] = [];
    const complete = async (line: string): Promise<[string[], string]> => {
        const result = await completeInput(line, {
            getAliases: () => ["fast", "smart"],
            cwd: process.cwd(),
            getReasoningPolicies: () => [],
            getProviderModels: async (provider) => {
                fetched.push(provider);
                if (provider === "down") throw new Error("catalog unavailable");
                return [`${provider}/gpt-5`, `${provider}/gpt-5-mini`, `${provider}/o4`];
            },
        });
        return [result.suggestions.map(({ value }) => value), result.prefix];
    };
    assert.deepEqual(await complete("/model fa"), [["fast"], "fa"], "a bare fragment completes declared aliases only");
    assert.deepEqual(fetched, [], "alias completion never touches the catalog");
    assert.deepEqual(await complete("/model openai/gpt"), [["openai/gpt-5", "openai/gpt-5-mini"], "openai/gpt"], "a provider prefix completes provider-scoped selectors");
    assert.deepEqual(fetched, ["openai"], "the catalog is consulted lazily, per provider");
    assert.deepEqual(await complete("/model down/x"), [[], "down/x"], "a failed catalog fetch completes nothing rather than erroring the prompt");
    assert.deepEqual(await complete("/child inh"), [["inherit"], "inh"], "child completion keeps its inherit sentinel");
});
