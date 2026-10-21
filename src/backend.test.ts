import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import Backend, { isLoopback, listenerPresent, serviceInstallation } from "./backend.ts";
import { ProblemError } from "./diagnostics.ts";

const env = {
    PLURNK_CLIENT_AUTOSTART: "1", PLURNK_CLIENT_DAEMON_TIMEOUT_MS: "1000",
    PLURNK_CLIENT_SERVICE_BIN: "/nonexistent/plurnk-service", PATH: "",
};

// A loopback port nothing listens on: bound, then released.
const refusedPort = async (): Promise<number> => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return address.port;
};

test("[§cli-daemon-autostart] only loopback destinations are eligible", () => {
    for (const value of ["localhost", "127.0.0.1", "127.45.67.89", "::1", "[::1]"]) assert.equal(isLoopback(value), true, value);
    for (const value of ["example.com", "localhost.example.com", "192.168.1.1", "0.0.0.0", "[::]"]) assert.equal(isLoopback(value), false, value);
});

test("[§cli-daemon-autostart] remote, portal and attach-only targets do not resolve or start a package", async () => {
    const port = await refusedPort();
    for (const [aguiUrl, overrides] of [
        ["https://example.invalid", {}],
        [`http://127.0.0.1:${port}`, { PLURNK_AGUI_URL: `http://127.0.0.1:${port}` }],
        [`http://127.0.0.1:${port}`, { PLURNK_CLIENT_AUTOSTART: "0" }],
    ] as const) {
        const target = { aguiUrl, token: "existing-token" };
        const backend = await Backend.open(target, { ...env, ...overrides });
        assert.deepEqual(backend.target, target);
        assert.equal(backend.started, null, "attaching starts nothing");
    }
});

test("[§cli-daemon-autostart] a live listener is attached even when it is not an AG-UI server", async () => {
    // It drains what it is sent, as any listener does, then hangs up.
    const server = createServer((socket) => { socket.resume(); socket.end(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
        const address = server.address();
        assert.ok(address !== null && typeof address === "object");
        const target = { aguiUrl: `http://127.0.0.1:${address.port}` };
        const backend = await Backend.open(target, env);
        assert.deepEqual(backend.target, target, "protocol/authentication remain the AG-UI caller's decision");
        assert.equal(backend.started, null);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("[§cli-daemon-autostart] autostart refuses port 0, which no later client could reach", async () => {
    await assert.rejects(Backend.open({ aguiUrl: "http://127.0.0.1:0" }, env), (cause) => cause instanceof ProblemError
        && cause.exitCode === 64 && cause.problem.kind === "port-unshareable");
});

test("[§cli-daemon-autostart] connection refusal is distinct from other network errors", async () => {
    assert.equal(await listenerPresent(new URL(`http://127.0.0.1:${await refusedPort()}`), 1000), false);
    await assert.rejects(listenerPresent(new URL("http://256.256.256.256.invalid:1066"), 1000));
});

test("[§cli-daemon-autostart] an explicitly missing installation fails without substituting a different one", async () => {
    await assert.rejects(serviceInstallation(env), (cause) => cause instanceof ProblemError
        && cause.exitCode === 127 && cause.problem.kind === "not-installed"
        && cause.problem.detail.includes(env.PLURNK_CLIENT_SERVICE_BIN));
});
