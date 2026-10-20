// {§cli-runtime-floor} — the Node.js floor this package declares in `engines.node`, checked before the
// client loads, so an older runtime is named instead of failing somewhere later.
import { readFileSync } from "node:fs";

// `engines.node` is a `>=MAJOR[.MINOR[.PATCH]]` floor; any other range is a packaging defect.
export const floorOf = (range: string): { floor: [number, number, number]; spelled: string } => {
    const match = /^>=\s*((\d+)(?:\.(\d+))?(?:\.(\d+))?)$/u.exec(range.trim());
    if (match === null) throw new Error(`engines.node must be a ">=" floor, not "${range}".`);
    return { floor: [Number(match[2]), Number(match[3] ?? 0), Number(match[4] ?? 0)], spelled: match[1] };
};

// The refusal for `version` (spelled as `process.versions.node`), or null when it meets the floor.
export const refusal = (name: string, range: string, version: string): string | null => {
    const { floor, spelled } = floorOf(range);
    const current = version.split(/[.-]/u, 3).map(Number);
    for (const [index, part] of floor.entries()) {
        const actual = current[index] ?? 0;
        if (actual > part) return null;
        if (actual < part) return `${name} requires Node.js ${spelled} or later; this is v${version}.`;
    }
    return null;
};

export const refuseBelowFloor = (name: string): void => {
    const { engines } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { engines: { node: string } };
    const message = refusal(name, engines.node, process.versions.node);
    if (message === null) return;
    process.stderr.write(`${message}\n`);
    process.exit(1);
};
