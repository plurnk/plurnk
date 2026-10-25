export const NODE_MAJOR_FLOOR = 26;

export const refuseBelowFloor = (
    binName = "plurnk",
    nodeVersion = process.versions.node,
): void => {
    const major = Number.parseInt(nodeVersion.split(".")[0] ?? "0", 10);
    if (!Number.isInteger(major) || major < NODE_MAJOR_FLOOR) {
        process.stderr.write(
            `${binName}: requires Node.js >= ${String(NODE_MAJOR_FLOOR)} (found ${nodeVersion}).\n`,
        );
        process.exit(1);
    }
};
