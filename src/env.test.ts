import { test } from "node:test";
import assert from "node:assert/strict";
import { handleEnv } from "./env.ts";

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
                { alias: "TAVILY_API_KEY", definition: { value: "" }, provenance: { kind: "declaration", source: "@plurnk/plurnk-schemes-http-tavily", reference: ".env.defaults" }, summary: "The Tavily API key." },
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
    assert.match(text, /TAVILY_API_KEY\s+@plurnk\/plurnk-schemes-http-tavily\s+The Tavily API key\./, "an optional declaration shows no empty value");

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
