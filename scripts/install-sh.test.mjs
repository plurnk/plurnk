// Offline deterministic coverage for POSIX `install.sh` (#255) ({§cli-invocation}, {§cli-conformance}).

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_SH = resolve(ROOT, "install.sh");

const detectDistPlatform = () => {
    const os = process.platform === "linux" ? "linux" : process.platform === "darwin" ? "darwin" : null;
    const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null;
    assert.ok(os !== null && arch !== null, `unsupported test platform ${process.platform}/${process.arch}`);
    return { os, arch };
};

const buildSyntheticPackageTarball = (workDir) => {
    const pkgDir = join(workDir, "synthetic-plurnk-pkg");
    mkdirSync(join(pkgDir, "bin"), { recursive: true });
    writeFileSync(
        join(pkgDir, "package.json"),
        JSON.stringify(
            {
                name: "@plurnk/plurnk",
                version: "6.0.0-test",
                type: "module",
                bin: { plurnk: "bin/plurnk.js" },
            },
            null,
            2,
        ),
        "utf8",
    );
    // Entrypoint prints active node version + spawns a child `#!/usr/bin/env node` script to prove PATH inheritance!
    writeFileSync(
        join(pkgDir, "bin", "plurnk.js"),
        `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "plurnk-child-check-"));
const childScript = join(dir, "child-service.mjs");
writeFileSync(childScript, "#!/usr/bin/env node\\nprocess.stdout.write(process.versions.node);\\n", "utf8");
chmodSync(childScript, 0o755);
const child = spawnSync(childScript, [], { encoding: "utf8" });
rmSync(dir, { recursive: true, force: true });
process.stdout.write(JSON.stringify({
    execNode: process.versions.node,
    childEnvNode: child.stdout,
    argv: process.argv.slice(2),
}) + "\\n");
`,
        "utf8",
    );
    chmodSync(join(pkgDir, "bin", "plurnk.js"), 0o755);
    const tgzName = execFileSync("npm", ["pack", "--quiet"], { cwd: pkgDir, encoding: "utf8" }).trim();
    return join(pkgDir, tgzName);
};

const buildSyntheticNodeArchive = (workDir, os, arch) => {
    const archiveStem = `node-v26.99.0-${os}-${arch}`;
    const stageRoot = join(workDir, "node-dist-stage");
    const binDir = join(stageRoot, archiveStem, "bin");
    mkdirSync(binDir, { recursive: true });

    const realNode = process.execPath;
    const realNpm = execFileSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).trim();

    // Isolated node wrapper delegates to real Node >= 26 while stamping PLURNK_SYNTHETIC_NODE26=1
    writeFileSync(
        join(binDir, "node"),
        `#!/bin/sh
if [ "\${1:-}" = "-p" ]; then
    printf '26\\n'
    exit 0
fi
PLURNK_ISOLATED_MARKER=isolated-26 exec "${realNode}" "$@"
`,
        "utf8",
    );
    chmodSync(join(binDir, "node"), 0o755);

    writeFileSync(
        join(binDir, "npm"),
        `#!/bin/sh
exec "${realNode}" "${realNpm}" "$@"
`,
        "utf8",
    );
    chmodSync(join(binDir, "npm"), 0o755);

    const archiveName = `${archiveStem}.tar.gz`;
    const archivePath = join(workDir, archiveName);
    execFileSync("tar", ["-czf", archivePath, "-C", stageRoot, archiveStem]);
    const sha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
    return { archiveName, archivePath, sha256 };
};

test("{§cli-invocation} {§cli-conformance}: install.sh passes POSIX sh -n and shellcheck -s sh (#255)", () => {
    const shRes = spawnSync("sh", ["-n", INSTALL_SH], { encoding: "utf8" });
    assert.equal(shRes.status, 0, shRes.stderr);

    const scRes = spawnSync("shellcheck", ["-s", "sh", INSTALL_SH], { encoding: "utf8" });
    if (scRes.error?.code !== "ENOENT") {
        assert.equal(scRes.status, 0, `${scRes.stdout}\n${scRes.stderr}`);
    }
});

test("{§cli-invocation} {§cli-conformance}: install.sh reuses system Node >= 26 without downloading an isolated runtime (#255)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "plurnk-install-reuse-"));
    try {
        const tarball = buildSyntheticPackageTarball(tmp);
        const installHome = join(tmp, "share", "plurnk");
        const binDir = join(tmp, "bin");

        const res = spawnSync("sh", [INSTALL_SH], {
            encoding: "utf8",
            env: {
                ...process.env,
                HOME: tmp,
                PLURNK_INSTALL_HOME: installHome,
                PLURNK_BIN_DIR: binDir,
                PLURNK_NPM_PACKAGE: tarball,
                // Dead dist URL proves zero network download occurred!
                PLURNK_NODE_DIST_URL: "http://127.0.0.1:9/dist",
            },
        });
        assert.equal(res.status, 0, `stdout: ${res.stdout}\nstderr: ${res.stderr}`);
        assert.equal(existsSync(join(installHome, "node")), false, "must not install isolated node when system node >= 26");

        const wrapper = join(binDir, "plurnk");
        assert.equal(existsSync(wrapper), true);
        const runOut = execFileSync(wrapper, ["--check-arg"], { encoding: "utf8" });
        const parsed = JSON.parse(runOut.trim());
        assert.equal(parsed.execNode, process.versions.node);
        assert.deepEqual(parsed.argv, ["--check-arg"]);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
});

test("{§cli-invocation} {§cli-conformance}: install.sh falls back to SHA-256-verified isolated Node 26 when system node < 26, propagates Node 26 PATH to child processes, and aborts before extraction on SHA-256 mismatch (#255)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "plurnk-install-isolated-"));
    const { os, arch } = detectDistPlatform();
    const tarball = buildSyntheticPackageTarball(tmp);
    const { archiveName, archivePath, sha256 } = buildSyntheticNodeArchive(tmp, os, arch);
    const archiveBytes = readFileSync(archivePath);

    // Fake older system `node` (v22.14.0) prepended on PATH
    const oldBinDir = join(tmp, "old-system-node");
    mkdirSync(oldBinDir, { recursive: true });
    writeFileSync(
        join(oldBinDir, "node"),
        `#!/bin/sh
if [ "\${1:-}" = "-p" ]; then
    printf '22\\n'
    exit 0
fi
printf 'OLD_NODE_22'
exit 0
`,
        "utf8",
    );
    chmodSync(join(oldBinDir, "node"), 0o755);

    let serveTamperedSha = false;
    const server = http.createServer((req, res) => {
        if (req.url === "/SHASUMS256.txt") {
            const advertisedSha = serveTamperedSha ? "0".repeat(64) : sha256;
            res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
            res.end(`${advertisedSha}  ${archiveName}\n`);
            return;
        }
        if (req.url === `/${archiveName}`) {
            res.writeHead(200, { "content-type": "application/gzip" });
            res.end(archiveBytes);
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");

    const runInstallAsync = (env) =>
        new Promise((resolveRun, rejectRun) => {
            const child = spawn("sh", [INSTALL_SH], { env, stdio: ["ignore", "pipe", "pipe"] });
            let stdout = "";
            let stderr = "";
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (chunk) => {
                stdout += chunk;
            });
            child.stderr.on("data", (chunk) => {
                stderr += chunk;
            });
            child.on("error", rejectRun);
            child.on("close", (status) => resolveRun({ status, stdout, stderr }));
        });

    try {
        const distUrl = `http://127.0.0.1:${String(addr.port)}`;

        // 1. Negative test: tampered SHA-256 must fail non-zero BEFORE extracting anything into $PLURNK_INSTALL_HOME/node!
        serveTamperedSha = true;
        const badHome = join(tmp, "bad-home");
        const badBin = join(tmp, "bad-bin");
        const badRes = await runInstallAsync({
            ...process.env,
            HOME: tmp,
            PATH: `${oldBinDir}:${process.env.PATH ?? ""}`,
            PLURNK_INSTALL_HOME: badHome,
            PLURNK_BIN_DIR: badBin,
            PLURNK_NODE_DIST_URL: distUrl,
            PLURNK_NPM_PACKAGE: tarball,
        });
        assert.notEqual(badRes.status, 0, "tampered checksum must abort with non-zero exit code");
        assert.match(badRes.stderr, /SHA-256 verification failed/u);
        assert.equal(existsSync(join(badHome, "node")), false, "tampered archive must never be extracted");
        assert.equal(existsSync(join(badBin, "plurnk")), false, "launcher must not be created on checksum failure");

        // 2. Positive test: valid SHA-256 extracts isolated Node 26 and child processes inherit isolated Node 26 over old-system-node!
        serveTamperedSha = false;
        const goodHome = join(tmp, "good-home with spaces");
        const goodBin = join(tmp, "good-bin");
        const goodRes = await runInstallAsync({
            ...process.env,
            HOME: tmp,
            PATH: `${oldBinDir}:${process.env.PATH ?? ""}`,
            PLURNK_INSTALL_HOME: goodHome,
            PLURNK_BIN_DIR: goodBin,
            PLURNK_NODE_DIST_URL: distUrl,
            PLURNK_NPM_PACKAGE: tarball,
        });
        assert.equal(goodRes.status, 0, `stdout: ${goodRes.stdout}\nstderr: ${goodRes.stderr}`);
        assert.equal(existsSync(join(goodHome, "node", "bin", "node")), true);

        // Run wrapper with old-system-node FIRST on PATH: child `#!/usr/bin/env node` MUST still resolve to Node 26, NOT OLD_NODE_22!
        const wrapper = join(goodBin, "plurnk");
        const runOut = execFileSync(wrapper, ["hello"], {
            encoding: "utf8",
            env: {
                ...process.env,
                PATH: `${oldBinDir}:${process.env.PATH ?? ""}`,
            },
        });
        const parsed = JSON.parse(runOut.trim());
        assert.equal(parsed.execNode, process.versions.node);
        assert.equal(parsed.childEnvNode, process.versions.node, "child plurnk-service must inherit isolated Node 26 via PATH");
        assert.deepEqual(parsed.argv, ["hello"]);
    } finally {
        server.closeAllConnections();
        await new Promise((r) => server.close(() => r()));
        rmSync(tmp, { recursive: true, force: true });
    }
});
