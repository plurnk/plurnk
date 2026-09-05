// Pack the built client and install it into a sandbox as a real consumer would.
// `npm run build:local:install` / `build:local:uninstall`; also the engine for
// test:installation. Mirror of plurnk-service/scripts/install-sandbox.mjs so the
// two repos' installation stories stay aligned.
//
// Installs --omit=optional: this tests the CLIENT package in isolation — its own
// footprint is just `ws`. The bundled daemon is the SERVICE's boundary (its own
// test:installation covers the service install); ours stays on our side.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Outside the repo tree, so node's module resolution can't walk up into the
// repo's own node_modules — a nested sandbox would defeat the client isolation check.
export const sandbox = resolve(tmpdir(), "plurnk-client-sandbox");

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", ...opts });

export function pack() {
    const out = execFileSync("npm", ["pack"], { cwd: root, encoding: "utf8" });
    return resolve(root, out.trim().split("\n").pop().trim());
}

function cleanTarballs() {
    for (const f of readdirSync(root)) {
        if (/^plurnk-plurnk-\d.*\.tgz$/.test(f)) rmSync(resolve(root, f));
    }
}

export function installSandbox() {
    sh("npm", ["run", "build"], { cwd: root });
    const tarball = pack();
    rmSync(sandbox, { recursive: true, force: true });
    mkdirSync(sandbox, { recursive: true });
    writeFileSync(
        resolve(sandbox, "package.json"),
        `${JSON.stringify({ name: "plurnk-client-sandbox", version: "1.0.0", private: true }, null, 2)}\n`,
    );
    // --omit=optional: the CLIENT alone (just ws). The optional daemon is the
    // service's install to test, not ours — keeps the boundary clean.
    sh("npm", ["install", "--omit=optional", tarball], { cwd: sandbox });
    return { sandbox, tarball };
}

export function uninstallSandbox() {
    rmSync(sandbox, { recursive: true, force: true });
    cleanTarballs();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const cmd = process.argv[2];
    if (cmd === "install") { installSandbox(); process.stdout.write(`sandbox installed: ${sandbox}\n`); }
    else if (cmd === "uninstall") { uninstallSandbox(); process.stdout.write("sandbox removed\n"); }
    else { process.stderr.write("usage: install-sandbox.mjs install|uninstall\n"); process.exit(1); }
}
