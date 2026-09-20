import { test } from "node:test";
import assert from "node:assert/strict";
import Knobs, { KnobError } from "./knobs.ts";

const withEnv = (name: string, value: string | undefined, body: () => void): void => {
    const prior = process.env[name];
    try {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
        body();
    } finally {
        if (prior === undefined) delete process.env[name]; else process.env[name] = prior;
    }
};

test("[§cli-env-defaults] a switch is on or off, and anything else is a mistake named by its knob", () => {
    for (const on of ["1", "true", "YES", "on"]) withEnv("PLURNK_CLIENT_TEST", on, () => assert.equal(Knobs.flag("PLURNK_CLIENT_TEST", "live"), true));
    for (const off of ["0", "false", "No", "off"]) withEnv("PLURNK_CLIENT_TEST", off, () => assert.equal(Knobs.flag("PLURNK_CLIENT_TEST", "live"), false));
    withEnv("PLURNK_CLIENT_TEST", "maybe", () => assert.throws(
        () => Knobs.flag("PLURNK_CLIENT_TEST", "live"),
        (error: unknown) => error instanceof KnobError && error.knob === "PLURNK_CLIENT_TEST" && error.value === "maybe" && /must be one of 1, true, yes, on, 0, false, no, off/u.test(error.message),
    ));
});

test("[§cli-env-defaults] an unset live knob is a broken floor; an unset optional one means nobody said", () => {
    withEnv("PLURNK_CLIENT_TEST", undefined, () => {
        assert.throws(() => Knobs.flag("PLURNK_CLIENT_TEST", "live"), /PLURNK_CLIENT_TEST is missing from the client's environment floor/u);
        assert.throws(() => Knobs.text("PLURNK_CLIENT_TEST"), /PLURNK_CLIENT_TEST is missing from the client's environment floor/u);
        assert.equal(Knobs.flag("PLURNK_CLIENT_TEST", "optional"), false);
    });
    withEnv("PLURNK_CLIENT_TEST", "", () => assert.equal(Knobs.flag("PLURNK_CLIENT_TEST", "optional"), false));
});
