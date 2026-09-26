import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionViaBridge } from "../../src/agui.ts";
import { shareFolder, type ShareResult } from "../../src/share.ts";
import { bootDaemon, locateDaemon } from "./harness.ts";

test("[§cli-invocation] workspace.share writes the bound workspace's share and its zip where the client names", { timeout: 60_000 }, async (t) => {
    const service = await locateDaemon();
    if (service === null) { t.skip("no plurnk-service binary reachable"); return; }
    const daemon = await bootDaemon(service, { readyTimeoutMs: 30_000 });
    t.after(daemon.cleanup);
    const root = await mkdtemp(join(tmpdir(), "plurnk-client-share-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    const name = `terminal-share-${crypto.randomUUID()}`;
    await actionViaBridge({ bridgeUrl: daemon.url }, { threadId: "terminal-share", kind: "workspace.create", params: { name, projectRoot: null } });
    const folder = shareFolder("report", root);
    const shared = await actionViaBridge<ShareResult>(
        { bridgeUrl: daemon.url },
        { threadId: name, workspace: name, kind: "workspace.share", params: { folder } },
    );

    assert.deepEqual(shared, { folder, zip: `${folder}.zip` });
    assert.ok(existsSync(shared.zip));
    const digest = JSON.parse(readFileSync(join(folder, "digest.json"), "utf8")) as { workspaces: Array<{ name: string }> };
    assert.deepEqual(digest.workspaces.map(({ name: shareName }) => shareName), [name]);
});
