import assert from "node:assert/strict";
import test from "node:test";
import { assertProjection, stampPlatform } from "./release-projection.mjs";

const fixture = () => {
    const manifest = { version: "0.92.0", dependencies: { marked: "^18.0.0" } };
    stampPlatform(manifest, "1.25.0");
    const lock = {
        version: manifest.version,
        packages: {
            "": structuredClone(manifest),
            "node_modules/@plurnk/plurnk-contracts": { version: "1.25.0" },
            "node_modules/@plurnk/plurnk-service": { version: "1.25.0", optional: true },
        },
    };
    return { manifest, lock };
};

test("the client release stamps and verifies both platform dependencies without making the backend mandatory", () => {
    const projection = fixture();
    assert.deepEqual(projection.manifest.optionalDependencies, { "@plurnk/plurnk-service": "^1.25.0" });
    assert.equal(projection.manifest.dependencies.marked, "^18.0.0");
    assert.equal(projection.manifest.dependencies["@plurnk/plurnk-service"], undefined);
    assert.doesNotThrow(() => assertProjection(projection, "0.92.0", "1.25.0"));
});

for (const [field, name] of [["dependencies", "@plurnk/plurnk-contracts"], ["optionalDependencies", "@plurnk/plurnk-service"]]) {
    test(`release rejects a missing or stale ${name} in the manifest and both lock projections`, () => {
        for (const broken of ["manifest", "root", "resolved"]) {
            const projection = fixture();
            if (broken === "manifest") delete projection.manifest[field][name];
            if (broken === "root") projection.lock.packages[""][field][name] = "^1.24.0";
            if (broken === "resolved") projection.lock.packages[`node_modules/${name}`].version = "1.24.0";
            assert.throws(() => assertProjection(projection, "0.92.0", "1.25.0"), { message: new RegExp(name) });
        }
    });
}
