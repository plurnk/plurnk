import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ProjectRoot from "./project-root.ts";
import { ProblemError } from "./diagnostics.ts";

const workspaceListResponse = (init: RequestInit, workspaces: Record<string, unknown>[]): Response => {
    const { threadId, runId, forwardedProps } = JSON.parse(String(init.body));
    assert.equal(forwardedProps.plurnk.action.kind, "workspace.list");
    return new Response([
        { type: "RUN_STARTED", threadId, runId },
        { type: "CUSTOM", name: "plurnk.action.result", value: {
            kind: "workspace.list", ok: true, result: { workspaces },
        } },
        { type: "RUN_FINISHED", threadId, runId },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
};

test("[§cli-project-root] implicit home detection resolves symlinks, while explicit choices remain explicit", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "plurnk-project-root-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = join(root, "home");
    const link = join(root, "home-link");
    const project = join(root, "project");
    await Promise.all([mkdir(home), mkdir(project)]);
    await symlink(home, link);
    const target = { aguiUrl: "http://unused.invalid" };
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => workspaceListResponse(init, []));
    for (const cwd of [home, link]) {
        const roots = new ProjectRoot(target, undefined, cwd, home);
        await assert.rejects(roots.resolve(undefined), (cause: unknown) => cause instanceof ProblemError
            && cause.exitCode === 64 && cause.problem.type === "https://problems.plurnk.xyz/client/project-root/required");
        assert.equal(await roots.resolve(undefined, async () => undefined), undefined, "cancellation is not a root choice");
        await assert.rejects(roots.resolve(undefined), ProblemError);
        assert.equal(await roots.resolve(undefined, async () => project), project);
        assert.equal(await roots.resolve("another"), project, "a chosen folder becomes the invocation's creation default");
    }
    for (const raw of [home, "", project]) {
        assert.equal(await new ProjectRoot(target, raw, home, home).resolve("named"), raw || null);
    }
    assert.equal(await new ProjectRoot(target, undefined, project, home).resolve(undefined), project);
});

test("[§cli-project-root] resumption reads the stored root without accepting it as a creation default", async (t) => {
    const home = await mkdtemp(join(tmpdir(), "plurnk-project-root-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    let existing: Record<string, unknown>[] = [{ name: "saved" }];
    t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => workspaceListResponse(init, existing));
    const roots = new ProjectRoot({ aguiUrl: "http://fixture.invalid" }, undefined, home, home);
    await assert.rejects(roots.resolve("saved"), /workspace.list returned a workspace without its project_root/);
    for (const project_root of [null, "/saved-project"]) {
        existing = [{ name: "saved", project_root }];
        assert.equal(await roots.resolve("saved"), project_root);
        for (const raw of [undefined, "", "/creation-default"]) {
            const selected = new ProjectRoot({ aguiUrl: "http://fixture.invalid" }, raw, tmpdir(), home);
            assert.equal(await selected.resolve("saved"), project_root, "saved roots outrank launch directories and creation defaults");
        }
        await assert.rejects(roots.resolve(undefined), ProblemError, "resumption never silently selects a folder for a new workspace");
    }
    existing = [];
    await assert.rejects(roots.resolve("missing"), (cause: unknown) => cause instanceof ProblemError && cause.exitCode === 64);
});
