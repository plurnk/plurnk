const dependencies = [
    ["dependencies", "@plurnk/plurnk-contracts"],
    ["optionalDependencies", "@plurnk/plurnk-service"],
];

export const stampPlatform = (manifest, platformVersion) => {
    manifest.plurnk ??= {};
    manifest.plurnk.builtAgainst = platformVersion;
    for (const [field, name] of dependencies) {
        manifest[field] ??= {};
        manifest[field][name] = `^${platformVersion}`;
    }
};

export const assertProjection = ({ manifest, lock }, clientVersion, platformVersion) => {
    if (manifest.version !== clientVersion) throw new Error(`client manifest is ${manifest.version}, expected ${clientVersion}`);
    if (manifest.plurnk?.builtAgainst !== platformVersion) {
        throw new Error(`client builtAgainst is ${manifest.plurnk?.builtAgainst}, expected ${platformVersion}`);
    }
    if (lock.version !== clientVersion || lock.packages?.[""]?.version !== clientVersion) {
        throw new Error(`client lock is not stamped at ${clientVersion}`);
    }
    for (const [field, name] of dependencies) {
        const range = `^${platformVersion}`;
        if (manifest[field]?.[name] !== range) throw new Error(`client ${field}.${name} is not ${range}`);
        if (lock.packages?.[""]?.[field]?.[name] !== range) throw new Error(`client lock root omits ${field}.${name}@${range}`);
        const locked = lock.packages?.[`node_modules/${name}`]?.version;
        if (locked !== platformVersion) throw new Error(`client lock resolved ${name} ${locked}, expected ${platformVersion}`);
    }
};
