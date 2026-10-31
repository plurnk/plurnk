// Hermetic dependency ledger & ACP v2 SDK surface check ({§cli-conformance}, #232).
// Runs inside `npm test` (`test:lint`) with zero network access.
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url));
import {
    AGENT_METHODS,
    CLIENT_METHODS,
    PROTOCOL_VERSION,
    SessionUpdate,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const DEP_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];

export const evaluateDepsPolicy = ({ policy, manifest, lockfile, piTuiHasNativePrebuilds }) => {
    const violations = [];
    const watched = Array.isArray(policy?.watched) ? policy.watched : [];
    const watchedFamilies = Array.isArray(policy?.watchedFamilies) ? policy.watchedFamilies : [];
    const ownerVeto = new Set(Array.isArray(policy?.ownerVeto) ? policy.ownerVeto : []);

    if (watched.length === 0) {
        violations.push("deps-policy.json: watched list must not be empty");
    }

    const allDeps = new Map();
    for (const section of DEP_SECTIONS) {
        for (const [name, spec] of Object.entries(manifest?.[section] ?? {})) {
            allDeps.set(name, { section, spec });
        }
    }

    const watchedNames = new Set();
    for (const entry of watched) {
        const { name, requirement, resolved, verifiedLatest, verifiedAt, maxLag, budgetDays, why } = entry ?? {};
        if (typeof name !== "string" || name.length === 0) {
            violations.push("deps-policy.json: watched entry is missing a package name");
            continue;
        }
        watchedNames.add(name);
        if (!ownerVeto.has(name)) {
            violations.push(`deps-policy.json: watched dependency ${name} must also be listed in ownerVeto`);
        }
        if (typeof why !== "string" || why.trim().length === 0) {
            violations.push(`deps-policy.json: ${name} is missing a non-empty 'why' rationale`);
        }
        if (!SEMVER_RE.test(String(resolved))) {
            violations.push(`deps-policy.json: ${name}.resolved '${String(resolved)}' is not an exact semver`);
        }
        if (!SEMVER_RE.test(String(verifiedLatest))) {
            violations.push(`deps-policy.json: ${name}.verifiedLatest '${String(verifiedLatest)}' is not an exact semver`);
        }
        if (resolved !== verifiedLatest) {
            violations.push(`deps-policy.json: ${name}.resolved (${String(resolved)}) does not match verifiedLatest (${String(verifiedLatest)})`);
        }
        if (!DATE_RE.test(String(verifiedAt)) || Number.isNaN(Date.parse(`${String(verifiedAt)}T00:00:00Z`))) {
            violations.push(`deps-policy.json: ${name}.verifiedAt '${String(verifiedAt)}' must be YYYY-MM-DD`);
        }
        if (maxLag !== "0 minors" && maxLag !== "any version") {
            violations.push(`deps-policy.json: ${name}.maxLag '${String(maxLag)}' must be '0 minors' or 'any version'`);
        }
        if (!Number.isSafeInteger(budgetDays) || budgetDays <= 0 || budgetDays > 30) {
            violations.push(`deps-policy.json: ${name}.budgetDays must be an integer in 1..30`);
        }

        const dep = allDeps.get(name);
        if (dep === undefined) {
            violations.push(`package.json: watched dependency ${name} is not declared in dependencies/devDependencies/optionalDependencies`);
            continue;
        }
        if (requirement === "exact") {
            if (dep.spec !== resolved) {
                violations.push(`package.json: ${name} requires exact pin '${String(resolved)}', found '${String(dep.spec)}'`);
            }
        } else if (requirement === "caret") {
            const expected = `^${String(resolved)}`;
            if (dep.spec !== expected) {
                violations.push(`package.json: ${name} requires caret range '${expected}', found '${String(dep.spec)}'`);
            }
        } else {
            violations.push(`deps-policy.json: ${name}.requirement '${String(requirement)}' must be 'exact' or 'caret'`);
        }

        const lockEntry = lockfile?.packages?.[`node_modules/${name}`];
        if (!lockEntry || typeof lockEntry.version !== "string") {
            violations.push(`package-lock.json: missing node_modules/${name} resolution`);
        } else if (lockEntry.version !== resolved) {
            violations.push(`package-lock.json: node_modules/${name} resolves to '${lockEntry.version}', expected '${String(resolved)}' from deps-policy.json`);
        }
    }

    for (const [name] of allDeps) {
        if (watchedFamilies.some((prefix) => name.startsWith(prefix)) && !watchedNames.has(name)) {
            violations.push(`package.json: ${name} belongs to a watched family (${watchedFamilies.join(", ")}) and must be listed in deps-policy.json`);
        }
    }

    const allowScripts = manifest?.allowScripts ?? {};
    for (const [pkgPath, info] of Object.entries(lockfile?.packages ?? {})) {
        if (!pkgPath.startsWith("node_modules/") || !info?.hasInstallScript) continue;
        const pkgName = pkgPath.replace(/^.*node_modules\//u, "");
        const key = `${pkgName}@${String(info.version)}`;
        if (!Object.hasOwn(allowScripts, key)) {
            violations.push(`package.json: allowScripts does not review install script for ${key}`);
        }
    }

    const piTuiLock = lockfile?.packages?.["node_modules/@earendil-works/pi-tui"];
    if (piTuiLock && !piTuiLock.hasInstallScript && !piTuiHasNativePrebuilds) {
        violations.push("node_modules/@earendil-works/pi-tui: neither native prebuilds nor a reviewed install script were found");
    }

    return violations;
};

export const evaluateAcpV2Surface = (conformance, sdk = {
    protocolVersion: PROTOCOL_VERSION,
    agentMethods: Object.values(AGENT_METHODS),
    clientMethods: Object.values(CLIENT_METHODS),
    sessionUpdateGuards: Object.keys(SessionUpdate),
}) => {
    const violations = [];
    const acpV2 = conformance?.acpV2;
    if (!acpV2 || typeof acpV2 !== "object") {
        return ["conformance/acp-client.json: missing acpV2 section"];
    }
    if (acpV2.protocolVersion !== sdk.protocolVersion) {
        violations.push(`conformance/acp-client.json: acpV2.protocolVersion (${String(acpV2.protocolVersion)}) !== SDK PROTOCOL_VERSION (${String(sdk.protocolVersion)})`);
    }

    const checkGroup = (label, expectedKeys, recordedObj) => {
        const recorded = recordedObj && typeof recordedObj === "object" ? recordedObj : {};
        for (const key of expectedKeys) {
            const entry = recorded[key];
            if (!entry || typeof entry !== "object") {
                violations.push(`conformance/acp-client.json: acpV2.${label} is missing SDK entry '${key}'`);
                continue;
            }
            if (typeof entry.posture !== "string" || entry.posture.length === 0) {
                violations.push(`conformance/acp-client.json: acpV2.${label}['${key}'] is missing posture`);
            }
            if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
                violations.push(`conformance/acp-client.json: acpV2.${label}['${key}'] is missing evidence`);
            }
        }
        for (const key of Object.keys(recorded)) {
            if (!expectedKeys.includes(key)) {
                violations.push(`conformance/acp-client.json: acpV2.${label}['${key}'] does not exist in @agentclientprotocol/sdk`);
            }
        }
    };

    checkGroup("agentMethods", sdk.agentMethods, acpV2.agentMethods);
    checkGroup("clientMethods", sdk.clientMethods, acpV2.clientMethods);
    checkGroup("sessionUpdates", sdk.sessionUpdateGuards, acpV2.sessionUpdates);

    return violations;
};

export const runDepsCheck = async (rootDir = DEFAULT_ROOT) => {
    const [policyRaw, manifestRaw, lockfileRaw, conformanceRaw] = await Promise.all([
        readFile(path.join(rootDir, "deps-policy.json"), "utf8"),
        readFile(path.join(rootDir, "package.json"), "utf8"),
        readFile(path.join(rootDir, "package-lock.json"), "utf8"),
        readFile(path.join(rootDir, "conformance/acp-client.json"), "utf8"),
    ]);
    const piTuiHasNativePrebuilds = await access(
        path.join(rootDir, "node_modules/@earendil-works/pi-tui/native"),
    ).then(() => true, () => false);

    const violations = [
        ...evaluateDepsPolicy({
            policy: JSON.parse(policyRaw),
            manifest: JSON.parse(manifestRaw),
            lockfile: JSON.parse(lockfileRaw),
            piTuiHasNativePrebuilds,
        }),
        ...evaluateAcpV2Surface(JSON.parse(conformanceRaw)),
    ];
    return violations;
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const violations = await runDepsCheck();
    if (violations.length > 0) {
        console.error("deps:check FAILED:");
        for (const v of violations) console.error(`  - ${v}`);
        process.exit(1);
    }
    console.log("deps:check OK (ledger, manifest, lockfile, and ACP v2 SDK surface aligned)");
}
