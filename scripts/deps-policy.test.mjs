// Coverage for deps-policy.json, deps:check, deps:drift, and ACP v2 SDK surface alignment ({§cli-conformance}, #232).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
    evaluateAcpV2Surface,
    evaluateDepsPolicy,
    extractRuntimeRelativeSpecifiers,
    findRuntimeCycles,
    runDepsCheck,
} from "./deps-check.mjs";
import { evaluateDriftAge, evaluateRegistryDrift } from "./deps-drift.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const loadRepoInputs = async () => {
    const [policyRaw, manifestRaw, lockfileRaw, conformanceRaw] = await Promise.all([
        readFile(path.join(ROOT, "deps-policy.json"), "utf8"),
        readFile(path.join(ROOT, "package.json"), "utf8"),
        readFile(path.join(ROOT, "package-lock.json"), "utf8"),
        readFile(path.join(ROOT, "conformance/acp-client.json"), "utf8"),
    ]);
    return {
        policy: JSON.parse(policyRaw),
        manifest: JSON.parse(manifestRaw),
        lockfile: JSON.parse(lockfileRaw),
        conformance: JSON.parse(conformanceRaw),
    };
};

test("{§cli-conformance} deps:check passes on the committed repository state (#232)", async () => {
    const violations = await runDepsCheck();
    assert.deepEqual(violations, []);
});

test("{§cli-conformance} deps:check rejects a caret range or version mismatch on @earendil-works/pi-tui and @agentclientprotocol/sdk (#232)", async () => {
    const { policy, manifest, lockfile } = await loadRepoInputs();
    const piTuiResolved = policy.watched.find((w) => w.name === "@earendil-works/pi-tui").resolved;
    const acpResolved = policy.watched.find((w) => w.name === "@agentclientprotocol/sdk").resolved;

    const caretPiTui = structuredClone(manifest);
    caretPiTui.dependencies["@earendil-works/pi-tui"] = `^${piTuiResolved}`;
    const v1 = evaluateDepsPolicy({ policy, manifest: caretPiTui, lockfile, piTuiHasNativePrebuilds: true });
    assert.ok(
        v1.some((msg) => msg.includes(`@earendil-works/pi-tui requires exact pin '${piTuiResolved}', found '^${piTuiResolved}'`)),
        `Expected exact-pin violation, got: ${JSON.stringify(v1)}`,
    );

    const exactAcp = structuredClone(manifest);
    exactAcp.dependencies["@agentclientprotocol/sdk"] = acpResolved;
    const v2 = evaluateDepsPolicy({ policy, manifest: exactAcp, lockfile, piTuiHasNativePrebuilds: true });
    assert.ok(
        v2.some((msg) => msg.includes(`@agentclientprotocol/sdk requires caret range '^${acpResolved}', found '${acpResolved}'`)),
        `Expected caret-range violation, got: ${JSON.stringify(v2)}`,
    );

    const driftedLock = structuredClone(lockfile);
    driftedLock.packages["node_modules/@agentclientprotocol/sdk"].version = "99.0.0";
    const v3 = evaluateDepsPolicy({ policy, manifest, lockfile: driftedLock, piTuiHasNativePrebuilds: true });
    assert.ok(
        v3.some((msg) => msg.includes(`node_modules/@agentclientprotocol/sdk resolves to '99.0.0', expected '${acpResolved}'`)),
        `Expected lockfile resolution violation, got: ${JSON.stringify(v3)}`,
    );
});

test("{§cli-conformance} deps:check rejects unwatched packages in watched families and unreviewed install scripts (#232)", async () => {
    const { policy, manifest, lockfile } = await loadRepoInputs();

    const extraWatchedFamily = structuredClone(manifest);
    extraWatchedFamily.dependencies["@agentclientprotocol/extra"] = "^1.0.0";
    const v1 = evaluateDepsPolicy({ policy, manifest: extraWatchedFamily, lockfile, piTuiHasNativePrebuilds: true });
    assert.ok(
        v1.some((msg) => msg.includes("@agentclientprotocol/extra belongs to a watched family")),
        `Expected watched-family violation, got: ${JSON.stringify(v1)}`,
    );

    const unreviewedScriptLock = structuredClone(lockfile);
    unreviewedScriptLock.packages["node_modules/some-native-pkg"] = { version: "1.0.0", hasInstallScript: true };
    const v2 = evaluateDepsPolicy({ policy, manifest, lockfile: unreviewedScriptLock, piTuiHasNativePrebuilds: true });
    assert.ok(
        v2.some((msg) => msg.includes("allowScripts does not review install script for some-native-pkg@1.0.0")),
        `Expected allowScripts violation, got: ${JSON.stringify(v2)}`,
    );
});

test("{§cli-conformance} deps:check verifies conformance/acp-client.json against the ACP v2 SDK method and SessionUpdate surface (#232)", async () => {
    const { conformance } = await loadRepoInputs();
    assert.deepEqual(evaluateAcpV2Surface(conformance), []);

    const missingGuard = structuredClone(conformance);
    delete missingGuard.acpV2.sessionUpdates.isSubagentUpdate;
    const v1 = evaluateAcpV2Surface(missingGuard);
    assert.ok(
        v1.some((msg) => msg.includes("acpV2.sessionUpdates is missing SDK entry 'isSubagentUpdate'")),
        `Expected missing SessionUpdate guard violation, got: ${JSON.stringify(v1)}`,
    );

    const unretiredAction = structuredClone(conformance);
    unretiredAction.actions["workspace.list"].posture = "retire-to-acp-method";
    const v2 = evaluateAcpV2Surface(unretiredAction);
    assert.ok(
        v2.some((msg) => msg.includes("actions['workspace.list'].posture 'retire-to-acp-method'")),
        `Expected unretired action posture violation, got: ${JSON.stringify(v2)}`,
    );
});

test("{§cli-conformance} deps:drift enforces the verification age budget, registry latest alignment, and ownerVeto (#232)", async () => {
    const { policy } = await loadRepoInputs();

    const withinBudgetNow = Date.parse("2026-11-10T00:00:00Z");
    assert.deepEqual(evaluateDriftAge(policy, withinBudgetNow), []);

    const expiredNow = Date.parse("2026-11-25T00:00:00Z");
    const ageViolations = evaluateDriftAge(policy, expiredNow);
    assert.equal(ageViolations.length, 2);
    assert.ok(ageViolations[0].includes("budget: 14d"));

    const piTuiResolved = policy.watched.find((w) => w.name === "@earendil-works/pi-tui").resolved;
    const acpResolved = policy.watched.find((w) => w.name === "@agentclientprotocol/sdk").resolved;
    const driftResult = evaluateRegistryDrift({
        policy: {
            ...policy,
            waivers: {
                "@agentclientprotocol/sdk": { reason: "attempt to waive vetoed package", issue: "#232" },
                "open": { reason: "pinned for test", issue: "#232" },
            },
        },
        latestByPackage: {
            "@earendil-works/pi-tui": "99.0.0",
            "@agentclientprotocol/sdk": acpResolved,
        },
        outdatedReport: {
            "@agentclientprotocol/sdk": { current: acpResolved, latest: "99.0.0" },
            "open": { current: "11.0.4", latest: "11.1.0" },
        },
    });
    assert.equal(driftResult.excused.length, 1);
    assert.equal(driftResult.excused[0].name, "open");
    assert.ok(
        driftResult.violations.some((msg) => msg.includes(`@earendil-works/pi-tui: resolved ${piTuiResolved}`)),
        `Expected watched latest violation, got: ${JSON.stringify(driftResult.violations)}`,
    );
    assert.ok(
        driftResult.violations.some((msg) => msg.includes(`@agentclientprotocol/sdk: ${acpResolved} → 99.0.0 [ownerVeto`)),
        `Expected ownerVeto violation, got: ${JSON.stringify(driftResult.violations)}`,
    );
});

test("{§cli-conformance} deps:check rejects runtime relative import cycles while ignoring type-only imports (#257)", () => {
    const specs = extractRuntimeRelativeSpecifiers(`
        // import { nope } from "./commented.ts";
        import type { OnlyType } from "./type-only.ts";
        import { type Foo, type Bar } from "./inline-types.ts";
        import { type Baz, realFn } from "./mixed.ts";
        export type { ExportedType } from "./reexport-type.ts";
        export { realExport } from "./reexport-val.ts";
    `);
    assert.deepEqual(specs, ["./mixed.ts", "./reexport-val.ts"]);

    const cyclicGraph = new Map([
        ["src/a.ts", ["src/b.ts"]],
        ["src/b.ts", ["src/c.ts"]],
        ["src/c.ts", ["src/a.ts"]],
        ["src/leaf.ts", []],
    ]);
    const cycles = findRuntimeCycles(cyclicGraph);
    assert.deepEqual(cycles, ["runtime import cycle: src/a.ts -> src/b.ts -> src/c.ts -> src/a.ts"]);
});
