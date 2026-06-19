// Unit tests for the TUI verb handlers (handleVerb), extracted from runTui so
// they're testable with a stubbed rpc — the npm equivalent of plurnk.nvim's
// spec 23. Verbs never call loop.run; they're run-tab furniture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { handleVerb, seedPromptHistory, buildHeader, isNewlineKey, type VerbContext } from "./tui.ts";

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

// ─── buildHeader (startup banner: version · session · model · help) ──────

test("buildHeader: shows the client's explicit --model/PLURNK_MODEL alias", () => {
    const h = buildHeader({ versionNotice: "plurnk client v1", sessionName: "sess", modelAlias: "opus", activeAlias: "haiku" });
    assert.equal(h, "plurnk client v1 · session: sess · model: opus · /help");
});

test("buildHeader: with no client model, names the daemon's active default", () => {
    const h = buildHeader({ sessionName: "sess", activeAlias: "haiku" });
    assert.match(h, /model: haiku/);
    assert.match(h, /^plurnk · session: sess ·/);  // version notice absent → "plurnk"
});

test("buildHeader: no client model and no resolvable active → honest fallback", () => {
    const h = buildHeader({ sessionName: "sess" });
    assert.match(h, /model: \(daemon default\)/);
});

interface Stub extends VerbContext { calls: Array<{ method: string; params?: unknown }>; out: string[]; imports: string[] }

const makeCtx = (results: Record<string, unknown> = {}, opts: Partial<VerbContext["opts"]> = {}): Stub => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const out: string[] = [];
    const imports: string[] = [];
    let session = { id: 1, name: "sess" };
    return {
        rpc: {
            call: async (method: string, params?: unknown) => {
                calls.push({ method, params });
                const r = results[method];
                return typeof r === "function" ? (r as (p: unknown) => unknown)(params) : (r ?? {});
            },
        } as unknown as VerbContext["rpc"],
        opts: { yolo: false, ...opts },
        getSession: () => session,
        setSession: (s) => { session = s; },
        write: (s) => { out.push(s); },
        importFile: async (p) => { imports.push(p); },
        calls, out, imports,
    };
};

// ─── membership verbs (svc#200) ──────────────────────────────────────

for (const verb of ["pick", "hide", "view", "repo"] as const) {
    test(`handleVerb /${verb} → session.constrain {effect:${verb}, glob}`, async () => {
        const ctx = makeCtx();
        await handleVerb(`/${verb} src/**`, ctx);
        assert.deepEqual(ctx.calls, [{ method: "session.constrain", params: { effect: verb, glob: "src/**" } }]);
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
    const ctx = makeCtx({ "session.constraints": { constraints: [{ effect: "hide", glob: "*.lock" }, { effect: "pick", glob: "docs/**" }] } });
    await handleVerb("/drop *.lock", ctx);
    assert.equal(ctx.calls[0].method, "session.constraints");
    const un = ctx.calls.find((c) => c.method === "session.unconstrain");
    assert.deepEqual(un?.params, { effect: "hide", glob: "*.lock" });
});

test("handleVerb /drop with no match → no unconstrain", async () => {
    const ctx = makeCtx({ "session.constraints": { constraints: [{ effect: "hide", glob: "*.lock" }] } });
    await handleVerb("/drop nope/**", ctx);
    assert.equal(ctx.calls.filter((c) => c.method === "session.unconstrain").length, 0);
    assert.match(ctx.out.join(""), /no constraint matching/);
});

test("handleVerb /members → reports the RESOLVED universe (session.members), not the rule globs", async () => {
    const ctx = makeCtx({
        "session.members": {
            members: [{ path: "/src/a.ts", effect: "member" }, { path: "/vendor/x.js", effect: "view" }],
            hidden: ["/secret.env"],
        },
        "session.constraints": { constraints: [{ effect: "view", glob: "vendor/**" }] },
    });
    await handleVerb("/members", ctx);
    // The universe comes from session.members — the daemon's resolution, not a client glob list.
    assert.equal(ctx.calls[0].method, "session.members");
    const o = ctx.out.join("");
    assert.match(o, /the model's universe: 2 files — 1 editable, 1 read-only, 1 hidden/);
    assert.match(o, /view\s+\/vendor\/x\.js/);   // read-only member, by resolved path
    assert.match(o, /member\s+\/src\/a\.ts/);    // editable member, by resolved path
    assert.match(o, /hidden\s+\/secret\.env/);   // excluded file surfaced honestly
    assert.match(o, /rules: view vendor\/\*\*/); // the rule footer (what /drop targets), distinct from the universe
});

test("handleVerb /members empty universe → says so, doesn't imply the rules ARE the universe", async () => {
    const ctx = makeCtx({
        "session.members": { members: [], hidden: [] },
        "session.constraints": { constraints: [] },
    });
    await handleVerb("/members", ctx);
    const o = ctx.out.join("");
    assert.match(o, /the model's universe is empty/);
    assert.match(o, /rules: none/);
});

test("handleVerb /members → suppresses the editable list past 40 but still states the true count", async () => {
    const members = Array.from({ length: 50 }, (_, i) => ({ path: `/f${i}.ts`, effect: "member" }));
    const ctx = makeCtx({ "session.members": { members, hidden: [] }, "session.constraints": { constraints: [] } });
    await handleVerb("/members", ctx);
    const o = ctx.out.join("");
    assert.match(o, /the model's universe: 50 files — 50 editable/);
    assert.match(o, /…50 editable files \(git-tracked\); listing suppressed/);
});

test("handleVerb /rename → session.rename, adopts the returned name", async () => {
    const ctx = makeCtx({ "session.rename": { id: 1, name: "renamed" } });
    await handleVerb("/rename renamed", ctx);
    assert.deepEqual(ctx.calls, [{ method: "session.rename", params: { name: "renamed" } }]);
    assert.equal(ctx.getSession().name, "renamed");
    assert.match(ctx.out.join(""), /session: renamed/);
});

test("handleVerb /rename with no name → usage, no rpc", async () => {
    const ctx = makeCtx();
    await handleVerb("/rename", ctx);
    assert.equal(ctx.calls.length, 0);
    assert.match(ctx.out.join(""), /usage: \/rename/);
});

test("handleVerb /fork [name] → run.fork then binds to the forked run", async () => {
    const ctx = makeCtx({
        "run.fork": { runId: 42, runName: "main-fork" },
        "session.attach": { id: 1, name: "sess", runId: 42, runName: "main-fork" },
    });
    await handleVerb("/fork branch-a", ctx);
    assert.deepEqual(ctx.calls[0], { method: "run.fork", params: { name: "branch-a" } });
    assert.deepEqual(ctx.calls[1], { method: "session.attach", params: { id: 1, runId: 42 } });
    assert.match(ctx.out.join(""), /forked → main-fork/);
});

test("handleVerb /fork with no name → run.fork with no name (auto <parent>-fork)", async () => {
    const ctx = makeCtx({
        "run.fork": { runId: 42, runName: "main-fork" },
        "session.attach": { id: 1, name: "sess", runId: 42, runName: "main-fork" },
    });
    await handleVerb("/fork", ctx);
    assert.deepEqual(ctx.calls[0], { method: "run.fork", params: {} });
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

test("handleVerb /model <alias> sets it; bare /model shows current", async () => {
    const ctx = makeCtx();
    await handleVerb("/model gpt", ctx);
    assert.equal(ctx.opts.modelAlias, "gpt");
    await handleVerb("/model", ctx);
    assert.match(ctx.out.join(""), /model: gpt/);
});

test("handleVerb /new → session.create + setSession", async () => {
    const ctx = makeCtx({ "session.create": { id: 9, name: "fresh" } });
    await handleVerb("/new fresh", ctx);
    assert.deepEqual(ctx.calls[0], { method: "session.create", params: { name: "fresh" } });
    assert.equal(ctx.getSession().name, "fresh");
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

// ─── seedPromptHistory (svc#238) ─────────────────────────────────────

test("seedPromptHistory: seeds rl.history from session.prompts (newest-first)", async () => {
    const calls: Array<{ m: string; p?: unknown }> = [];
    const rpc = { call: async (m: string, p?: unknown) => { calls.push({ m, p }); return { prompts: ["latest", "older"] }; } } as unknown as VerbContext["rpc"];
    const rl = { history: [] as string[] };
    await seedPromptHistory(rpc, 7, rl as unknown as Parameters<typeof seedPromptHistory>[2]);
    assert.deepEqual(calls, [{ m: "session.prompts", p: { id: 7, limit: 100 } }]);
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
