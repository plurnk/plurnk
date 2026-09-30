import test from "node:test";
import assert from "node:assert/strict";
import { handleMcp } from "./mcp.ts";
import { handleSkills } from "./skills.ts";
import { handleA2a } from "./a2a.ts";
import { handleSchedule } from "./schedule.ts";
import { handleMembers } from "./members.ts";
import { handleEnv } from "./env.ts";

for (const [family, scope, handle] of [
    ["mcp", "workspace", handleMcp], ["skills", "workspace", handleSkills],
    ["a2a", "workspace", handleA2a], ["schedule", "workspace", handleSchedule],
    ["members", "workspace", handleMembers], ["env", "worker", handleEnv],
] as const) {
    test(`[§cli-configuration-source] ${family} lists daemon-supplied sources without inspecting configuration`, async () => {
        const calls: string[] = [];
        const output: string[] = [];
        const definitions = [
            { alias: "configured", origin: "service", state: "disabled", provenance: { kind: "environment", source: "PLURNK_EXAMPLE_configured" } },
            { alias: "discovered", origin: "service", state: "dormant", provenance: { kind: "file", source: "/nonexistent/project/.agents/skills/example/SKILL.md" } },
            { alias: "local", origin: "workspace", state: "active" },
        ];
        await handle([], { call: async (method) => { calls.push(method); return { family, definitions }; } }, (text) => output.push(text));
        assert.deepEqual(calls, [`${scope}.${family}.list`]);
        const lines = output.join("").split("\n");
        assert.ok(lines.some((line) => /configured.*source=PLURNK_EXAMPLE_configured/u.test(line)));
        assert.ok(lines.some((line) => /discovered.*source=\/nonexistent\/project\/\.agents\/skills\/example\/SKILL\.md/u.test(line)));
        assert.ok(lines.some((line) => /local/u.test(line) && !line.includes("source=")), "no fabricated source for local definitions");
    });
}
