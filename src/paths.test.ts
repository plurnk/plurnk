import assert from "node:assert/strict";
import test from "node:test";
import { userConfigFile } from "./paths.ts";

test("userConfigFile follows the XDG configuration convention", () => {
    assert.equal(userConfigFile({}, "/home/ada"), "/home/ada/.config/plurnk/.env");
    assert.equal(userConfigFile({ XDG_CONFIG_HOME: "/cfg" }, "/home/ada"), "/cfg/plurnk/.env");
    assert.equal(
        userConfigFile({ XDG_CONFIG_HOME: "relative" }, "/home/ada"),
        "/home/ada/.config/plurnk/.env",
        "a relative XDG base is ignored rather than resolved against CWD",
    );
});
