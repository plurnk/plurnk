import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildInfo {
    package: string;
    version: string;
    revision?: string;
    dirty?: boolean;
    artifact: "dist";
    path: string;
}

export const getBuildInfo = async (): Promise<BuildInfo> => {
    const codeDir = dirname(fileURLToPath(import.meta.url));
    const packageRoot = resolve(codeDir, "..");
    const pkg = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
        name: string;
        version: string;
    };
    try {
        const built = JSON.parse(await readFile(resolve(codeDir, "build-info.json"), "utf8")) as
            Omit<BuildInfo, "artifact" | "path">;
        return { ...built, artifact: "dist", path: packageRoot };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return { package: pkg.name, version: pkg.version, artifact: "dist", path: packageRoot };
    }
};

export const formatBuildInfo = (info: BuildInfo): string => {
    const revision = info.revision === undefined
        ? "unknown"
        : `${info.revision.slice(0, 12)}${info.dirty ? "-dirty" : ""}`;
    return `${info.package}@${info.version} ${revision} ${info.artifact} ${info.path}`;
};
