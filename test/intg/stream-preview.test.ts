import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { bootDaemon, completionsEndpoint, locateDaemon } from "./harness.ts";

const exec = promisify(execFile);
const bin = resolve(import.meta.dirname, "../../bin/plurnk.js");

test("[§cli-stream-event-and-stream-concluded] built one-shot and script clients show tiny outputs only in the text trace", { timeout: 60_000 }, async (t) => {
    const service = await locateDaemon();
    assert.ok(service);
    let calls = 0;
    const program = "````sh\nprintf 'preview-stdout\\n'; printf 'preview-stderr\\n' >&2\n````";
    const endpoint = await completionsEndpoint(() => ++calls === 1 ? program : "````KILL\nAnswer.\n````");
    t.after(endpoint.close);
    const daemon = await bootDaemon(service, { extraEnv: {
        PLURNK_MODEL: "previewfixture", PLURNK_MODEL_previewfixture: "openai/preview-fixture",
        PLURNK_BASEURL_previewfixture: endpoint.url, OPENAI_BASE_URL: endpoint.url, OPENAI_API_KEY: "fixture",
        PLURNK_PROVIDERS_CONTEXT_WINDOW: "32768", PLURNK_PROVIDERS_EFFORT: "off", PLURNK_PROVIDERS_RETRY_ATTEMPTS: "0",
    } });
    t.after(daemon.cleanup);
    t.after(() => { if (!t.passed) t.diagnostic(daemon.output()); });
    const env = {
        ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PLURNK_") && !key.endsWith("_API_KEY"))),
        HOME: daemon.home, XDG_CONFIG_HOME: join(daemon.home, ".config"), NO_COLOR: "1", PLURNK_AGUI_URL: daemon.url,
    };
    const run = (...args: string[]) => {
        const result = exec(process.execPath, [bin, "--yolo", "--no-git", "--max-turns", "5", ...args], { env, cwd: daemon.workspace, timeout: 25_000 });
        result.child.stdin?.end();
        return result;
    };
    const assertPreview = (stderr: string) => {
        assert.match(stderr, /^    preview-stdout$/mu);
        assert.match(stderr, /^    ! preview-stderr$/mu);
        assert.equal(stderr.match(/preview-stdout/gu)?.length, 1);
        assert.equal(stderr.match(/preview-stderr/gu)?.length, 1);
    };
    const text = await run("--workspace", "preview-text", "Perform the fixture.");
    assert.equal(text.stdout, "Answer.\n");
    assertPreview(text.stderr);
    calls = 0;
    const json = await run("--workspace", "preview-json", "--json", "Perform the fixture.");
    assert.equal(JSON.parse(json.stdout).response, "Answer.");
    assert.doesNotMatch(json.stderr, /preview-stdout|preview-stderr/);
    const script = join(daemon.workspace, "preview.plk");
    await writeFile(script, program);
    const scripted = await run("--workspace", "preview-script", "script", script);
    assert.equal(scripted.stdout, "");
    assertPreview(scripted.stderr);
});
