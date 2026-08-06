// Publish one independently versioned client candidate after its exact
// platform dependency is served. The platform release machine calls --check
// before its first registry write, then calls the mutating phase after serving
// the platform stamp.
import { execFile, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_FILE = join(ROOT, "package.json");
const LOCK_FILE = join(ROOT, "package-lock.json");
const CLIENT_PACKAGE = "@plurnk/plurnk";
const SERVICE_PACKAGE = "@plurnk/plurnk-service";
const CONTRACTS_PACKAGE = "@plurnk/plurnk-contracts";
const CANONICAL_ORIGIN = "ssh://git@ssh.possumtech.com/plurnk/plurnk.git";
const args = process.argv.slice(2);
const checkOnly = args[0] === "--check";
const [clientVersion, platformVersion] = checkOnly ? args.slice(1) : args;

if (![clientVersion, platformVersion].every((value) => /^\d+\.\d+\.\d+$/.test(value ?? ""))) {
    throw new Error("usage: release-publish.mjs [--check] <client-version> <platform-version>");
}

const output = async (command, commandArgs) => (await run(command, commandArgs, {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
})).stdout.trim();

const runVisible = (command, commandArgs, options = {}) => new Promise((accept, reject) => {
    const child = spawn(command, commandArgs, {
        cwd: ROOT,
        ...options,
        stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
        ? accept()
        : reject(new Error(`${command} ${commandArgs.join(" ")} failed (exit ${code})`)));
});

const registryVersions = async (name) => {
    const value = JSON.parse(await output("npm", ["view", name, "versions", "--json"]));
    return Array.isArray(value) ? value : [value];
};

const registryManifest = async (name, version) => JSON.parse(
    await output("npm", ["view", `${name}@${version}`, "--json"]),
);

const assertCanonicalSource = async () => {
    const origin = await output("git", ["remote", "get-url", "origin"]);
    if (origin !== CANONICAL_ORIGIN) throw new Error(`client origin is not canonical: ${origin}`);
    const branch = await output("git", ["branch", "--show-current"]);
    if (branch !== "main") throw new Error(`client release requires main, got ${branch || "detached HEAD"}`);
    const dirty = await output("git", ["status", "--porcelain"]);
    if (dirty !== "") throw new Error(`client release requires a clean committed candidate:\n${dirty}`);
    await output("git", ["fetch", "origin", "main"]);
    const [behind, ahead] = (await output("git", ["rev-list", "--left-right", "--count", "origin/main...HEAD"]))
        .split(/\s+/).map(Number);
    if (behind !== 0 || ahead !== 0) {
        throw new Error(`client main must equal origin/main (behind ${behind}, ahead ${ahead})`);
    }
    await output("git", ["verify-commit", "HEAD"]);
};

const supportsPlatform = (range, version) => {
    const match = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(range ?? "");
    const exact = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    if (match === null || exact === null) return false;
    const minimum = match.slice(1).map(Number);
    const candidate = exact.slice(1).map(Number);
    if (minimum[0] !== candidate[0]) return false;
    return candidate[1] > minimum[1]
        || (candidate[1] === minimum[1] && candidate[2] >= minimum[2]);
};

const readProjection = async () => ({
    manifest: JSON.parse(await readFile(PACKAGE_FILE, "utf8")),
    lock: JSON.parse(await readFile(LOCK_FILE, "utf8")),
});

const assertProjection = ({ manifest, lock }) => {
    if (manifest.version !== clientVersion) throw new Error(`client manifest is ${manifest.version}, expected ${clientVersion}`);
    if (manifest.plurnk?.builtAgainst !== platformVersion) {
        throw new Error(`client builtAgainst is ${manifest.plurnk?.builtAgainst}, expected ${platformVersion}`);
    }
    if (!supportsPlatform(manifest.dependencies?.[CONTRACTS_PACKAGE], platformVersion)) {
        throw new Error(`client contracts range ${manifest.dependencies?.[CONTRACTS_PACKAGE]} excludes ${platformVersion}`);
    }
    if (lock.version !== clientVersion || lock.packages?.[""]?.version !== clientVersion) {
        throw new Error(`client lock is not stamped at ${clientVersion}`);
    }
    if (lock.packages?.[""]?.dependencies?.[CONTRACTS_PACKAGE] !== manifest.dependencies[CONTRACTS_PACKAGE]) {
        throw new Error("client lock root omits the contracts dependency");
    }
    const lockedContracts = lock.packages?.[`node_modules/${CONTRACTS_PACKAGE}`]?.version;
    if (lockedContracts !== platformVersion) {
        throw new Error(`client lock resolved contracts ${lockedContracts}, expected ${platformVersion}`);
    }
};

await assertCanonicalSource();
const clientVersions = await registryVersions(CLIENT_PACKAGE);
const targetServed = clientVersions.includes(clientVersion);

if (checkOnly) {
    if (targetServed) {
        const published = await registryManifest(CLIENT_PACKAGE, clientVersion);
        if (published.plurnk?.builtAgainst !== platformVersion) {
            throw new Error(`${CLIENT_PACKAGE}@${clientVersion} is already immutable against ${published.plurnk?.builtAgainst}`);
        }
    }
    console.log(`client release preflight GREEN: ${CLIENT_PACKAGE}@${clientVersion} against platform ${platformVersion}`);
    process.exit(0);
}

for (const name of [SERVICE_PACKAGE, CONTRACTS_PACKAGE]) {
    const served = await registryManifest(name, platformVersion);
    if (served.version !== platformVersion) throw new Error(`${name}@${platformVersion} is not served`);
}

if (!targetServed) {
    const current = (await readProjection()).manifest;
    if (current.version !== clientVersion && !clientVersions.includes(current.version)) {
        throw new Error(`local client version ${current.version} is neither the target nor a served release`);
    }
    if (current.version !== clientVersion) {
        await output("npm", ["version", clientVersion, "--no-git-tag-version"]);
    }

    const manifest = JSON.parse(await readFile(PACKAGE_FILE, "utf8"));
    manifest.plurnk ??= {};
    manifest.plurnk.builtAgainst = platformVersion;
    await writeFile(PACKAGE_FILE, `${JSON.stringify(manifest, null, 4)}\n`);

    await run("npm", [
        "install", "--package-lock-only", "--prefer-online", "--no-audit", "--no-fund",
    ], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
    await runVisible("npm", ["ci", "--prefer-online", "--no-audit", "--no-fund"]);
    assertProjection(await readProjection());

    const dirty = (await output("git", ["status", "--porcelain"])).split("\n").filter(Boolean);
    const changed = new Set(dirty.map((line) => line.slice(3)));
    if ([...changed].some((file) => !["package.json", "package-lock.json"].includes(file))) {
        throw new Error(`client release preparation changed unexpected files:\n${dirty.join("\n")}`);
    }
    await output("git", ["add", "--", "package.json", "package-lock.json"]);
    const identity = process.env.POSSUMTECH_AGENT_IDENTITY;
    if (!/^[a-z][a-zA-Z0-9_]{0,39}$/.test(identity ?? "")) {
        throw new Error("POSSUMTECH_AGENT_IDENTITY is required to author the client release stamp");
    }
    const committerEmail = await output("git", ["config", "user.email"]);
    const separator = committerEmail.lastIndexOf("@");
    if (separator <= 0) throw new Error(`git user.email is not an address: ${committerEmail}`);
    await run("git", ["commit", "-S", "-m", `chore(release): publish ${clientVersion} against platform ${platformVersion}`], {
        cwd: ROOT,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: identity,
            GIT_AUTHOR_EMAIL: `${committerEmail.slice(0, separator)}+${identity}${committerEmail.slice(separator)}`,
        },
        maxBuffer: 64 * 1024 * 1024,
    });
    await runVisible("git", ["push", "origin", "main"]);
    await assertCanonicalSource();

    const publishEnv = {
        ...process.env,
        PLURNK_COMPOSITION_SERVICE: `${SERVICE_PACKAGE}@${platformVersion}`,
    };
    delete publishEnv.PLURNK_COMPOSITION_CLIENT;
    await runVisible("npm", ["publish", "--access", "public"], { env: publishEnv });
    for (let attempt = 0; attempt < 12; attempt++) {
        if ((await registryVersions(CLIENT_PACKAGE)).includes(clientVersion)) break;
        if (attempt === 11) throw new Error(`${CLIENT_PACKAGE}@${clientVersion} was published but never served`);
        await sleep(10_000);
    }
}

assertProjection(await readProjection());
const published = await registryManifest(CLIENT_PACKAGE, clientVersion);
if (published.plurnk?.builtAgainst !== platformVersion) {
    throw new Error(`${CLIENT_PACKAGE}@${clientVersion} serves builtAgainst ${published.plurnk?.builtAgainst}`);
}
console.log(`client release GREEN: ${CLIENT_PACKAGE}@${clientVersion} against platform ${platformVersion}`);
