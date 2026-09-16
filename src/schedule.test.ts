import { test } from "node:test";
import assert from "node:assert/strict";
import { composeDefinition, handleSchedule } from "./schedule.ts";

const harness = (results: Record<string, unknown> = {}) => {
    const calls: Array<{ method: string; params?: object }> = [];
    const out: string[] = [];
    const rpc = {
        call: async (method: string, params?: object) => {
            calls.push({ method, params });
            return results[method] ?? {};
        },
    };
    return { rpc, write: (text: string) => out.push(text), calls, out };
};

const RULE = "DTSTART;TZID=UTC:20260916T123016\nRRULE:FREQ=HOURLY;COUNT=2";

test("[§cli-schedule] list renders every rule's state, wording, next occurrence and target from the workspace's schedule family", async () => {
    const h = harness({
        "workspace.schedule.list": {
            definitions: [
                { alias: "beat", origin: "workspace", state: "active", definition: { rule: RULE, target: "worker://scribe", prompt: "Beat." }, detail: { rule: RULE, zone: "UTC", text: "every hour for 2 times", next: "2026-09-16T12:30:16+00:00[UTC]", exhausted: false, target: "worker://scribe" } },
                { alias: "heartbeat", origin: "service", state: "disabled", definition: { rule: RULE, target: "worker://plurnkbot", prompt: "Check in." } },
                { alias: "once", origin: "workspace", state: "active", definition: { rule: RULE, target: "worker://scribe", prompt: "Once." }, detail: { text: "every day for 1 time", next: null, exhausted: true } },
                { alias: "ghost", origin: "workspace", state: "unavailable", definition: { rule: RULE, target: "worker://gone", prompt: "x" }, problem: { detail: "No worker named 'gone' exists in this workspace." } },
            ],
        },
    });
    await handleSchedule([], h.rpc, h.write);
    assert.deepEqual(h.calls, [{ method: "workspace.schedule.list", params: {} }]);
    const text = h.out.join("");
    assert.match(text, /beat\s+active\s+every hour for 2 times\s+next 2026-09-16T12:30:16\+00:00\[UTC\]\s+worker:\/\/scribe/u);
    assert.match(text, /heartbeat\s+disabled\s+worker:\/\/plurnkbot\s+\(service\)/u);
    assert.match(text, /once\s+active\s+every day for 1 time\s+exhausted/u);
    assert.match(text, /ghost\s+unavailable\s+worker:\/\/gone\s+— No worker named 'gone' exists in this workspace\./u);
    const empty = harness({ "workspace.schedule.list": { definitions: [] } });
    await handleSchedule("", empty.rpc, empty.write);
    assert.match(empty.out.join(""), /schedules: none/u);
});

test("[§cli-schedule] discover sends the rule text and renders the inert candidate that tells the time", async () => {
    const h = harness({
        "workspace.schedule.discover": { candidates: [{ alias: "hourly", summary: "now 2026-09-16T12:30:15+00:00[UTC]; every hour for 2 times; next 2026-09-16T12:30:16+00:00[UTC], 2026-09-16T13:30:16+00:00[UTC]", definition: { rule: RULE }, provenance: { kind: "rule", source: "FREQ=HOURLY;COUNT=2" } }] },
    });
    await handleSchedule("discover FREQ=HOURLY;COUNT=2", h.rpc, h.write);
    assert.deepEqual(h.calls, [{ method: "workspace.schedule.discover", params: { source: "FREQ=HOURLY;COUNT=2" } }]);
    const text = h.out.join("");
    assert.match(text, /hourly\s+candidate\s+now 2026-09-16T12:30:15\+00:00\[UTC\]; every hour for 2 times/u);
    assert.match(text, /\n    DTSTART;TZID=UTC:20260916T123016\n    RRULE:FREQ=HOURLY;COUNT=2\n/u);
    const bare = harness();
    assert.equal(await handleSchedule("discover", bare.rpc, bare.write), null);
    assert.match(bare.out.join(""), /usage: \/schedule discover <rule>/u);
});

test("[§cli-schedule] add composes one exact definition; enable, disable, and remove map to workspace actions", async () => {
    assert.deepEqual(composeDefinition("scribe", "FREQ=DAILY;COUNT=3", "Summarize.", false), { rule: "FREQ=DAILY;COUNT=3", target: "worker://scribe", prompt: "Summarize." });
    assert.deepEqual(composeDefinition("worker://scribe", "FREQ=DAILY;COUNT=3", "Summarize.", true), { rule: "FREQ=DAILY;COUNT=3", target: "worker://scribe", prompt: "Summarize.", policy: { proposals: "accept" } });
    const h = harness({
        "workspace.schedule.add": { status: 201, alias: "standup", definition: { alias: "standup", state: "active", detail: { next: "2026-09-17T09:00:00+00:00[UTC]" } } },
        "workspace.schedule.enable": { status: 200, alias: "standup", definition: { alias: "standup", state: "active" } },
        "workspace.schedule.disable": { status: 200, alias: "standup", definition: { alias: "standup", state: "disabled" } },
        "workspace.schedule.remove": { status: 200, alias: "standup", removed: true },
    });
    await handleSchedule("add --accept standup scribe FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0;COUNT=20 Summarize the log for the team.", h.rpc, h.write);
    await handleSchedule(["enable", "standup"], h.rpc, h.write);
    await handleSchedule("disable standup", h.rpc, h.write);
    await handleSchedule("remove standup", h.rpc, h.write);
    assert.deepEqual(h.calls, [
        { method: "workspace.schedule.add", params: { alias: "standup", definition: { rule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0;COUNT=20", target: "worker://scribe", prompt: "Summarize the log for the team.", policy: { proposals: "accept" } } } },
        { method: "workspace.schedule.enable", params: { alias: "standup" } },
        { method: "workspace.schedule.disable", params: { alias: "standup" } },
        { method: "workspace.schedule.remove", params: { alias: "standup" } },
    ]);
    const text = h.out.join("");
    assert.match(text, /added: standup \(active\)\s+next 2026-09-17T09:00:00\+00:00\[UTC\]/u);
    assert.match(text, /enabled: standup \(active\)/u);
    assert.match(text, /disabled: standup \(disabled\)/u);
    assert.match(text, /removed: standup/u);
});

test("[§cli-schedule] incomplete arguments print the exact usage and dispatch nothing", async () => {
    for (const line of ["add standup scribe FREQ=DAILY;COUNT=1", "add", "enable", "remove a b", "frobnicate"]) {
        const h = harness();
        assert.equal(await handleSchedule(line, h.rpc, h.write), null, line);
        assert.deepEqual(h.calls, [], line);
        assert.match(h.out.join(""), /usage: \/schedule/u, line);
    }
});
