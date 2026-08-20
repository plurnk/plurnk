import { test } from "node:test";
import assert from "node:assert/strict";
import { handleSkills, type SkillsRunner } from "./skills.ts";

const harness = () => {
    const out: string[] = [];
    const calls: Array<{ args: readonly string[]; cwd: string }> = [];
    const runner: SkillsRunner = async (args, cwd) => {
        calls.push({ args, cwd });
        return { stdout: "\u001b[32mdone\u001b[0m\n", stderr: "" };
    };
    return { write: (text: string) => out.push(text), out, calls, runner };
};

test("skills lists only the universal project target by default", async () => {
    const h = harness();
    await handleSkills([], h.write, "/work/project", h.runner);
    assert.deepEqual(h.calls, [{
        args: ["list", "--agent", "universal"],
        cwd: "/work/project",
    }]);
    assert.equal(h.out.join(""), "done\n");
});

test("skills delegates add and remove to the universal Agent Skills CLI", async () => {
    const add = harness();
    await handleSkills(
        "add 'owner/skill repo' --skill review",
        add.write,
        "/work/project",
        add.runner,
    );
    assert.deepEqual(add.calls[0]?.args, [
        "add",
        "owner/skill repo",
        "--skill",
        "review",
        "--agent",
        "universal",
        "--yes",
    ]);

    const remove = harness();
    await handleSkills(["remove", "review"], remove.write, "/work/project", remove.runner);
    assert.deepEqual(remove.calls[0]?.args, [
        "remove",
        "review",
        "--agent",
        "universal",
        "--yes",
    ]);
});

test("skills exposes registry discovery without inventing a Plurnk registry", async () => {
    const h = harness();
    await handleSkills(["find", "sqlite", "review"], h.write, "/work/project", h.runner);
    assert.deepEqual(h.calls[0]?.args, ["find", "sqlite", "review"]);
});

test("skills updates project or global universal skills explicitly", async () => {
    const project = harness();
    await handleSkills(["update", "review"], project.write, "/work/project", project.runner);
    assert.deepEqual(project.calls[0]?.args, ["update", "review", "--project", "--yes"]);

    const global = harness();
    await handleSkills(["update", "review", "--global"], global.write, "/work/project", global.runner);
    assert.deepEqual(global.calls[0]?.args, ["update", "review", "--global", "--yes"]);
});

test("skills rejects alternate agent targets and malformed invocations", async () => {
    const agent = harness();
    await handleSkills(["add", "owner/repo", "--agent", "codex"], agent.write, "/work/project", agent.runner);
    assert.equal(agent.calls.length, 0);
    assert.match(agent.out.join(""), /usage:/);

    const allAgents = harness();
    await handleSkills(["add", "owner/repo", "--all"], allAgents.write, "/work/project", allAgents.runner);
    assert.equal(allAgents.calls.length, 0);
    assert.match(allAgents.out.join(""), /usage:/);

    const assignedAgent = harness();
    await handleSkills(["add", "owner/repo", "--agent=codex"], assignedAgent.write, "/work/project", assignedAgent.runner);
    assert.equal(assignedAgent.calls.length, 0);
    assert.match(assignedAgent.out.join(""), /usage:/);

    const quoted = harness();
    await handleSkills("add 'unterminated", quoted.write, "/work/project", quoted.runner);
    assert.equal(quoted.calls.length, 0);
    assert.match(quoted.out.join(""), /usage:/);
});

test("skills requires a project root and preserves command failure context", async () => {
    const h = harness();
    await assert.rejects(
        () => handleSkills([], h.write, null, h.runner),
        /project root/,
    );

    const cause = Object.assign(new Error("exit 1"), { stderr: "registry unavailable\n" });
    const failed = harness();
    await assert.rejects(
        () => handleSkills([], failed.write, "/work/project", async () => Promise.reject(cause)),
        (error: unknown) => error instanceof Error
            && error.message === "Agent Skills command failed"
            && error.cause === cause,
    );
    assert.equal(failed.out.join(""), "registry unavailable\n");
});
