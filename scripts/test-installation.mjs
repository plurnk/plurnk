// Off-hot-path e2e: install the built CLIENT into a clean sandbox as a consumer
// would (--omit=optional → just `ws`), then prove OUR side of the boundary — the
// bin runs, the client package is lean, and the no-daemon onboarding + --json
// structured-error paths fire. Self-contained: no daemon, no model, no sibling
// repo. The bundled-daemon install is the service's test:installation; the
// connect-to-a-live-daemon path is the tui harness / live checklist.
//
// Mirror of plurnk-service/scripts/test-installation.mjs.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { installSandbox, uninstallSandbox, sandbox } from "./install-sandbox.mjs";

let failures = 0;
const ok = (cond, msg) => { process.stdout.write(`  ${cond ? "✓" : "✗"} ${msg}\n`); if (!cond) failures++; };
const bin = resolve(sandbox, "node_modules", ".bin", "plurnk");
const mods = resolve(sandbox, "node_modules");

// Run the installed bin with EOF stdin (input: "") so readStdin doesn't block on
// a non-TTY pipe, and a dead daemon URL unless a test overrides it.
const runBin = (args, env = {}) => {
    try {
        const stdout = execFileSync(bin, args, {
            cwd: sandbox, encoding: "utf8", input: "",
            env: { ...process.env, PLURNK_WS: "ws://127.0.0.1:59999", ...env },
        });
        return { code: 0, stdout, stderr: "" };
    } catch (e) {
        return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
    }
};

process.stdout.write("== plurnk (client) installation e2e ==\n");
process.stdout.write("-- local sandbox install (--omit=optional, client alone) --\n");
installSandbox();

ok(existsSync(bin), "plurnk bin linked in the sandbox");
// Our boundary: the CLIENT's own footprint is just ws.
ok(existsSync(resolve(mods, "ws")), "ws installed (the client's one runtime dep)");
ok(!existsSync(resolve(mods, "@plurnk", "plurnk-service")), "optional daemon NOT pulled (--omit=optional; the service's install is its own)");
ok(!existsSync(resolve(mods, "onnxruntime-node")) && !existsSync(resolve(mods, "sharp")), "no native onnxruntime/sharp in the client tree");

const help = runBin(["--help"]);
ok(help.code === 0 && /usage: plurnk /.test(help.stdout), "`--help` prints usage, exit 0");

// No daemon, text mode → onboarding hints on stderr, exit 1, stdout clean.
const refused = runBin(["hello"]);
ok(refused.code === 1, "no-daemon prompt exits 1");
ok(/needs the background daemon|Install the service|Start the daemon/.test(refused.stderr),
    "connection-refused onboarding hints on stderr");

// No daemon, json mode → ONE structured error on stdout, stderr silent.
const refusedJson = runBin(["--json", "hello"]);
ok(refusedJson.code === 1, "--json no-daemon exits 1");
let parsed = null;
try { parsed = JSON.parse(refusedJson.stdout.trim()); } catch { /* invalid JSON → fails below */ }
ok(parsed?.error?.kind === "connection_refused", "--json emits {error:{kind:'connection_refused'}} on stdout");
ok(refusedJson.stderr.trim() === "", "--json keeps stderr silent even on failure");

uninstallSandbox();
process.stdout.write(failures === 0 ? "\n== PASS ==\n" : `\n== FAIL (${failures}) ==\n`);
process.exit(failures === 0 ? 0 : 1);
