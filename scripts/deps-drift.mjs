// Registry dependency drift gate ({§cli-conformance}, #232).
// Runs in `.githooks/pre-push` and `release:gate`. Fails when a watched dependency's
// `verifiedAt` exceeds `budgetDays`, when registry `latest` moves ahead of `verifiedLatest`,
// or when an unwaived direct dependency is outdated. Warns and continues if the registry
// is unreachable offline.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { unreachable } from "./audit-gate.mjs";
import { runDepsCheck } from "./deps-check.mjs";

const DEFAULT_ROOT = fileURLToPath(new URL("..", import.meta.url));

const run = promisify(execFile);
const DAY_MS = 86_400_000;

export const evaluateDriftAge = (policy, nowMs = Date.now()) => {
    const violations = [];
    for (const entry of policy?.watched ?? []) {
        const verifiedMs = Date.parse(`${String(entry.verifiedAt)}T00:00:00Z`);
        if (Number.isNaN(verifiedMs)) {
            violations.push(`${entry.name}: invalid verifiedAt '${String(entry.verifiedAt)}'`);
            continue;
        }
        const elapsedDays = Math.floor((nowMs - verifiedMs) / DAY_MS);
        if (elapsedDays > entry.budgetDays) {
            violations.push(
                `${entry.name}: verifiedAt ${entry.verifiedAt} is ${elapsedDays}d old (budget: ${entry.budgetDays}d). ` +
                `Remedy: inspect 'npm view ${entry.name} version', bump or update verifiedAt/verifiedLatest in deps-policy.json.`,
            );
        }
    }
    return violations;
};

export const evaluateRegistryDrift = ({ policy, latestByPackage, outdatedReport }) => {
    const violations = [];
    const excused = [];
    const veto = new Set(policy?.ownerVeto ?? []);
    const waivers = policy?.waivers ?? {};

    for (const entry of policy?.watched ?? []) {
        const registryLatest = latestByPackage[entry.name];
        if (typeof registryLatest !== "string" || registryLatest.length === 0) {
            violations.push(`${entry.name}: registry returned no latest version`);
            continue;
        }
        if (registryLatest !== entry.verifiedLatest || registryLatest !== entry.resolved) {
            violations.push(
                `${entry.name}: resolved ${entry.resolved} (verifiedLatest ${entry.verifiedLatest}) trails registry latest ${registryLatest} (maxLag: ${entry.maxLag}). ` +
                `Remedy: bump ${entry.name} to ${registryLatest} and update deps-policy.json.`,
            );
        }
    }

    for (const [name, info] of Object.entries(outdatedReport ?? {})) {
        if (name.startsWith("@plurnk/")) continue;
        const rec = Array.isArray(info) ? info[0] : info;
        if (!rec || rec.current === rec.latest) continue;
        const w = waivers[name];
        const canWaive = Boolean(w?.reason && w?.issue) && !veto.has(name);
        if (canWaive) {
            excused.push({ name, current: rec.current, latest: rec.latest, waiver: w });
        } else {
            violations.push(
                `${name}: ${rec.current} → ${rec.latest}${veto.has(name) ? " [ownerVeto — waiver forbidden]" : " (unwaived in deps-policy.json)"}`,
            );
        }
    }

    return { violations, excused };
};

const queryLatestVersion = async (pkgName) => {
    const { stdout } = await run("npm", ["view", pkgName, "version", "--json"], {
        env: { ...process.env, npm_config_fetch_retries: "0", npm_config_fetch_timeout: "15000" },
    });
    return JSON.parse(stdout.trim());
};

const queryOutdated = async (rootDir) => {
    try {
        const { stdout } = await run("npm", ["outdated", "--json"], {
            cwd: rootDir,
            env: { ...process.env, npm_config_fetch_retries: "0", npm_config_fetch_timeout: "15000" },
        });
        return JSON.parse(stdout || "{}");
    } catch (err) {
        if (typeof err.stdout === "string" && err.stdout.trim().startsWith("{")) {
            return JSON.parse(err.stdout);
        }
        throw err;
    }
};

export const runDepsDrift = async (rootDir = DEFAULT_ROOT, nowMs = Date.now()) => {
    const hermeticViolations = await runDepsCheck(rootDir);
    if (hermeticViolations.length > 0) {
        console.error("deps:drift FAILED hermetic check:");
        for (const v of hermeticViolations) console.error(`  - ${v}`);
        return 1;
    }

    const policy = JSON.parse(await readFile(path.join(rootDir, "deps-policy.json"), "utf8"));
    const ageViolations = evaluateDriftAge(policy, nowMs);
    if (ageViolations.length > 0) {
        console.error("deps:drift FAILED verification age budget:");
        for (const v of ageViolations) console.error(`  - ${v}`);
        return 1;
    }

    try {
        const latestEntries = await Promise.all(
            (policy.watched ?? []).map(async (entry) => [entry.name, await queryLatestVersion(entry.name)]),
        );
        const latestByPackage = Object.fromEntries(latestEntries);
        const outdatedReport = await queryOutdated(rootDir);
        const { violations, excused } = evaluateRegistryDrift({
            policy,
            latestByPackage,
            outdatedReport,
        });
        for (const e of excused) {
            console.log(`waived  ${e.name} ${e.current} → ${e.latest}  ${e.waiver.issue}`);
        }
        if (violations.length > 0) {
            console.error("deps:drift FAILED registry freshness check:");
            for (const v of violations) console.error(`  - ${v}`);
            return 1;
        }
        console.log(`deps:drift OK — ${policy.watched.length} watched at latest, ${excused.length} waived, 0 blocking`);
        return 0;
    } catch (cause) {
        const text = `${cause?.stdout ?? ""}\n${cause?.stderr ?? ""}\n${cause?.message ?? ""}`;
        if (!unreachable(text)) {
            console.error(text);
            return 1;
        }
        console.warn(
            `deps:drift: registry UNREACHABLE — continuing offline (#232).\n${text.trim().slice(0, 300)}`,
        );
        return 0;
    }
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = await runDepsDrift();
}
