// Unit tests for the TUI verb handlers (handleVerb), extracted from runTui so
// they're testable with a stubbed rpc — the npm equivalent of plurnk.nvim's
// spec 23. Verbs never call loop.run; they're run-tab furniture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleVerb, seedPromptHistory, buildHeader, isNewlineKey, expandNewlines, NL_MARK, altShortcut, lookStatement, cycleKey, cycleCoord, lineMode, renderTuiFailure, resolvedModelLabel, runTui, type VerbContext, type ResolvedModelSpec } from "./tui.ts";
import { clientRuntimeError, ProblemError } from "./diagnostics.ts";
import type { Transport } from "./transport.ts";

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
    };

    await assert.rejects(
        runTui(transport, { id: 1, name: "world" }, { yolo: false }),
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
    };

    await assert.rejects(
        runTui(transport, { id: 1, name: "world" }, { yolo: false }),
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

test("altShortcut: an unmapped Alt-letter → null (falls through to readline)", () => {
    assert.equal(altShortcut("\x1bz"), null);
});

test("altShortcut: a plain letter or an arrow-key sequence is NOT a shortcut", () => {
    assert.equal(altShortcut("m"), null);       // plain typing
    assert.equal(altShortcut("\x1b[A"), null);  // up-arrow (ESC [ A)
    assert.equal(altShortcut("\x1b"), null);    // bare ESC
});

// ─── lookStatement (recognition for op.look routing) ─────────────────────

test("lookStatement: preserves the exact heading", () => {
    assert.equal(lookStatement("## LOOK0 (worker:///plan.md)"), "## LOOK0 (worker:///plan.md)");
    assert.equal(lookStatement("## LOOK0 (log:///1/2/3)"), "## LOOK0 (log:///1/2/3)");
});

test("lookStatement: preserves signal, target, scope, and body", () => {
    assert.equal(lookStatement("## LOOK0 [2] (a.ts) <1,40>"), "## LOOK0 [2] (a.ts) <1,40>");
    assert.equal(lookStatement("## LOOK0 (users.json)\n$.name"), "## LOOK0 (users.json)\n$.name");
});

test("lookStatement: keeps suffix tolerance but not a second case grammar", () => {
    assert.equal(lookStatement("## LOOK_lane (a.md)"), "## LOOK_lane (a.md)");
    assert.equal(lookStatement("## look1 (a.md)"), null);
});

test("lookStatement: rejects non-LOOK operations; trailing word characters are a legal suffix", () => {
    assert.equal(lookStatement("## READ0 (a.md)"), null);
    assert.equal(lookStatement("## EDIT0 (a.md)\nx"), null);
    assert.equal(lookStatement("## LOOKUP (a.md)"), "## LOOKUP (a.md)");
    assert.equal(lookStatement("plain prompt"), null);
});

// ─── cycleKey (Alt-p/Alt-n → LOOK prior-op cycler) ───────────────────────
// Alt-<letter> survives the paste-filter pipeline intact; a Shift-Up CSI
// (ESC[1;2A) fragments and leaks to readline as history-prev (proven in pty).

test("cycleKey: Alt-p cycles prev/older (up), Alt-n next/newer (down)", () => {
    assert.equal(cycleKey("\x1bp"), "up");
    assert.equal(cycleKey("\x1bn"), "down");
});

test("cycleKey: a plain arrow or bare letter is NOT a cycle key", () => {
    assert.equal(cycleKey("\x1b[A"), null);     // plain up → readline history
    assert.equal(cycleKey("\x1b[1;2A"), null);  // Shift-Up CSI — deliberately not used (fragments)
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

// ─── expandNewlines (↵ marker → real newline on submit) ──────────────────

test("expandNewlines: each ↵ marker becomes a real newline", () => {
    assert.equal(expandNewlines(`a${NL_MARK}b${NL_MARK}c`), "a\nb\nc");
});

test("expandNewlines: a line with no marker is untouched", () => {
    assert.equal(expandNewlines("just one line"), "just one line");
});

test("expandNewlines: marker insertion is WYSIWYG — no spurious spaces around newlines", () => {
    // "line one " (trailing space) + soft-enter + "line two"
    assert.equal(expandNewlines(`line one ${NL_MARK}line two`), "line one \nline two");
});

// ─── isNewlineKey (non-submitting newline: Ctrl-J + Alt-Enter) ───────────

test("isNewlineKey: Ctrl-J (LF) is a non-submitting newline", () => {
    assert.equal(isNewlineKey("\n"), true);
});

test("isNewlineKey: Alt-Enter (Meta+CR / Meta+LF) is a non-submitting newline", () => {
    assert.equal(isNewlineKey("\x1b\r"), true);
    assert.equal(isNewlineKey("\x1b\n"), true);
});

test("isNewlineKey: plain Enter (CR) still submits — NOT a newline key", () => {
    assert.equal(isNewlineKey("\r"), false);
});

test("isNewlineKey: ordinary input and bare ESC are not newline keys", () => {
    for (const s of ["a", "hello", "\x1b", "\x1b[A", "\x1b[200~", " "]) {
        assert.equal(isNewlineKey(s), false, `${JSON.stringify(s)} must not trigger a newline`);
    }
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

interface Stub extends VerbContext { calls: Array<{ method: string; params?: unknown }>; out: string[]; imports: string[]; resolved: string[] }

const makeCtx = (results: Record<string, unknown> = {}, opts: Partial<VerbContext["opts"]> = {}): Stub => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const out: string[] = [];
    const imports: string[] = [];
    const resolved: string[] = [];
    let workspace = { id: 1, name: "sess" };
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
        switchWorkspace: async (name) => {
            calls.push({ method: "workspace.create", params: { name } });
            const r = results["workspace.create"];
            workspace = ((typeof r === "function" ? (r as (p: unknown) => unknown)({ name }) : r) ?? { id: 2, name: name ?? "new" }) as { id: number; name: string };
            return workspace;
        },
        write: (s) => { out.push(s); },
        importFile: async (p) => { imports.push(p); },
        resolveProposal: async (action) => { resolved.push(action); },
        calls, out, imports, resolved,
    };
};

// ─── membership verbs (svc#200) ──────────────────────────────────────

for (const verb of ["pick", "hide", "view"] as const) {
    test(`handleVerb /${verb} → workspace.constrain {effect:${verb}, glob}`, async () => {
        const ctx = makeCtx();
        await handleVerb(`/${verb} src/**`, ctx);
        assert.deepEqual(ctx.calls, [{ method: "workspace.constrain", params: { effect: verb, glob: "src/**" } }]);
        assert.match(ctx.out.join(""), new RegExp(`${verb}: src/\\*\\*`));
    });
    test(`handleVerb /${verb} with no glob → usage, no rpc`, async () => {
        const ctx = makeCtx();
        await handleVerb(`/${verb}`, ctx);
        assert.equal(ctx.calls.length, 0);
        assert.match(ctx.out.join(""), /usage:/);
    });
}

test("handleVerb /drop → lists then unconstrains the matching glob (any effect)", async () => {
    const ctx = makeCtx({ "workspace.constraints": { constraints: [{ effect: "hide", glob: "*.lock", source: "explicit" }, { effect: "pick", glob: "docs/**", source: "create" }] } });
    await handleVerb("/drop *.lock", ctx);
    assert.equal(ctx.calls[0].method, "workspace.constraints");
    const un = ctx.calls.find((c) => c.method === "workspace.unconstrain");
    assert.deepEqual(un?.params, { effect: "hide", glob: "*.lock" });
});

test("handleVerb /drop with no match → no unconstrain", async () => {
    const ctx = makeCtx({ "workspace.constraints": { constraints: [{ effect: "hide", glob: "*.lock" }] } });
    await handleVerb("/drop nope/**", ctx);
    assert.equal(ctx.calls.filter((c) => c.method === "workspace.unconstrain").length, 0);
    assert.match(ctx.out.join(""), /no constraint matching/);
});

test("handleVerb /members → reports the RESOLVED universe (workspace.members), not the rule globs", async () => {
    const ctx = makeCtx({
        "workspace.members": {
            members: [{ path: "/src/a.ts", effect: "member" }, { path: "/vendor/x.js", effect: "view" }],
            hidden: ["/secret.env"],
        },
        "workspace.constraints": { constraints: [{ effect: "view", glob: "vendor/**" }] },
    });
    await handleVerb("/members", ctx);
    // The universe comes from workspace.members — the daemon's resolution, not a client glob list.
    assert.equal(ctx.calls[0].method, "workspace.members");
    const o = ctx.out.join("");
    assert.match(o, /the model's universe: 2 files — 1 editable, 1 read-only, 1 hidden/);
    assert.match(o, /view\s+\/vendor\/x\.js/);   // read-only member, by resolved path
    assert.match(o, /member\s+\/src\/a\.ts/);    // editable member, by resolved path
    assert.match(o, /hidden\s+\/secret\.env/);   // excluded file surfaced honestly
    assert.match(o, /rules: view vendor\/\*\*/); // the rule footer (what /drop targets), distinct from the universe
});

test("handleVerb /members empty universe → says so, doesn't imply the rules ARE the universe", async () => {
    const ctx = makeCtx({
        "workspace.members": { members: [], hidden: [] },
        "workspace.constraints": { constraints: [] },
    });
    await handleVerb("/members", ctx);
    const o = ctx.out.join("");
    assert.match(o, /the model's universe is empty/);
    assert.match(o, /rules: none/);
});

test("handleVerb /members → suppresses the editable list past 40 but still states the true count", async () => {
    const members = Array.from({ length: 50 }, (_, i) => ({ path: `/f${i}.ts`, effect: "member" }));
    const ctx = makeCtx({ "workspace.members": { members, hidden: [] }, "workspace.constraints": { constraints: [] } });
    await handleVerb("/members", ctx);
    const o = ctx.out.join("");
    assert.match(o, /the model's universe: 50 files — 50 editable/);
    assert.match(o, /…50 editable files \(git-tracked\); listing suppressed/);
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
    await writeFile(file, "## EDIT0 (file://a.md)\nhi\n\n## READ0 (file://a.md)\n");
    const ctx = makeCtx({ "op.parse": { results: [{ status: 200 }, { status: 200 }] } });
    await handleVerb(`/script ${file}`, ctx);
    const parse = ctx.calls.find((c) => c.method === "op.parse");
    assert.ok(parse, "op.parse was called");
    assert.match((parse!.params as { text: string }).text, /## EDIT0 \(file:\/\/a\.md\)/);   // raw file text, unparsed by the client
    assert.match(ctx.out.join(""), /script: 2 ops ok/);
});

test("handleVerb /script surfaces the worst op status", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "plk-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const file = join(dir, "bad.plk");
    await writeFile(file, "## READ0 (file://gone.md)\n");
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

test("seedPromptHistory: seeds rl.history from workspace.prompts (newest-first)", async () => {
    const calls: Array<{ m: string; p?: unknown }> = [];
    const rpc = { call: async (m: string, p?: unknown) => { calls.push({ m, p }); return { prompts: ["latest", "older"] }; } } as unknown as VerbContext["rpc"];
    const rl = { history: [] as string[] };
    await seedPromptHistory(rpc, 7, rl as unknown as Parameters<typeof seedPromptHistory>[2]);
    assert.deepEqual(calls, [{ m: "workspace.prompts", p: { id: 7, limit: 100 } }]);
    assert.deepEqual(rl.history, ["latest", "older"]);
});

test("seedPromptHistory: empty / error → history untouched", async () => {
    const rl1 = { history: ["x"] };
    await seedPromptHistory({ call: async () => ({ prompts: [] }) } as unknown as VerbContext["rpc"], 1, rl1 as unknown as Parameters<typeof seedPromptHistory>[2]);
    assert.deepEqual(rl1.history, ["x"]);
    const rl2 = { history: ["x"] };
    await seedPromptHistory({ call: async () => { throw new Error("nope"); } } as unknown as VerbContext["rpc"], 1, rl2 as unknown as Parameters<typeof seedPromptHistory>[2]);
    assert.deepEqual(rl2.history, ["x"]);
});

// §2.0 — mode is a per-line prefix habit (converged with nvim's :AI ? / :AI :),
// never a --ask flag. THE ask chain the operator audited by hand (2026-07-11):
// `? ` must put mode:"ask" on the wire flags; this pins the client's half.
test("[§cli-prompt-prefixes-converged-with-plurnknvim-and-the-tui] lineMode: '? ' → flags.mode ask; ': ' → act; prefix stripped from the prompt", () => {
    assert.deepEqual(lineMode("? what is truth"), { flags: { mode: "ask" }, prompt: "what is truth" });
    assert.deepEqual(lineMode(": do the thing"), { flags: { mode: "act" }, prompt: "do the thing" });
});

test("lineMode: bare text carries the base flags untouched; prefix mode OVERRIDES the base", () => {
    assert.deepEqual(lineMode("hello", { auto: true }), { flags: { auto: true }, prompt: "hello" });
    assert.deepEqual(lineMode("? hello", { mode: "act", yolo: true }), { flags: { mode: "ask", yolo: true }, prompt: "hello" });
    assert.deepEqual(lineMode("plain"), { prompt: "plain" });
});

test("lineMode: '...' injection prefix strips without minting mode flags", () => {
    assert.deepEqual(lineMode("... btw also"), { prompt: "btw also" });
});
