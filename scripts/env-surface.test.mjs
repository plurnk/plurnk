// {§cli-env-defaults} — the client's half of the cascading-environment law
// (plurnk/plurnk-service#771): its packaged `.env.defaults` is the only home for a client choice,
// and a flag is a knob's spelling for one invocation. This gate reads what Git tracks.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNED = /^PLURNK_CLIENT_[A-Z0-9_]+$/u;

// Keys the client reads and does not own.
const FOREIGN = new Map([
    ["PLURNK_HOST", "@plurnk/plurnk-service — the daemon's address"],
    ["PLURNK_PORT", "@plurnk/plurnk-service — the daemon's address"],
    ["PLURNK_AGUI_URL", "@plurnk/plurnk-agui — the whole portal URL, when the daemon is reached through one"],
    ["PLURNK_AGUI_TOKEN", "@plurnk/plurnk-agui — the portal's bearer"],
]);
// Where two laws collide. One owner per key says the client may not declare the daemon's address;
// no value beside a read says its code may not hold one; and a client can be installed without
// the service, so it has no panel to take them from. Held open, named and counted, until the
// ruling on where a client's dial address lives (plurnk/plurnk-service#771). It may only shrink.
const UNRESOLVED_FALLBACKS = new Map([
    ["src/dispatcher.ts", { count: 2, shipped: { PLURNK_HOST: "127.0.0.1", PLURNK_PORT: "1066" } }],
]);

// `PLURNK_*` strings that are not knobs.
const NOT_A_KNOB = new Map([
    ["PLURNK_FENCE", "the language's fence, imported from contracts"],
    ["PLURNK_OPS", "the language's operation alphabet, imported from contracts"],
]);

// Options that are not standing choices, each with its reason. Every other option mirrors a knob.
const ARGUMENTS = new Map([
    ["help", "prints usage"],
    ["version", "prints provenance"],
    ["env-file", "chooses the environment itself, so it cannot be a knob of it"],
    ["env-file-if-exists", "chooses the environment itself, so it cannot be a knob of it"],
    ["policy", "retired; parsed only to be refused with its successors named"],
    ["loop", "an argument of `log read`"],
    ["turn", "an argument of `log read`"],
    ["since", "an argument of `log read`"],
    ["limit", "an argument of `log read` and `models`"],
    ["offset", "an argument of `models`"],
    ["provider", "an argument of `models`"],
    ["all", "an argument of `models`"],
    ["width", "an argument of `render`"],
    ["host", "an argument of `web`; its knob, PLURNK_WEB_HOST, is @plurnk/plurnk-web's"],
    ["port", "an argument of `web`; its knob, PLURNK_WEB_PORT, is @plurnk/plurnk-web's"],
]);

const tracked = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "src"], { cwd: ROOT, encoding: "utf8" })
    .split("\0").filter((name) => /\.ts$/u.test(name) && !/\.test\.ts$/u.test(name));
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "").replace(/([^:"'`])\/\/.*$/gmu, "$1");
const sources = tracked.map((name) => ({ name, code: stripComments(readFileSync(join(ROOT, name), "utf8")) }));

const panel = readFileSync(join(ROOT, ".env.defaults"), "utf8");
const live = new Map([...panel.matchAll(/^([A-Z][A-Z0-9_]*)=(.*)$/gmu)].map((match) => [match[1], match[2]]));
const optional = new Set([...panel.matchAll(/^# ([A-Z][A-Z0-9_]*)=/gmu)].map((match) => match[1]));
const declared = new Set([...live.keys(), ...optional]);

// A knob is named where it is read: a property, or the exact string a reader is handed.
const read = new Set();
for (const { code } of sources) {
    for (const match of code.matchAll(/\.(PLURNK_[A-Z0-9_]*[A-Z0-9])\b|["'`](PLURNK_[A-Z0-9_]*[A-Z0-9])["'`]/gu)) read.add(match[1] ?? match[2]);
}
// A retired key is named only by the code that refuses it.
const retired = new Set([...readFileSync(join(ROOT, "src/envdefaults.ts"), "utf8").matchAll(/^\s+(PLURNK_[A-Z0-9_]+): "/gmu)].map((match) => match[1]));

test("[§cli-env-defaults] the client's panel declares only its own prefix: one owner per key", () => {
    const strays = [...declared].filter((key) => !OWNED.test(key));
    assert.deepEqual(strays, [], `declared outside PLURNK_CLIENT_*: ${strays.join(", ")}`);
    assert.deepEqual([...retired].filter((key) => declared.has(key)), [], "a retired key is declared nowhere");
});

test("[§cli-env-defaults] every knob the client reads is declared, and every declaration is read", () => {
    const undeclared = [...read].filter((key) => !declared.has(key) && !FOREIGN.has(key) && !NOT_A_KNOB.has(key) && !retired.has(key)
        && !key.startsWith("PLURNK_MCP_")).toSorted();
    assert.deepEqual(undeclared, [], `read by src but declared on no panel the client knows: ${undeclared.join(", ")}`);
    const dead = [...declared].filter((key) => !read.has(key)).toSorted();
    assert.deepEqual(dead, [], `declared but never read: ${dead.join(", ")}`);
    const unread = [...FOREIGN.keys()].filter((key) => !read.has(key));
    assert.deepEqual(unread, [], `listed as a foreign read but no longer read: ${unread.join(", ")}`);
});

test("[§cli-env-defaults] a knob read never carries a value of its own", () => {
    const found = new Map();
    for (const { name, code } of sources) {
        const count = [...code.matchAll(/(?:\.PLURNK_[A-Z0-9_]+|\[\s*["'`]PLURNK_[A-Z0-9_]+["'`]\s*\])\s*(?:\?\?|\|\|)\s*(?:["'`][^"'`]|-?\d|true\b|false\b)/gu)].length;
        if (count > 0) found.set(name, count);
    }
    const allowed = new Map([...UNRESOLVED_FALLBACKS].map(([name, { count }]) => [name, count]));
    assert.deepEqual([...found].toSorted(), [...allowed].toSorted(), "a default beside a read is a second home for a choice; the held-open exception neither grows nor lingers");
});

test("[§cli-env-defaults] a flag is a knob's spelling: every option mirrors one, or says why it is an argument", () => {
    const dispatcher = readFileSync(join(ROOT, "src/dispatcher.ts"), "utf8");
    const block = /\boptions: \{\n([\s\S]*?)\n {8}\},\n {4}\}\);/u.exec(dispatcher);
    assert.ok(block, "the parseArgs option block is where it was");
    const options = [...block[1].matchAll(/^\s+"?([a-z][a-z-]*)"?: \{ type:/gmu)].map((match) => match[1]);
    assert.ok(options.length > 20, `parsed ${options.length} options`);
    const flagOf = (knob) => knob.replace(/^PLURNK_CLIENT_/u, "").toLowerCase().replaceAll("_", "-");
    const knobFlags = new Map([...declared].filter((key) => OWNED.test(key)).map((knob) => [flagOf(knob), knob]));
    const unexplained = options.filter((option) => !knobFlags.has(option) && !ARGUMENTS.has(option));
    assert.deepEqual(unexplained, [], `options with neither a knob nor a stated reason: ${unexplained.join(", ")}`);
    const flagless = [...knobFlags].filter(([flag]) => !options.includes(flag)).map(([, knob]) => knob);
    assert.deepEqual(flagless, [], `knobs with no flag: ${flagless.join(", ")}`);
    const stale = [...ARGUMENTS.keys()].filter((option) => !options.includes(option));
    assert.deepEqual(stale, [], `listed as an argument but no longer an option: ${stale.join(", ")}`);
    const both = [...ARGUMENTS.keys()].filter((option) => knobFlags.has(option));
    assert.deepEqual(both, [], `an option cannot be both a knob's flag and an argument: ${both.join(", ")}`);
});

test("[§cli-env-defaults] while the daemon's address is held in code, it has not drifted from the daemon's panel", { skip: !existsSync(join(ROOT, "../plurnk-service/plurnk-core/.env.defaults")) }, () => {
    const service = readFileSync(join(ROOT, "../plurnk-service/plurnk-core/.env.defaults"), "utf8");
    for (const { shipped } of UNRESOLVED_FALLBACKS.values()) {
        for (const [key, value] of Object.entries(shipped)) {
            assert.equal(new RegExp(`^${key}=(.*)$`, "mu").exec(service)?.[1], value, `${key} drifted from the service's own panel`);
        }
    }
});
