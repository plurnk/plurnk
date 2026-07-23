import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

writeFileSync(resolve(root, "dist", "build-info.json"), `${JSON.stringify({
    package: pkg.name,
    version: pkg.version,
    revision: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain").length > 0,
})}\n`);
