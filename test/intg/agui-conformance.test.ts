import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";
import { actionViaBridge } from "../../src/agui.ts";
import { ProblemError } from "../../src/diagnostics.ts";
import { bootDaemon, locateDaemon } from "./harness.ts";

interface Discovery {
    schemaVersion: number;
    actions: Record<string, {
        scope: unknown;
        inputSchema: unknown;
        outputSchema: unknown;
    }>;
    notifications: Record<string, { payloadSchema: unknown }>;
}

interface Disposition {
    posture: "native" | "generic" | "unsupported";
    reason?: string;
    dimensions: string[];
    evidence: string[];
}

interface Conformance {
    schemaVersion: number;
    client: string;
    actions: Record<string, Disposition>;
    notifications: Record<string, Disposition>;
}

const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);

const sortedKeys = (value: Record<string, unknown>): string[] => Object.keys(value).toSorted();
const run = promisify(execFile);

const assertDisposition = (name: string, value: Disposition): void => {
    assert.ok(["native", "generic", "unsupported"].includes(value.posture), `${name} has a known posture`);
    assert.ok(Array.isArray(value.dimensions) && value.dimensions.length > 0, `${name} declares dimensions`);
    assert.ok(Array.isArray(value.evidence) && value.evidence.length > 0, `${name} cites evidence`);
    assert.ok(value.evidence.every((item) => typeof item === "string" && item.length > 0), `${name} evidence is nonempty`);
    if (value.posture === "unsupported") {
        assert.ok(typeof value.reason === "string" && value.reason.length > 0, `${name} explains unsupported behavior`);
    } else {
        assert.equal(value.reason, undefined, `${name} does not carry an unsupported reason`);
    }
};

test("[§cli-agui-conformance] the client accounts for the complete live AG-UI surface", { timeout: 60_000 }, async (t) => {
    const service = await locateDaemon();
    if (service === null) { t.skip("no plurnk-service binary reachable"); return; }
    const daemon = await bootDaemon(service, { readyTimeoutMs: 30_000 });
    t.after(daemon.cleanup);

    const manifest = JSON.parse(await readFile(
        resolve(import.meta.dirname, "../../conformance/agui-client.json"),
        "utf8",
    )) as Conformance;
    const discovery = await actionViaBridge<Discovery>(
        { bridgeUrl: daemon.url },
        { threadId: "terminal-conformance", kind: "discover" },
    );

    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.client, "@plurnk/plurnk");
    assert.equal(discovery.schemaVersion, 1);
    assert.deepEqual(sortedKeys(manifest.actions), sortedKeys(discovery.actions));
    assert.deepEqual(sortedKeys(manifest.notifications), sortedKeys(discovery.notifications));

    for (const [name, contract] of Object.entries(discovery.actions)) {
        assert.ok(typeof contract.scope === "string" && ["worldless", "workspace", "worker"].includes(contract.scope), `${name} declares scope`);
        assert.ok(object(contract.inputSchema), `${name} declares an input schema`);
        assert.ok(object(contract.outputSchema), `${name} declares an output schema`);
        assertDisposition(`action ${name}`, manifest.actions[name]!);
        await assert.rejects(
            () => actionViaBridge(
                { bridgeUrl: daemon.url },
                {
                    threadId: "terminal-conformance-invalid",
                    ...(contract.scope === "workspace"
                        ? { workspace: "terminal-conformance-invalid" }
                        : {}),
                    kind: name,
                    params: { unadvertised: true },
                },
            ),
            (error: unknown) => error instanceof ProblemError
                && error.problem.type === "https://problems.plurnk.dev/agui/action/invalid-action-parameters"
                && error.problem.status === 400,
            `${name} preserves the exact admission Problem`,
        );
    }
    for (const [name, contract] of Object.entries(discovery.notifications)) {
        assert.ok(object(contract.payloadSchema), `${name} declares a payload schema`);
        assertDisposition(`notification ${name}`, manifest.notifications[name]!);
    }

    const temp = await mkdtemp(join(tmpdir(), "plurnk-agui-conformance-"));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const discoveryPath = join(temp, "discovery.json");
    await writeFile(discoveryPath, JSON.stringify(discovery));
    const serviceRoot = process.env.PLURNK_SERVICE_DIR
        ?? resolve(import.meta.dirname, "../../../plurnk-service");
    const report = await run("node", [
        "--conditions=plurnk-dev",
        resolve(serviceRoot, "plurnk-contracts/scriptify/agui-conformance-report.ts"),
        discoveryPath,
        resolve(import.meta.dirname, "../../conformance/agui-client.json"),
        resolve(import.meta.dirname, "../.."),
    ]);
    const rows = report.stdout.trim().split("\n").map((line) => JSON.parse(line) as {
        kind: string;
        name: string;
        dimensions: string[];
    });
    assert.equal(rows.length, Object.keys(discovery.actions).length + Object.keys(discovery.notifications).length);
    assert.ok(rows.every(({ dimensions }) => dimensions.length > 0));
    process.stdout.write(report.stdout);
});
