// Unit tests for the TUI verb handlers (handleVerb), extracted from runTui so
// they're testable with a stubbed rpc — the npm equivalent of plurnk.nvim's
// spec 23. Verbs never call loop.run; they're run-tab furniture.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleVerb, seedPromptHistory, buildHeader, isNewlineKey, expandNewlines, NL_MARK, altShortcut, lookRewrite, cycleKey, cycleCoord, lineMode, type VerbContext } from "./tui.ts";

// ─── altShortcut (Alt-<letter> quick-keys, nvim muscle-memory convergence) ──

test("altShortcut: lowercase mnemonics map (nvim's lowercase: m, s, x)", () => {
    assert.equal(altShortcut("\x1bm"), "/models");
    assert.equal(altShortcut("\x1bs"), "/sessions");
    assert.equal(altShortcut("\x1bx"), "/stop");
});

test("altShortcut: CASE matches nvim — capitals are distinct (R/L/Y/N/M)", () => {
    assert.equal(altShortcut("\x1bR"), "/runs");      // nvim <leader>aR
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

// ─── lookRewrite (<<LOOK → <<READ token swap, rest passed through) ───────

test("lookRewrite: swaps the op token at BOTH ends — open and the :OP terminator", () => {
    assert.equal(lookRewrite("<<LOOK(known:///plan.md)::LOOK"), "<<READ(known:///plan.md)::READ");
    assert.equal(lookRewrite("<<LOOK(log:///1/2/3)::LOOK"), "<<READ(log:///1/2/3)::READ");
});

test("lookRewrite: passes [tags](target)<N,M>:body through, swaps only the op", () => {
    assert.equal(lookRewrite("<<LOOK[2](a.ts)<1,40>::LOOK"), "<<READ[2](a.ts)<1,40>::READ");
    assert.equal(lookRewrite("<<LOOK(users.json):$.name:LOOK"), "<<READ(users.json):$.name:READ");
});

test("lookRewrite: case-insensitive in, uppercase READ out", () => {
    assert.equal(lookRewrite("<<look(a.md)::look"), "<<READ(a.md)::READ");
});

test("lookRewrite: a non-LOOK op (incl. the LOOKUP false-friend) → null", () => {
    assert.equal(lookRewrite("<<READ(a.md)::READ"), null);
    assert.equal(lookRewrite("<<EDIT(a.md):x:EDIT"), null);
    assert.equal(lookRewrite("<<LOOKUP(a.md)::LOOKUP"), null);   // \b guards the boundary
    assert.equal(lookRewrite("plain prompt"), null);
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

test("buildHeader: yolo on → shows 'yolo: on'; off/unset → no yolo segment", () => {
    assert.match(buildHeader({ sessionName: "sess", yolo: true }), /· yolo: on ·/);
    assert.doesNotMatch(buildHeader({ sessionName: "sess", yolo: false }), /yolo/);
    assert.doesNotMatch(buildHeader({ sessionName: "sess" }), /yolo/);
});

interface Stub extends VerbContext { calls: Array<{ method: string; params?: unknown }>; out: string[]; imports: string[]; resolved: string[] }

const makeCtx = (results: Record<string, unknown> = {}, opts: Partial<VerbContext["opts"]> = {}): Stub => {
    const calls: Array<{ method: string; params?: unknown }> = [];
    const out: string[] = [];
    const imports: string[] = [];
    const resolved: string[] = [];
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
        switchSession: async (name) => {
            calls.push({ method: "session.create", params: { name } });
            const r = results["session.create"];
            session = ((typeof r === "function" ? (r as (p: unknown) => unknown)({ name }) : r) ?? { id: 2, name: name ?? "new" }) as { id: number; name: string };
            return session;
        },
        write: (s) => { out.push(s); },
        importFile: async (p) => { imports.push(p); },
        resolveProposal: async (action) => { resolved.push(action); },
        calls, out, imports, resolved,
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

test("handleVerb /run [name] → run.fork (new run) then binds to it", async () => {
    const ctx = makeCtx({
        "run.fork": { runId: 42, runName: "main-fork" },
        "session.attach": { id: 1, name: "sess", runId: 42, runName: "main-fork" },
    });
    await handleVerb("/run branch-a", ctx);
    assert.deepEqual(ctx.calls[0], { method: "run.fork", params: { name: "branch-a" } });
    assert.deepEqual(ctx.calls[1], { method: "session.attach", params: { id: 1, runId: 42 } });
    assert.match(ctx.out.join(""), /run: main-fork \(new\)/);
});

test("handleVerb /run with no name → run.fork with no name (auto <parent>-fork)", async () => {
    const ctx = makeCtx({
        "run.fork": { runId: 42, runName: "main-fork" },
        "session.attach": { id: 1, name: "sess", runId: 42, runName: "main-fork" },
    });
    await handleVerb("/run", ctx);
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

test("handleVerb /model <alias> sets it; bare /model shows current", async () => {
    const ctx = makeCtx();
    await handleVerb("/model gpt", ctx);
    assert.equal(ctx.opts.modelAlias, "gpt");
    await handleVerb("/model", ctx);
    assert.match(ctx.out.join(""), /model: gpt/);
});

test("handleVerb /session → session.create (new) + setSession", async () => {
    const ctx = makeCtx({ "session.create": { id: 9, name: "fresh" } });
    await handleVerb("/session fresh", ctx);
    assert.deepEqual(ctx.calls[0], { method: "session.create", params: { name: "fresh" } });
    assert.equal(ctx.getSession().name, "fresh");
    assert.match(ctx.out.join(""), /session: fresh \(new\)/);
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

test("handleVerb /script <path> → reads the file, ships its DSL to op.parse, summarizes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plk-"));
    const file = join(dir, "go.plk");
    await writeFile(file, "<<EDIT(file://a.md):hi:EDIT\n<<READ(file://a.md):READ\n");
    const ctx = makeCtx({ "op.parse": { results: [{ status: 200 }, { status: 200 }] } });
    await handleVerb(`/script ${file}`, ctx);
    const parse = ctx.calls.find((c) => c.method === "op.parse");
    assert.ok(parse, "op.parse was called");
    assert.match((parse!.params as { text: string }).text, /<<EDIT\(file:\/\/a\.md\)/);   // raw file text, unparsed by the client
    assert.match(ctx.out.join(""), /script: 2 ops ok/);
});

test("handleVerb /script surfaces the worst op status", async () => {
    const dir = await mkdtemp(join(tmpdir(), "plk-"));
    const file = join(dir, "bad.plk");
    await writeFile(file, "<<READ(file://gone.md):READ\n");
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

// §2.0 — mode is a per-line prefix habit (converged with nvim's :AI ? / :AI :),
// never a --ask flag. THE ask chain the operator audited by hand (2026-07-11):
// `? ` must put mode:"ask" on the wire flags; this pins the client's half.
test("[§cli-prompt-prefixes-converged-with-plurnknvim-and-the-tui] lineMode: '? ' → flags.mode ask; ': ' → act; prefix stripped from the prompt", () => {
    assert.deepEqual(lineMode("? what is truth"), { flags: { mode: "ask" }, prompt: "what is truth" });
    assert.deepEqual(lineMode(": do the thing"), { flags: { mode: "act" }, prompt: "do the thing" });
});

test("lineMode: bare text carries the base flags untouched; prefix mode OVERRIDES the base", () => {
    assert.deepEqual(lineMode("hello", { yolo: true }), { flags: { yolo: true }, prompt: "hello" });
    assert.deepEqual(lineMode("? hello", { mode: "act", yolo: true }), { flags: { mode: "ask", yolo: true }, prompt: "hello" });
    assert.deepEqual(lineMode("plain"), { prompt: "plain" });
});

test("lineMode: '...' injection prefix strips without minting mode flags", () => {
    assert.deepEqual(lineMode("... btw also"), { prompt: "btw also" });
});

