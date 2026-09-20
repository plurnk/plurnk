// {§cli-env-defaults} — the client's half of the cascading-environment law
// (plurnk/plurnk-service#771): its packaged `.env.defaults` is the only home for a client choice,
// and a flag is a knob's spelling for one invocation. This gate reads what Git tracks.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNED = /^PLURNK_CLIENT_[A-Z0-9_]+$/u;

// Keys the client names and does not own. The daemon's address is shared with it, so the package
// both depend on declares it and the client folds that panel beneath its own: a shared key has a
// shared owner, and nobody holds anybody else's default.
const SHARED = ["PLURNK_HOST", "PLURNK_PORT", "PLURNK_AGUI_URL"];
const FOREIGN = new Map([
    ...SHARED.map((key) => [key, "@plurnk/plurnk-contracts — the daemon's address, folded into the client's floor"]),
    ["PLURNK_AGUI_TOKEN", "@plurnk/plurnk-agui — the portal's bearer"],
    ["PLURNK_SERVICE_MAX_COMMANDS", "@plurnk/plurnk-core — the daemon's ceiling, which usage names beside the flag it bounds"],
    ["PLURNK_WEB_HOST", "@plurnk/plurnk-web — the portal's own knob, which usage names beside `--host`"],
    ["PLURNK_WEB_PORT", "@plurnk/plurnk-web — the portal's own knob, which usage names beside `--port`"],
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

// A key is named wherever shipped source spells it: a read, a usage line, a hint to the operator.
// A hint that advertises a key nobody owns is as much a lie as a read of one.
const read = new Set();
for (const { code } of sources) {
    for (const match of code.matchAll(/\bPLURNK_[A-Z0-9_]*[A-Z0-9]\b/gu)) read.add(match[0]);
}
// A retired key is named only by the code that refuses it.
const retired = new Set([...readFileSync(join(ROOT, "src/envdefaults.ts"), "utf8").matchAll(/^\s+(PLURNK_[A-Z0-9_]+): "/gmu)].map((match) => match[1]));

test("[§cli-env-defaults] the client's panel declares only its own prefix: one owner per key", () => {
    const strays = [...declared].filter((key) => !OWNED.test(key));
    assert.deepEqual(strays, [], `declared outside PLURNK_CLIENT_*: ${strays.join(", ")}`);
    assert.deepEqual([...retired].filter((key) => declared.has(key)), [], "a retired key is declared nowhere");
});

test("[§cli-env-defaults] every key the client names is declared or has a stated owner, and every declaration is read", () => {
    const undeclared = [...read].filter((key) => !declared.has(key) && !FOREIGN.has(key) && !NOT_A_KNOB.has(key) && !retired.has(key)
        && !key.startsWith("PLURNK_MCP_")).toSorted();
    assert.deepEqual(undeclared, [], `named by src but declared on no panel the client knows: ${undeclared.join(", ")}`);
    const dead = [...declared].filter((key) => !read.has(key)).toSorted();
    assert.deepEqual(dead, [], `declared but never read: ${dead.join(", ")}`);
    const unread = [...FOREIGN.keys()].filter((key) => !read.has(key));
    assert.deepEqual(unread, [], `listed as a foreign key but no longer named: ${unread.join(", ")}`);
});

test("[§cli-env-defaults] a knob read never carries a value of its own", () => {
    const found = new Map();
    for (const { name, code } of sources) {
        const count = [...code.matchAll(/(?:\.PLURNK_[A-Z0-9_]+|\[\s*["'`]PLURNK_[A-Z0-9_]+["'`]\s*\])\s*(?:\?\?|\|\|)\s*(?:["'`][^"'`]|-?\d|true\b|false\b)/gu)].length;
        if (count > 0) found.set(name, count);
    }
    assert.deepEqual([...found], [], "a default beside a read is a second home for a choice");
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

test("[§cli-env-defaults] a key shared with the daemon is declared by the package both depend on, and the floor folds it", async () => {
    const { SHARED_DEFAULTS_PATH, parseDefaults } = await import("../src/envdefaults.ts");
    const shared = readFileSync(SHARED_DEFAULTS_PATH, "utf8");
    const declaredThere = new Set([...shared.matchAll(/^(?:# )?([A-Z][A-Z0-9_]*)=/gmu)].map((match) => match[1]));
    assert.deepEqual(SHARED.filter((key) => !declaredThere.has(key)), [], `not declared by @plurnk/plurnk-contracts: ${SHARED_DEFAULTS_PATH}`);
    const floor = parseDefaults(shared);
    for (const key of ["PLURNK_HOST", "PLURNK_PORT"]) assert.ok(floor[key]?.length > 0, `${key} is live on the shared panel, so a client with nothing set still knows where to dial`);
});
