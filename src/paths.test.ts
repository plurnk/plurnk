import assert from "node:assert/strict";
import test from "node:test";
import { homePath, userConfigFile } from "./paths.ts";

test("[§cli-workspaces-and-workers] directory names shorten only the complete home prefix", () => {
    for (const [path, expected] of [
        ["/home/ada", "~"],
        ["/home/ada/projects/client", "~/projects/client"],
        ["/home/ada/my project/日本語", "~/my project/日本語"],
        ["/home/adam/project", "/home/adam/project"],
        ["/srv/project", "/srv/project"],
        ["~/project", "~/project"],
        ["myProject", "myProject"],
    ]) assert.equal(homePath(path, "/home/ada"), expected);
    assert.equal(homePath("/app", "/"), "~/app", "home may be the container root");
    assert.equal(homePath("/", "/"), "~");
});

test("userConfigFile follows the XDG configuration convention", () => {
    assert.equal(userConfigFile({}, "/home/ada"), "/home/ada/.config/plurnk/.env");
    assert.equal(userConfigFile({ XDG_CONFIG_HOME: "/cfg" }, "/home/ada"), "/cfg/plurnk/.env");
    assert.equal(
        userConfigFile({ XDG_CONFIG_HOME: "relative" }, "/home/ada"),
        "/home/ada/.config/plurnk/.env",
        "a relative XDG base is ignored rather than resolved against CWD",
    );
});
