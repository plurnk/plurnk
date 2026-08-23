// Built-client dogfood for the Worker Functionality families the TUI projects
// beside /mcp: /skills against the standard-CLI contract (fixture installer)
// and /agents against an independent official-SDK A2A agent. One grammar, the
// daemon's states, and one exact unavailable Problem per family.

import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { bootDaemon, locateDaemon, type Daemon } from "../intg/harness.ts";
import { spawnTui } from "./harness.ts";

let daemon: Daemon | null = null;
let agent: { baseUrl: string; close(): Promise<void> } | null = null;
let scratch = "";
let source = "";

before(async () => {
    const bin = await locateDaemon();
    if (bin === null) return;
    const serviceRoot = resolve(process.cwd(), "../plurnk-service");
    const skillsCli = join(serviceRoot, "plurnk-core/test/intg/_skills-cli.mjs");
    try {
        await access(skillsCli);
    } catch {
        return;
    }
    const { startDemoAgent } = await import(join(serviceRoot, "plurnk-a2a/test/fixtures/DemoAgent.ts")) as { startDemoAgent: () => Promise<{ baseUrl: string; close(): Promise<void> }> };
    agent = await startDemoAgent();
    scratch = await mkdtemp(join(tmpdir(), "plurnk-functionality-tui-"));
    source = join(scratch, "source");
    await mkdir(join(source, "extra"), { recursive: true });
    await writeFile(join(scratch, "delegate.plk"), [
        "# PLAN0",
        '{"entries":[{"content":"Delegate one comparison to the configured remote agent.","status":"in_progress"}]}',
        "## SEND0 [200] (a2a://researcher)",
        "Compare mangoes and pineapples in one concise sentence.",
        "",
    ].join("\n"));
    await writeFile(join(source, "extra", "SKILL.md"), "---\nname: extra\ndescription: Extra dogfood skill\n---\nUse extra.\n");
    daemon = await bootDaemon(bin, {
        readyTimeoutMs: 30_000,
        extraEnv: {
            PLURNK_SERVICE_SKILLS_CLI: `"${process.execPath} ${skillsCli}"`,
            PLURNK_SERVICE_SKILLS_REGISTRY_URL: "",
            PLURNK_A2A_RESEARCHER: agent.baseUrl,
            PLURNK_A2A_ENABLED: '["researcher"]',
        },
    });
});

after(async () => {
    await daemon?.cleanup();
    await agent?.close();
    if (scratch.length > 0) await rm(scratch, { recursive: true, force: true });
});

describe("TUI Functionality dogfood", () => {
    test("[§cli-universal-agent-skills] [§cli-outbound-agents] /skills and /agents share the lifecycle grammar against the built daemon", { timeout: 90_000 }, async (t) => {
        if (daemon === null) { t.skip("service checkout with Functionality fixtures is not reachable"); return; }
        const project = await mkdtemp(join(scratch, "project-"));
        const tui = spawnTui(daemon.url, [], {}, project);
        try {
            await tui.waitFor(/plurnk.*\/help/);

            // Skills: the global root is the daemon's isolated home.
            tui.write(`/skills add extra ${source} --global\r`);
            await tui.waitFor(/added: extra \(active\)/, 20_000);
            tui.write("/skills\r");
            await tui.waitFor(/extra\s+active\s+global[\s\S]*Extra dogfood skill/, 20_000);
            tui.write("/skills disable extra\r");
            await tui.waitFor(/disabled: extra \(disabled\)/, 20_000);
            tui.write("/skills enable extra\r");
            await tui.waitFor(/enabled: extra \(active\)/, 20_000);
            tui.write(`/skills add ghost ${source} --global\r`);
            const skillProblem = await tui.waitFor(/ghost[\s\S]*(install|not found|could not)/i, 20_000);
            assert.doesNotMatch(skillProblem, /added: ghost/);
            tui.write("/skills remove extra\r");
            await tui.waitFor(/removed: extra/, 20_000);

            // Agents: the configured researcher is live; a dead peer is an exact Problem.
            tui.write("/agents\r");
            await tui.waitFor(/researcher\s+active\s+http:\/\/127\.0\.0\.1:\d+\s+Plurnk A2A protocol witness v1\.0\.0\s+1 skills\s+\(service\)/, 20_000);
            tui.write(`/agents discover ${agent!.baseUrl}\r`);
            await tui.waitFor(/plurnk-a2a-protocol-witness\s+candidate/, 20_000);
            // Remote-agent delegation through the ordinary client surface: the
            // scripted SEND routes to the enabled alias and answers its Task
            // receipt (a 4xx/5xx would print a worst-status diagnosis instead).
            tui.write(`/script ${join(scratch, "delegate.plk")}\r`);
            await tui.waitFor(/script: 2 ops ok/, 20_000);
            tui.write(`/agents add peer ${agent!.baseUrl}\r`);
            await tui.waitFor(/added: peer \(active\)/, 20_000);
            tui.write("/agents disable researcher\r");
            await tui.waitFor(/disabled: researcher \(disabled\)/, 20_000);
            tui.write("/agents add ghost http://127.0.0.1:9\r");
            const agentProblem = await tui.waitFor(/ghost[\s\S]*(Agent Card|unreachable|card)/i, 20_000);
            assert.doesNotMatch(agentProblem, /added: ghost/);
            tui.write("/agents remove peer\r");
            await tui.waitFor(/removed: peer/, 20_000);
            tui.write("/quit\r");
            assert.equal(await tui.exited, 0);
        } finally {
            tui.kill();
        }
    });
});
