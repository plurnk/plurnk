import assert from "node:assert/strict";
import test from "node:test";
import { FAMILY_HANDLERS } from "./functionality.ts";
import { commandSpec, completeCommandSyntax, type FunctionalityFamily } from "./commands.ts";

const cases: Array<{ family: FunctionalityFamily; args: string[]; definition: object; scope?: string }> = [
    { family: "mcp", args: ["node", "/tools/server.mjs"], definition: { name: "example", type: "stdio", command: "node", args: ["/tools/server.mjs"] } },
    { family: "skills", args: ["/skills/example", "--ref", "stable"], definition: { name: "example", source: "/skills/example", ref: "stable" } },
    { family: "a2a", args: ["https://agent.example"], definition: { name: "example", url: "https://agent.example" } },
    { family: "env", args: ["hello  world"], definition: { value: "hello  world" }, scope: "worker" },
    { family: "env", args: ["hello  world"], definition: { value: "hello  world" }, scope: "workspace" },
    { family: "schedule", args: ["bot", "FREQ=HOURLY;COUNT=2", "Check in."], definition: { rule: "FREQ=HOURLY;COUNT=2", target: "worker://bot", prompt: "Check in." } },
];

for (const { family, args, definition, scope = "workspace" } of cases) {
    for (const form of ["cli", "tui"] as const) {
        test(`[§cli-functionality-replacement] ${family} ${scope} ${form} sends a whole definition without enabling it`, async () => {
            const calls: unknown[] = [];
            const output: string[] = [];
            const result = { status: 200, alias: "example", definition: { state: "disabled", definition } };
            const tokens = [...(family === "env" ? ["--scope", scope] : []), "replace", "example", ...args];
            const input = form === "cli" ? tokens : tokens.map((token) => family === "env" ? token : JSON.stringify(token)).join(" ");
            assert.equal(await FAMILY_HANDLERS[family](input, {
                call: async (action, params) => { calls.push({ action, params }); return result; },
            }, (line) => output.push(line)), result);
            assert.deepEqual(calls, [{ action: `${scope}.${family}.replace`, params: { alias: "example", definition } }]);
            assert.match(output.join(""), /replaced: example \(disabled\)/u);
            const refusal = new Error("candidate refused");
            await assert.rejects(FAMILY_HANDLERS[family](input, { call: async () => { throw refusal; } }, () => {}),
                (cause) => cause === refusal, "the service's exact failure is preserved");
            let invoked = false;
            await FAMILY_HANDLERS[family](["replace"], { call: async () => { invoked = true; } }, () => {});
            assert.equal(invoked, false, "an incomplete replacement never reaches the service");
        });
    }
}

test("[§cli-functionality-replacement] every alias-named family's help and live completion advertise replacement; members, named by glob, has none", () => {
    assert.equal(commandSpec("members")!.subcommands!.some(({ name }) => name === "replace"), false, "the daemon serves no members replace: a definition is its glob");
    for (const family of Object.keys(FAMILY_HANDLERS) as FunctionalityFamily[]) {
        if (family === "members") continue;
        const commands = commandSpec(family)!.subcommands!;
        assert.equal(commands.find(({ name }) => name === "replace")?.usage,
            commands.find(({ name }) => name === "add")!.usage.replace(/^add/u, "replace"));
        const scope = family === "env" ? "worker" : "workspace";
        const completion = completeCommandSyntax(`/${family} `, new Set([`${scope}.${family}.replace`]));
        assert.equal(completion?.kind, "syntax");
        if (completion?.kind === "syntax") assert.deepEqual(completion.suggestions.map(({ value }) => value), ["replace"]);
    }
});
