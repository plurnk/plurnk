import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { handleEnv } from "./env.ts";
import { ProblemError } from "./diagnostics.ts";

const harness = (results: Record<string, unknown> = {}) => {
    const calls: Array<{ method: string; params?: object }> = [];
    const out: string[] = [];
    const rpc = {
        call: async (method: string, params?: object) => {
            calls.push({ method, params });
            return results[method] ?? {};
        },
    };
    return { rpc, write: (text: string) => out.push(text), calls, out };
};

test("[§cli-environment] list renders every name with its origin, state, value, and source worker", async () => {
    const h = harness({
        "worker.env.list": {
            definitions: [
                { alias: "PATH", origin: "service", state: "active", definition: { value: "/usr/bin:/bin" } },
                { alias: "CI", origin: "service", state: "disabled", definition: { value: "1" } },
                { alias: "CARGO_TARGET_DIR", origin: "worker", state: "active", definition: { value: "/tmp/shared" } },
                { alias: "TOOLCHAIN", origin: "worker", state: "active", inherited: "alice", definition: { value: "stable" } },
            ],
        },
    });
    await handleEnv([], h.rpc, h.write);
    assert.deepEqual(h.calls, [{ method: "worker.env.list", params: {} }], "the family is worker-scoped: the transport binds this tab's worker");
    const text = h.out.join("");
    assert.match(text, /PATH\s+service\s+active\s+\/usr\/bin:\/bin\n/);
    assert.match(text, /CI\s+service\s+disabled\s+1\n/, "a masked ambient name keeps its value in view");
    assert.match(text, /CARGO_TARGET_DIR\s+worker\s+active\s+\/tmp\/shared\n/);
    assert.match(text, /TOOLCHAIN\s+worker\s+active\s+stable\s+\(from alice\)\n/, "an inherited entry names the worker that set it");

    const explicit = harness({ "worker.env.list": { definitions: [] } });
    await handleEnv("", explicit.rpc, explicit.write);
    assert.match(explicit.out.join(""), /environment: none/);
});

test("[§cli-environment] discover takes an optional query and renders each candidate with its owning package", async () => {
    const h = harness({
        "worker.env.discover": {
            candidates: [
                { alias: "PAGER", definition: { value: "cat" }, provenance: { kind: "declaration", source: "@plurnk/plurnk-execs", reference: ".env.defaults" }, summary: "A pager that waits for a keypress hangs a spawn that has no terminal." },
                { alias: "TAVILY_API_KEY", definition: { value: "" }, provenance: { kind: "declaration", source: "@plurnk/plurnk-tavily-plugin", reference: ".env.defaults" }, summary: "The Tavily API key." },
            ],
        },
    });
    await handleEnv("discover", h.rpc, h.write);
    await handleEnv("discover search", h.rpc, h.write);
    assert.deepEqual(h.calls, [
        { method: "worker.env.discover", params: {} },
        { method: "worker.env.discover", params: { query: "search" } },
    ], "an empty query is the whole catalog");
    const text = h.out.join("");
    assert.match(text, /PAGER\s+@plurnk\/plurnk-execs\s+=cat\s+A pager that waits/);
    assert.match(text, /TAVILY_API_KEY\s+@plurnk\/plurnk-tavily-plugin\s+The Tavily API key\./, "an optional declaration shows no empty value");

    const none = harness({ "worker.env.discover": { candidates: [] } });
    await handleEnv("discover nothing", none.rpc, none.write);
    assert.match(none.out.join(""), /candidates: none/);
});

test("[§cli-environment] add hands the value over verbatim; enable, disable, and remove map to the worker's actions", async () => {
    const h = harness({
        "worker.env.add": { status: 201, alias: "CARGO_TARGET_DIR", definition: { alias: "CARGO_TARGET_DIR", state: "active" } },
        "worker.env.enable": { status: 200, alias: "CI", definition: { alias: "CI", state: "active" } },
        "worker.env.disable": { status: 200, alias: "CI", definition: { alias: "CI", state: "disabled" } },
        "worker.env.remove": { status: 200, alias: "CARGO_TARGET_DIR", removed: true },
    });
    await handleEnv("add CARGO_TARGET_DIR /tmp/shared", h.rpc, h.write);
    await handleEnv("add GREETING hello  there \"friend\"", h.rpc, h.write);
    await handleEnv("enable CI", h.rpc, h.write);
    await handleEnv("disable CI", h.rpc, h.write);
    await handleEnv("remove CARGO_TARGET_DIR", h.rpc, h.write);
    assert.deepEqual(h.calls, [
        { method: "worker.env.add", params: { alias: "CARGO_TARGET_DIR", definition: { value: "/tmp/shared" } } },
        { method: "worker.env.add", params: { alias: "GREETING", definition: { value: "hello  there \"friend\"" } } },
        { method: "worker.env.enable", params: { alias: "CI" } },
        { method: "worker.env.disable", params: { alias: "CI" } },
        { method: "worker.env.remove", params: { alias: "CARGO_TARGET_DIR" } },
    ], "the value reaches the daemon as typed: inner spaces and quotes are the value's own");
    const text = h.out.join("");
    assert.match(text, /added: CARGO_TARGET_DIR \(active\)/);
    assert.match(text, /enabled: CI \(active\)/);
    assert.match(text, /disabled: CI \(disabled\)/);
    assert.match(text, /removed: CARGO_TARGET_DIR/);
});

test("[§cli-environment] a refused name renders the daemon's Problem beside the state", async () => {
    const h = harness({
        "worker.env.add": { status: 201, alias: "X", definition: { alias: "X", state: "unavailable", problem: { detail: "never reach a subprocess" } } },
    });
    await handleEnv("add X 1", h.rpc, h.write);
    assert.match(h.out.join(""), /added: X \(unavailable\)\s+— never reach a subprocess/);
});

test("[§cli-environment] malformed client command shapes never dispatch", async () => {
    for (const command of ["add", "add ONLY_A_NAME", "enable", "disable a b", "remove", "update", "list extra"]) {
        const h = harness();
        await handleEnv(command, h.rpc, h.write);
        assert.equal(h.calls.length, 0, command);
        assert.match(h.out.join(""), /usage:/, command);
    }
});

test("[§cli-environment] workspace scope selects the same verbs and preserves values verbatim", async () => {
    const h = harness({ "workspace.env.list": { definitions: [] }, "workspace.env.discover": { candidates: [] } });
    await handleEnv("--scope workspace", h.rpc, h.write);
    await handleEnv("--scope=workspace discover PAGER", h.rpc, h.write);
    await handleEnv('--scope workspace add GREETING hello  "friend"', h.rpc, h.write);
    await handleEnv("--scope workspace enable GREETING", h.rpc, h.write);
    await handleEnv("--scope workspace disable GREETING", h.rpc, h.write);
    await handleEnv("--scope workspace remove GREETING", h.rpc, h.write);
    assert.deepEqual(h.calls, [
        { method: "workspace.env.list", params: {} },
        { method: "workspace.env.discover", params: { query: "PAGER" } },
        { method: "workspace.env.add", params: { alias: "GREETING", definition: { value: 'hello  "friend"' } } },
        { method: "workspace.env.enable", params: { alias: "GREETING" } },
        { method: "workspace.env.disable", params: { alias: "GREETING" } },
        { method: "workspace.env.remove", params: { alias: "GREETING" } },
    ]);
    for (const input of ["--scope", "--scope nowhere", "--scope workspace disable", "--scope=workspace list extra"]) {
        const invalid = harness();
        await handleEnv(input, invalid.rpc, invalid.write);
        assert.deepEqual(invalid.calls, [], input);
        assert.match(invalid.out.join(""), /usage:/, input);
    }
});

const dotenv = async (text: string): Promise<{ dir: string; file: string }> => {
    const dir = await mkdtemp(join(tmpdir(), "plurnk-env-import-"));
    const file = join(dir, ".env.plurnk");
    await writeFile(file, text);
    return { dir, file };
};

test("[§cli-environment] import adds each variable of a dotenv file, to this worker only unless a scope is given", async () => {
    const { dir, file } = await dotenv("# project settings\nAPI_BASE=https://example.test/v1\nexport MODE=\"two words\"\nRATIO=a=b\n");
    try {
        const h = harness();
        await handleEnv(`import ${relative(process.cwd(), file)}`, h.rpc, h.write);
        assert.deepEqual(h.calls, [
            { method: "worker.env.add", params: { alias: "API_BASE", definition: { value: "https://example.test/v1" } } },
            { method: "worker.env.add", params: { alias: "MODE", definition: { value: "two words" } } },
            { method: "worker.env.add", params: { alias: "RATIO", definition: { value: "a=b" } } },
        ], "each variable is one add, its value as the dotenv parser reads it; a relative path resolves from the launch folder");
        assert.match(h.out.join(""), /imported 3 of 3 into this worker only \(--scope workspace imports workspace defaults\)\n$/u);

        const shared = harness();
        await handleEnv(["--scope", "workspace", "import", file], shared.rpc, shared.write);
        assert.deepEqual(shared.calls.map(({ method }) => method), ["workspace.env.add", "workspace.env.add", "workspace.env.add"]);
        assert.match(shared.out.join(""), /imported 3 of 3 into the workspace defaults\n$/u);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("[§cli-environment] an import refusal carries the daemon's detail and the other adds still land, as typed adds would", async () => {
    const { dir, file } = await dotenv("FIRST=1\nPLURNK_MODEL=elsewhere\nLAST=2\n");
    try {
        const aliases: unknown[] = [];
        const out: string[] = [];
        const rpc = {
            call: async (_method: string, params?: object) => {
                const { alias } = params as { alias: string };
                aliases.push(alias);
                if (alias === "PLURNK_MODEL") {
                    throw new ProblemError({ type: "https://problems.plurnk.xyz/functionality/env/reserved-name", title: "Reserved name", status: 422, detail: "PLURNK_MODEL is plurnk's own configuration." });
                }
                return { status: 200, alias, definition: { state: "active" } };
            },
        };
        await handleEnv(`import ${file}`, rpc, (text) => out.push(text));
        assert.deepEqual(aliases.toSorted(), ["FIRST", "LAST", "PLURNK_MODEL"]);
        assert.deepEqual(out.slice(0, -1).toSorted(), [
            "  added: FIRST (active)\n",
            "  added: LAST (active)\n",
            "  refused: PLURNK_MODEL  — PLURNK_MODEL is plurnk's own configuration.\n",
        ]);
        assert.equal(out.at(-1), "  imported 2 of 3 into this worker only (--scope workspace imports workspace defaults)\n");
        const broken = { call: async () => { throw new Error("socket closed"); } };
        await assert.rejects(handleEnv(`import ${file}`, broken, () => {}), /socket closed/u, "a transport failure is not a refusal: the import stops");
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test("[§cli-environment] import names its path, and an unreadable one reaches no add", async () => {
    const h = harness();
    assert.equal(await handleEnv("import", h.rpc, h.write), null);
    assert.match(h.out.join(""), /usage: \/env import <path>\n/u);
    const missing = harness();
    assert.equal(await handleEnv("import /nonexistent/.env.plurnk", missing.rpc, missing.write), null);
    assert.match(missing.out.join(""), /not readable: ENOENT/u);
    assert.deepEqual(missing.calls, []);
});
