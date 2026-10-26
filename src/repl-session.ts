// Five-stream contract ([stdin, stdout, stderr, events, reasoning], fd 0..4) and
// interactive REPL engine ({§cli-output-channels}, {§cli-repl-mode}, {§cli-tui-mode}).

import { createHash } from "node:crypto";
import { existsSync, fstatSync, readFileSync, statSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import * as readline from "node:readline";
import { PassThrough, Writable } from "node:stream";
import {
    CreateElicitationRequest,
    SessionConfigOption,
    SessionUpdate,
    ToolCallContent,
    type CreateElicitationResponse,
    type ElicitationContentValue,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { AcpClient } from "./acp-client.ts";
import { AcpSession, contentBlockToText } from "./acp-session.ts";
import {
    ensureDaemonConnected,
    formatConfigOption,
    openCliSession,
    type CliCommonOptions,
} from "./cli-runner.ts";
import { INTERACTIVE_COMMANDS, renderCommandReference } from "./commands.ts";
import { SessionPresenter, lifecycleGlyphFor } from "./session-presenter.ts";

export interface ClientStreams {
    readonly stdin: NodeJS.ReadableStream;
    readonly stdout: NodeJS.WritableStream;
    readonly stderr: NodeJS.WritableStream;
    readonly events: NodeJS.WritableStream;
    readonly reasoning: NodeJS.WritableStream;
}

const createNoopWritable = (): Writable =>
    new Writable({
        write(_chunk, _encoding, callback) {
            callback();
        },
    });

const createFdWritable = (fd: number): Writable => {
    try {
        const stat = fstatSync(fd);
        if (!stat.isFIFO() && !stat.isSocket() && !stat.isFile() && !stat.isCharacterDevice()) {
            return createNoopWritable();
        }
    } catch {
        return createNoopWritable();
    }
    return new Writable({
        write(chunk: Buffer | string, encoding, callback) {
            try {
                const buf = Buffer.isBuffer(chunk)
                    ? chunk
                    : Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8");
                writeSync(fd, buf);
                callback();
            } catch (err) {
                const code = (err as NodeJS.ErrnoException)?.code;
                if (code === "EBADF" || code === "EPIPE" || code === "EINVAL") {
                    callback();
                    return;
                }
                callback(err instanceof Error ? err : new Error(String(err)));
            }
        },
    });
};

export const openProcessStreams = (overrides?: Partial<ClientStreams>): ClientStreams => ({
    stdin: overrides?.stdin ?? process.stdin,
    stdout: overrides?.stdout ?? process.stdout,
    stderr: overrides?.stderr ?? process.stderr,
    events: overrides?.events ?? createFdWritable(3),
    reasoning: overrides?.reasoning ?? createFdWritable(4),
});

export const writeEventJsonl = (events: NodeJS.WritableStream, payload: unknown): void => {
    events.write(`${JSON.stringify(payload)}\n`);
};

export const writeErrorJsonl = (stderr: NodeJS.WritableStream, payload: unknown): void => {
    stderr.write(`${JSON.stringify(payload)}\n`);
};

export const mintGateHash = (sessionId: string, kind: string, seq: number): string =>
    createHash("sha256")
        .update(`${sessionId}:${kind}:${String(seq)}:${String(Date.now())}`)
        .digest("hex")
        .slice(0, 8);

interface PendingPermissionGate {
    readonly kind: "permission";
    readonly id: string;
    readonly sessionId: string;
    readonly request: RequestPermissionRequest;
    readonly resolveGate: (res: RequestPermissionResponse) => void;
}

interface PendingElicitationGate {
    readonly kind: "elicitation";
    readonly id: string;
    readonly sessionId: string;
    readonly request: CreateElicitationRequest;
    readonly resolveGate: (res: CreateElicitationResponse) => void;
}

type PendingGate = PendingPermissionGate | PendingElicitationGate;

const extractOpenPaths = (promptText: string, projectRoot: string | undefined): string[] => {
    if (!projectRoot || projectRoot.length === 0) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const match of promptText.matchAll(/(?:^|\s)@([^\s]+)/gu)) {
        const rawToken = match[1]?.replace(/[.,;:!?)]+$/u, "") ?? "";
        if (rawToken.length === 0) continue;
        const candidate = resolve(projectRoot, rawToken);
        const rel = relative(projectRoot, candidate);
        if (rel.startsWith("..") || rel.length === 0) continue;
        try {
            if (existsSync(candidate) && statSync(candidate).isFile()) {
                if (!seen.has(rel)) {
                    seen.add(rel);
                    result.push(rel);
                }
            }
        } catch {
            // ignore inaccessible paths
        }
    }
    return result;
};

const formatFamilyRows = (family: string, result: Record<string, unknown>): string => {
    const definitions = Array.isArray(result.definitions)
        ? result.definitions
        : Array.isArray(result.items)
          ? result.items
          : [];
    if (definitions.length === 0) {
        return `${family}: none\n`;
    }
    const lines: string[] = [];
    for (const item of definitions) {
        const d = item as Record<string, unknown>;
        const alias = String(d.alias ?? d.name ?? d.glob ?? "");
        const state = String(d.state ?? "active");
        const def = (d.definition ?? {}) as Record<string, unknown>;
        const type = typeof def.type === "string" ? def.type : "";
        const target =
            typeof def.command === "string"
                ? def.command
                : typeof def.url === "string"
                  ? def.url
                  : typeof def.source === "string"
                    ? def.source
                    : typeof def.value === "string"
                      ? def.value
                      : "";
        const prov = (d.provenance ?? {}) as Record<string, unknown>;
        const source = typeof prov.source === "string" ? `source=${prov.source}` : "";
        const rowParts = [alias, state, type, target, source].filter((p) => p.length > 0);
        lines.push(rowParts.join("  "));
    }
    return `${lines.join("\n")}\n`;
};

export const runReplSession = async (
    options: CliCommonOptions,
    customStreams?: Partial<ClientStreams>,
): Promise<number> => {
    const streams = openProcessStreams(customStreams);
    let currentWorkspace = options.workspace ?? "default";
    let currentSessionName = options.sessionId ?? options.tuiSession ?? "user";
    let currentProjectRoot = options.projectRoot ?? options.cwd;
    let currentYolo = options.yolo;
    let forceReviewNextRun = false;
    let gateSeq = 0;
    let reasoningOpenOnLine = false;
    let currentLifecycle = "idle";
    const pendingGates = new Map<string, PendingGate>();

    const flushReasoningNewline = (): void => {
        if (reasoningOpenOnLine) {
            streams.reasoning.write("\n");
            reasoningOpenOnLine = false;
        }
    };

    const emitSessionBound = (session: AcpSession): void => {
        const plurnk = (session.meta?.plurnk ?? undefined) as Record<string, unknown> | undefined;
        const ws = (plurnk?.workspace ?? undefined) as Record<string, unknown> | undefined;
        if (typeof ws?.name === "string" && ws.name.length > 0) {
            currentWorkspace = ws.name;
        }
        if (typeof ws?.projectRoot === "string") {
            currentProjectRoot = ws.projectRoot;
        }
        if (typeof plurnk?.sessionName === "string" && plurnk.sessionName.length > 0) {
            currentSessionName = plurnk.sessionName;
        } else if (session.sessionId.includes("#")) {
            currentSessionName = session.sessionId.slice(session.sessionId.indexOf("#") + 1);
        }
        writeEventJsonl(streams.events, {
            sessionUpdate: "session_bound",
            sessionId: session.sessionId,
            workspace: currentWorkspace,
            session: currentSessionName,
            cwd: currentProjectRoot,
            configOptions: session.configOptions,
            ...(session.meta !== undefined ? { _meta: session.meta } : {}),
        });
    };

    const handleSessionUpdate = (update: SessionUpdate): void => {
        if (SessionUpdate.isAgentThoughtChunk(update)) {
            const delta = contentBlockToText(update.content);
            if (delta.length > 0) {
                streams.reasoning.write(delta);
                reasoningOpenOnLine = !delta.endsWith("\n");
            }
            return;
        }

        if (SessionUpdate.isAgentMessageChunk(update)) {
            flushReasoningNewline();
            const text = contentBlockToText(update.content);
            if (text.length > 0) {
                streams.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
            }
            return;
        }

        if (SessionUpdate.isToolCallUpdate(update)) {
            flushReasoningNewline();
            writeEventJsonl(streams.events, update);
            return;
        }

        if (SessionUpdate.isNotice(update)) {
            const rawNotice = (
                update._meta as { plurnk?: { notice?: Record<string, unknown> } } | undefined
            )?.plurnk?.notice;
            if (rawNotice?.kind === "loop_status") {
                if (rawNotice.status === 202) {
                    currentLifecycle = "parked";
                } else if (rawNotice.status === 102) {
                    currentLifecycle = "running";
                } else if (rawNotice.status === 100) {
                    currentLifecycle = "queued";
                }
            }
            if (update.severity === "error") {
                writeErrorJsonl(streams.stderr, update);
            }
            writeEventJsonl(streams.events, update);
            return;
        }

        if (SessionUpdate.isStateUpdate(update)) {
            if (update.state === "running") {
                currentLifecycle = "running";
            } else if (update.state === "requires_action") {
                currentLifecycle = "parked";
            } else if (update.state === "idle") {
                flushReasoningNewline();
                forceReviewNextRun = false;
                const termMeta = (
                    update._meta as
                        | {
                              plurnk?: {
                                  terminal?: {
                                      status?: number;
                                      problem?: Record<string, unknown>;
                                  };
                              };
                          }
                        | undefined
                )?.plurnk?.terminal;
                const status =
                    typeof termMeta?.status === "number"
                        ? termMeta.status
                        : update.stopReason === "error" || update.stopReason === "refusal"
                          ? 500
                          : update.stopReason === "cancelled"
                            ? 499
                            : 200;
                currentLifecycle = status >= 400 ? (status === 499 ? "cancelled" : "failed") : "idle";
                if (termMeta?.problem !== undefined) {
                    writeErrorJsonl(streams.stderr, termMeta.problem);
                }
            }
            writeEventJsonl(streams.events, update);
            return;
        }

        writeEventJsonl(streams.events, update);
    };

    let activeSession: AcpSession | null = null;

    const client = new AcpClient({
        url: options.url,
        credential: options.credential,
        env: options.env,
        onPermissionRequest: async (request, signal): Promise<RequestPermissionResponse> => {
            if (signal.aborted) {
                return { outcome: { outcome: "cancelled" } };
            }
            gateSeq += 1;
            const id = mintGateHash(activeSession?.sessionId ?? currentSessionName, "permission", gateSeq);
            writeEventJsonl(streams.events, {
                ...request,
                sessionUpdate: "permission_request",
                id,
                sessionId: activeSession?.sessionId ?? currentSessionName,
            });

            if ((currentYolo || options.auto) && !forceReviewNextRun) {
                const allowOption =
                    request.options.find((opt) => opt.kind === "allow_once" || opt.kind === "allow_always") ??
                    request.options[0];
                const outcome: RequestPermissionResponse["outcome"] =
                    allowOption !== undefined
                        ? { outcome: "selected", optionId: allowOption.optionId }
                        : { outcome: "cancelled" };
                writeEventJsonl(streams.events, {
                    sessionUpdate: "gate_resolved",
                    id,
                    outcome,
                });
                return { outcome };
            }

            return await new Promise<RequestPermissionResponse>((resolveGate) => {
                const finishGate = (res: RequestPermissionResponse, reason?: string): void => {
                    if (!pendingGates.has(id)) return;
                    pendingGates.delete(id);
                    writeEventJsonl(streams.events, {
                        sessionUpdate: "gate_resolved",
                        id,
                        outcome: res.outcome,
                        ...(reason !== undefined ? { reason } : {}),
                    });
                    resolveGate(res);
                };
                const onAbort = (): void => {
                    finishGate({ outcome: { outcome: "cancelled" } }, "settled_elsewhere");
                };
                signal.addEventListener("abort", onAbort, { once: true });
                pendingGates.set(id, {
                    kind: "permission",
                    id,
                    sessionId: activeSession?.sessionId ?? currentSessionName,
                    request,
                    resolveGate: (res) => {
                        signal.removeEventListener("abort", onAbort);
                        finishGate(res);
                    },
                });
            });
        },
        onElicitationRequest: async (request, signal): Promise<CreateElicitationResponse> => {
            if (signal.aborted) {
                return { action: "cancel" };
            }
            gateSeq += 1;
            const id = mintGateHash(activeSession?.sessionId ?? currentSessionName, "elicitation", gateSeq);
            writeEventJsonl(streams.events, {
                sessionUpdate: "elicitation_request",
                id,
                sessionId: activeSession?.sessionId ?? currentSessionName,
                mode: CreateElicitationRequest.isUrl(request) ? "url" : "form",
                message: request.message,
                ...(CreateElicitationRequest.isForm(request) ? { requestedSchema: request.requestedSchema } : {}),
                ...(CreateElicitationRequest.isUrl(request) ? { url: request.url } : {}),
                ...(request._meta !== undefined ? { _meta: request._meta } : {}),
            });

            if (options.auto) {
                const outcome: CreateElicitationResponse = { action: "decline" };
                writeEventJsonl(streams.events, {
                    sessionUpdate: "gate_resolved",
                    id,
                    outcome,
                });
                return outcome;
            }

            return await new Promise<CreateElicitationResponse>((resolveGate) => {
                const finishGate = (res: CreateElicitationResponse, reason?: string): void => {
                    if (!pendingGates.has(id)) return;
                    pendingGates.delete(id);
                    writeEventJsonl(streams.events, {
                        sessionUpdate: "gate_resolved",
                        id,
                        outcome: res,
                        ...(reason !== undefined ? { reason } : {}),
                    });
                    resolveGate(res);
                };
                const onAbort = (): void => {
                    finishGate({ action: "cancel" }, "settled_elsewhere");
                };
                signal.addEventListener("abort", onAbort, { once: true });
                pendingGates.set(id, {
                    kind: "elicitation",
                    id,
                    sessionId: activeSession?.sessionId ?? currentSessionName,
                    request,
                    resolveGate: (res) => {
                        signal.removeEventListener("abort", onAbort);
                        finishGate(res);
                    },
                });
            });
        },
    });

    await ensureDaemonConnected(client, options);

    const bindSession = async (workspaceName: string | undefined, sessionName: string): Promise<AcpSession> => {
        const nextSession = await openCliSession(
            client,
            {
                ...options,
                ...(workspaceName !== undefined ? { workspace: workspaceName } : {}),
                sessionId: sessionName,
            },
            handleSessionUpdate,
        );
        activeSession = nextSession;
        emitSessionBound(nextSession);
        return nextSession;
    };

    let session = await bindSession(options.workspace, currentSessionName);
    streams.stdout.write(`workspace: ${currentWorkspace}\n`);

    const findGate = (maybeId: string | undefined): { readonly gate: PendingGate | undefined; readonly consumedId: boolean } => {
        if (maybeId !== undefined && pendingGates.has(maybeId)) {
            return { gate: pendingGates.get(maybeId), consumedId: true };
        }
        if (maybeId !== undefined && /^[0-9a-f]{8}$/iu.test(maybeId)) {
            return { gate: undefined, consumedId: true };
        }
        const first = pendingGates.values().next().value as PendingGate | undefined;
        return { gate: first, consumedId: false };
    };

    const bindingContext = () => ({
        sessionId: session.sessionId,
        workspace: currentWorkspace,
        session: currentSessionName,
    });

    const handleFamilyCommand = async (family: string, args: readonly string[]): Promise<void> => {
        let scopePrefix = family === "env" ? "session" : "workspace";
        const filteredArgs: string[] = [];
        for (let i = 0; i < args.length; i += 1) {
            const tok = args[i]!;
            if (tok === "--scope" && args[i + 1]) {
                scopePrefix = args[i + 1] === "workspace" ? "workspace" : "session";
                i += 1;
                continue;
            }
            if (tok.startsWith("--scope=")) {
                scopePrefix = tok.slice("--scope=".length) === "workspace" ? "workspace" : "session";
                continue;
            }
            filteredArgs.push(tok);
        }
        const sub = filteredArgs[0] ?? "list";
        const rest = filteredArgs.slice(1);

        if (sub === "list") {
            const result = await client.action<Record<string, unknown>>(
                `${scopePrefix}.${family}.list`,
                {},
                bindingContext(),
            );
            streams.stdout.write(formatFamilyRows(family, result));
            return;
        }
        if (sub === "discover") {
            const query = rest.join(" ");
            const result = await client.action<Record<string, unknown>>(
                `${scopePrefix}.${family}.discover`,
                query.length > 0 ? { query, source: query } : {},
                bindingContext(),
            );
            streams.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
            return;
        }
        if (sub === "enable" || sub === "disable" || sub === "remove") {
            const target = rest[0] ?? "";
            const param = family === "members" ? { file: target } : { alias: target };
            const result = await client.action<Record<string, unknown>>(
                `${scopePrefix}.${family}.${sub}`,
                param,
                bindingContext(),
            );
            streams.stdout.write(`${JSON.stringify(result)}\n`);
            return;
        }
        if ((sub === "add" || sub === "replace") && family === "mcp") {
            const alias = rest[0] ?? "";
            const target = rest[1] ?? "";
            const extraArgs = rest.slice(2);
            const definition = /^https?:\/\//iu.test(target)
                ? { name: alias, type: "streamable-http", url: target }
                : {
                      name: alias,
                      type: "stdio",
                      command: target,
                      ...(extraArgs.length > 0 ? { args: extraArgs } : {}),
                  };
            const result = await client.action<Record<string, unknown>>(
                `workspace.mcp.${sub}`,
                { alias, definition },
                bindingContext(),
            );
            streams.stdout.write(`${JSON.stringify(result)}\n`);
            return;
        }
        if ((sub === "add" || sub === "replace") && family === "skills") {
            const alias = rest[0] ?? "";
            const source = rest[1] ?? "";
            const refIdx = rest.indexOf("--ref");
            const ref = refIdx >= 0 ? rest[refIdx + 1] : undefined;
            const definition = {
                name: alias,
                source,
                ...(ref !== undefined ? { ref } : {}),
            };
            const result = await client.action<Record<string, unknown>>(
                `workspace.skills.${sub}`,
                { alias, definition },
                bindingContext(),
            );
            streams.stdout.write(`${JSON.stringify(result)}\n`);
            return;
        }
        if (sub === "add" && family === "members") {
            const result = await client.action<Record<string, unknown>>(
                "workspace.members.add",
                { files: rest },
                bindingContext(),
            );
            streams.stdout.write(`${JSON.stringify(result)}\n`);
            return;
        }
        if ((sub === "add" || sub === "replace") && family === "env") {
            const alias = rest[0] ?? "";
            const value = rest.slice(1).join(" ");
            const result = await client.action<Record<string, unknown>>(
                `${scopePrefix}.env.${sub}`,
                { alias, definition: { value } },
                bindingContext(),
            );
            streams.stdout.write(`${JSON.stringify(result)}\n`);
            return;
        }
        const result = await client.action<Record<string, unknown>>(
            `${scopePrefix}.${family}.${sub}`,
            rest.length > 0 ? { args: rest } : {},
            bindingContext(),
        );
        streams.stdout.write(`${JSON.stringify(result)}\n`);
    };

    const navigateTopology = async (direction: "parent" | "enter" | "older" | "newer"): Promise<void> => {
        const res = await client.action<{
            readonly sessions?: ReadonlyArray<{
                readonly id?: number;
                readonly name: string;
                readonly parentSessionId?: number | null;
                readonly parent_session_id?: number | null;
                readonly origin?: string;
            }>;
        }>("workspace.sessions", {}, bindingContext());
        const sessions = (res.sessions ?? []).filter((s) => s.origin !== "maintenance" && s.origin !== "scratch");
        const parentOf = (s: { readonly parentSessionId?: number | null; readonly parent_session_id?: number | null } | undefined): number | null =>
            s?.parentSessionId ?? s?.parent_session_id ?? null;
        const current = sessions.find((s) => s.name === currentSessionName);
        if (direction === "parent") {
            const pid = parentOf(current);
            if (!current || pid === null) {
                streams.stdout.write("(at the root: no parent)\n");
                return;
            }
            const parent = sessions.find((s) => s.id === pid);
            if (!parent) {
                streams.stdout.write("(at the root: no parent)\n");
                return;
            }
            session = await bindSession(currentWorkspace, parent.name);
            streams.stdout.write(`session: ${currentSessionName} (bound)\n`);
            return;
        }
        if (direction === "enter") {
            const children = current?.id !== undefined ? sessions.filter((s) => parentOf(s) === current.id) : [];
            const newest = children.at(-1);
            if (!newest) {
                streams.stdout.write("(no children)\n");
                return;
            }
            session = await bindSession(currentWorkspace, newest.name);
            streams.stdout.write(`session: ${currentSessionName} (bound)\n`);
            return;
        }
        const parentId = parentOf(current);
        const siblings = sessions.filter((s) => parentOf(s) === parentId);
        if (siblings.length <= 1) {
            streams.stdout.write("(no siblings)\n");
            return;
        }
        const idx = siblings.findIndex((s) => s.name === currentSessionName);
        const nextIdx =
            direction === "older"
                ? (idx - 1 + siblings.length) % siblings.length
                : (idx + 1) % siblings.length;
        const target = siblings[nextIdx]!;
        session = await bindSession(currentWorkspace, target.name);
        streams.stdout.write(`session: ${currentSessionName} (bound)\n`);
    };

    const dispatchLine = async (rawLine: string): Promise<"continue" | "quit"> => {
        const line = rawLine.trim();
        if (line.length === 0) return "continue";

        if (line === "/quit" || line === "/exit") {
            return "quit";
        }

        if (line === "/stop") {
            await client
                .cancel(session.sessionId)
                .then(() => {
                    streams.stdout.write("cancelled (final 499)\n");
                })
                .catch(() => {
                    streams.stdout.write("cancelled (final 499)\n");
                });
            return "continue";
        }

        if (line.startsWith("/")) {
            const parts = line.slice(1).split(/\s+/u);
            const cmd = parts[0]?.toLowerCase() ?? "";
            const args = parts.slice(1);

            try {
                if (cmd === "help") {
                    const topic = args[0]?.replace(/^\//u, "").toLowerCase();
                    if (topic) {
                        const matches = INTERACTIVE_COMMANDS.filter((c) =>
                            c.usage.toLowerCase().startsWith(`/${topic}`),
                        );
                        if (matches.length > 0) {
                            for (const m of matches) {
                                streams.stdout.write(`${m.usage.padEnd(30, " ")} ${m.summary}\n`);
                            }
                            return "continue";
                        }
                    }
                    streams.stdout.write(`${renderCommandReference()}\n`);
                    return "continue";
                }

                if (cmd === "yolo") {
                    currentYolo = !currentYolo;
                    streams.stdout.write(`yolo: ${currentYolo ? "on" : "off"}\n`);
                    return "continue";
                }

                if (cmd === "review") {
                    if (pendingGates.size === 0) {
                        streams.stdout.write("review: none\n");
                        return "continue";
                    }
                    for (const gate of pendingGates.values()) {
                        if (gate.kind === "permission") {
                            const opts = gate.request.options.map((o) => o.optionId).join(", ");
                            streams.stdout.write(`${gate.id}  permission  ${gate.request.title}  [${opts}]\n`);
                        } else {
                            streams.stdout.write(`${gate.id}  elicitation  ${gate.request.message}\n`);
                        }
                    }
                    return "continue";
                }

                if (cmd === "approve" || cmd === "accept") {
                    const { gate, consumedId } = findGate(args[0]);
                    if (!gate) {
                        writeErrorJsonl(streams.stderr, {
                            type: "https://problems.plurnk.xyz/client/gate-not-found",
                            title: "Gate not found",
                            status: 404,
                            detail: args[0] ? `No pending gate with id ${args[0]}.` : "No pending gate to approve.",
                        });
                        return "continue";
                    }
                    const explicitOptionId = consumedId ? args[1] : args[0];
                    if (gate.kind === "permission") {
                        const chosen =
                            (explicitOptionId
                                ? gate.request.options.find((o) => o.optionId === explicitOptionId)
                                : undefined) ??
                            gate.request.options.find(
                                (o) => o.kind === "allow_once" || o.kind === "allow_always",
                            ) ??
                            gate.request.options[0];
                        if (!chosen) {
                            gate.resolveGate({ outcome: { outcome: "cancelled" } });
                        } else {
                            gate.resolveGate({
                                outcome: { outcome: "selected", optionId: chosen.optionId },
                            });
                        }
                    } else {
                        gate.resolveGate({ action: "accept" });
                    }
                    streams.stdout.write(`approved ${gate.id}\n`);
                    return "continue";
                }

                if (cmd === "reject") {
                    const { gate, consumedId } = findGate(args[0]);
                    if (!gate) {
                        writeErrorJsonl(streams.stderr, {
                            type: "https://problems.plurnk.xyz/client/gate-not-found",
                            title: "Gate not found",
                            status: 404,
                            detail: args[0] ? `No pending gate with id ${args[0]}.` : "No pending gate to reject.",
                        });
                        return "continue";
                    }
                    const explicitOptionId = consumedId ? args[1] : args[0];
                    if (gate.kind === "permission") {
                        const chosen =
                            (explicitOptionId
                                ? gate.request.options.find((o) => o.optionId === explicitOptionId)
                                : undefined) ??
                            gate.request.options.find(
                                (o) => o.kind === "reject_once" || o.kind === "reject_always",
                            );
                        if (!chosen) {
                            gate.resolveGate({ outcome: { outcome: "cancelled" } });
                        } else {
                            gate.resolveGate({
                                outcome: { outcome: "selected", optionId: chosen.optionId },
                            });
                        }
                    } else {
                        gate.resolveGate({ action: "decline" });
                    }
                    streams.stdout.write(`rejected ${gate.id}\n`);
                    return "continue";
                }

                if (cmd === "cancel") {
                    const { gate } = findGate(args[0]);
                    if (!gate) {
                        writeErrorJsonl(streams.stderr, {
                            type: "https://problems.plurnk.xyz/client/gate-not-found",
                            title: "Gate not found",
                            status: 404,
                            detail: args[0] ? `No pending gate with id ${args[0]}.` : "No pending gate to cancel.",
                        });
                        return "continue";
                    }
                    if (gate.kind === "permission") {
                        gate.resolveGate({ outcome: { outcome: "cancelled" } });
                    } else {
                        gate.resolveGate({ action: "cancel" });
                    }
                    streams.stdout.write(`cancelled ${gate.id}\n`);
                    return "continue";
                }

                if (cmd === "edit") {
                    const { gate, consumedId } = findGate(args[0]);
                    if (!gate || gate.kind !== "permission") {
                        writeErrorJsonl(streams.stderr, {
                            type: "https://problems.plurnk.xyz/client/gate-not-found",
                            title: "Gate not found",
                            status: 404,
                            detail: "No pending permission gate to edit.",
                        });
                        return "continue";
                    }
                    const bodyTokens = consumedId ? args.slice(1) : args;
                    const editedBody = bodyTokens.join(" ");
                    const allowOpt =
                        gate.request.options.find(
                            (o) => o.kind === "allow_once" || o.kind === "allow_always",
                        ) ?? gate.request.options[0];
                    gate.resolveGate({
                        outcome: allowOpt
                            ? { outcome: "selected", optionId: allowOpt.optionId }
                            : { outcome: "cancelled" },
                        ...(editedBody.length > 0 ? { _meta: { plurnk: { body: editedBody } } } : {}),
                    } as RequestPermissionResponse);
                    streams.stdout.write(`edited ${gate.id}\n`);
                    return "continue";
                }

                if (cmd === "answer") {
                    const { gate, consumedId } = findGate(args[0]);
                    if (!gate || gate.kind !== "elicitation") {
                        writeErrorJsonl(streams.stderr, {
                            type: "https://problems.plurnk.xyz/client/gate-not-found",
                            title: "Gate not found",
                            status: 404,
                            detail: "No pending elicitation gate to answer.",
                        });
                        return "continue";
                    }
                    const rawPayload = (consumedId ? args.slice(1) : args).join(" ").trim();
                    let content: Record<string, unknown> = {};
                    if (rawPayload.length > 0) {
                        try {
                            const parsed = JSON.parse(rawPayload) as unknown;
                            content =
                                typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
                                    ? (parsed as Record<string, unknown>)
                                    : { answer: parsed };
                        } catch {
                            content = { answer: rawPayload };
                        }
                    }
                    gate.resolveGate({
                        action: "accept",
                        content: content as Record<string, ElicitationContentValue>,
                    });
                    streams.stdout.write(`answered ${gate.id}\n`);
                    return "continue";
                }

                if (cmd === "sessions") {
                    try {
                        const res = await client.action<{
                            readonly sessions?: ReadonlyArray<{
                                readonly name: string;
                                readonly lifecycle?: string;
                            }>;
                        }>("workspace.sessions", {}, bindingContext());
                        const list = res.sessions ?? [];
                        if (list.length === 0) {
                            const glyph =
                                currentLifecycle !== "idle" ? ` ${lifecycleGlyphFor(currentLifecycle)}` : "";
                            streams.stdout.write(`● ${currentSessionName}${glyph}\n`);
                            return "continue";
                        }
                        for (const s of list) {
                            const isBound = s.name === currentSessionName;
                            const mark = isBound ? "●" : "○";
                            const effLifecycle = isBound && currentLifecycle !== "idle" ? currentLifecycle : s.lifecycle;
                            const glyph =
                                effLifecycle && effLifecycle !== "idle" && effLifecycle !== "completed"
                                    ? ` ${lifecycleGlyphFor(effLifecycle)}`
                                    : "";
                            streams.stdout.write(`${mark} ${s.name}${glyph}\n`);
                        }
                    } catch {
                        const glyph = currentLifecycle !== "idle" ? ` ${lifecycleGlyphFor(currentLifecycle)}` : "";
                        streams.stdout.write(`● ${currentSessionName}${glyph}\n`);
                    }
                    return "continue";
                }

                if (cmd === "session") {
                    const targetName = args[0];
                    if (!targetName) {
                        streams.stdout.write(
                            `session: ${currentSessionName} [/${currentWorkspace}/~${currentSessionName}]\n`,
                        );
                        return "continue";
                    }
                    session = await bindSession(currentWorkspace, targetName);
                    streams.stdout.write(`session: ${currentSessionName} (bound)\n`);
                    return "continue";
                }

                if (cmd === "fork") {
                    const forked = await client.forkSession(session.sessionId, currentProjectRoot);
                    const nextName = args[0] ?? (forked.sessionId.includes("#")
                        ? forked.sessionId.slice(forked.sessionId.indexOf("#") + 1)
                        : forked.sessionId);
                    session = await bindSession(currentWorkspace, nextName);
                    streams.stdout.write(`session: ${currentSessionName} (forked)\n`);
                    return "continue";
                }

                if (cmd === "parent" || cmd === "enter" || cmd === "older" || cmd === "newer") {
                    await navigateTopology(cmd);
                    return "continue";
                }

                if (cmd === "workspaces") {
                    const result = await client.action<{ readonly workspaces?: ReadonlyArray<Record<string, unknown>> }>(
                        "workspace.list",
                        {},
                    );
                    for (const w of result.workspaces ?? []) {
                        streams.stdout.write(
                            `${String(w.name ?? w.id)}\t${String(w.project_root ?? w.cwd ?? "")}\n`,
                        );
                    }
                    return "continue";
                }

                if (cmd === "workspace") {
                    const targetWs = args[0];
                    if (!targetWs) {
                        streams.stdout.write(`workspace: ${currentWorkspace}\n`);
                        return "continue";
                    }
                    session = await bindSession(targetWs, options.tuiSession || "user");
                    streams.stdout.write(`workspace: ${currentWorkspace}\n`);
                    return "continue";
                }

                if (cmd === "rename") {
                    const newName = args[0];
                    if (!newName) {
                        writeErrorJsonl(streams.stderr, {
                            type: "https://problems.plurnk.xyz/client/usage",
                            title: "Missing workspace name",
                            status: 400,
                            detail: "usage: /rename <name>",
                        });
                        return "continue";
                    }
                    await client.action(
                        "workspace.rename",
                        { from: currentWorkspace, name: newName },
                        bindingContext(),
                    );
                    currentWorkspace = newName;
                    emitSessionBound(session);
                    streams.stdout.write(`workspace: ${currentWorkspace}\n`);
                    return "continue";
                }

                if (cmd === "models") {
                    let result: unknown;
                    try {
                        result = await client.action("models.list", args.length > 0 ? { search: args.join(" ") } : {});
                    } catch {
                        result = await client.listProviders();
                    }
                    const rec = result as Record<string, unknown>;
                    const items = Array.isArray(rec.items)
                        ? rec.items
                        : Array.isArray(rec.providers)
                          ? rec.providers
                          : [];
                    for (const item of items) {
                        const r = item as Record<string, unknown>;
                        streams.stdout.write(
                            `${String(r.id ?? r.providerId ?? r.alias ?? "")}\t${String(r.name ?? r.model ?? "")}\n`,
                        );
                    }
                    return "continue";
                }

                if (cmd === "loops") {
                    const result = await client.action<{
                        readonly items?: ReadonlyArray<Record<string, unknown>>;
                        readonly loops?: ReadonlyArray<Record<string, unknown>>;
                    }>("session.loops", {}, bindingContext());
                    for (const l of result.items ?? result.loops ?? []) {
                        const seq = String(l.seq ?? l.id ?? "");
                        const summary = String(l.summary ?? l.prompt ?? "");
                        streams.stdout.write(`  ${seq}: ${summary}\n`);
                    }
                    return "continue";
                }

                if (cmd === "loop") {
                    const loopNum = args[0] ? Number.parseInt(args[0], 10) : undefined;
                    const result = await client.action<{
                        readonly entries?: ReadonlyArray<Record<string, unknown>>;
                    }>(
                        "log.read",
                        {
                            ...(loopNum !== undefined && Number.isInteger(loopNum) ? { loopId: loopNum } : {}),
                            limit: 100,
                        },
                        bindingContext(),
                    );
                    streams.stdout.write(`── loop ${String(loopNum ?? "current")} ──\n`);
                    for (const e of result.entries ?? []) {
                        streams.stdout.write(
                            `${String(e.loop_seq ?? e.loop_id)}/${String(e.turn_seq ?? e.turn_id)}/${String(e.sequence)}\t${String(e.op ?? "")}\t${String(e.status ?? "")}\n`,
                        );
                    }
                    return "continue";
                }

                if (cmd === "capabilities") {
                    const rawPolicy = args.join(" ").trim();
                    const result =
                        rawPolicy.length > 0
                            ? await client.action(
                                  "workspace.capabilities.set",
                                  { policy: JSON.parse(rawPolicy) as unknown },
                                  bindingContext(),
                              )
                            : await client.action("workspace.capabilities.get", {}, bindingContext());
                    streams.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
                    return "continue";
                }

                if (cmd === "share") {
                    const folder = args[0];
                    if (!folder) {
                        writeErrorJsonl(streams.stderr, {
                            type: "https://problems.plurnk.xyz/client/usage",
                            title: "Missing share folder",
                            status: 400,
                            detail: "usage: /share <folder>",
                        });
                        return "continue";
                    }
                    const resolvedShare = folder.startsWith("~/")
                        ? join(options.env.HOME || homedir(), folder.slice(2))
                        : resolve(options.cwd, folder);
                    const result = await client.action(
                        "workspace.share",
                        { folder: resolvedShare },
                        bindingContext(),
                    );
                    streams.stdout.write(`${JSON.stringify(result)}\n`);
                    return "continue";
                }

                if (cmd === "rollback") {
                    const to = args[0];
                    if (!to) {
                        writeErrorJsonl(streams.stderr, {
                            type: "https://problems.plurnk.xyz/client/usage",
                            title: "Missing rollback coordinate",
                            status: 400,
                            detail: "usage: /rollback <loop>/<turn>/<item>",
                        });
                        return "continue";
                    }
                    const result = await client.action("workspace.rollback", { to }, bindingContext());
                    streams.stdout.write(`${JSON.stringify(result)}\n`);
                    return "continue";
                }

                if (cmd === "import") {
                    const filePath = args[0];
                    if (!filePath) {
                        writeErrorJsonl(streams.stderr, {
                            type: "https://problems.plurnk.xyz/client/usage",
                            title: "Missing import path",
                            status: 400,
                            detail: "usage: /import <path>",
                        });
                        return "continue";
                    }
                    const content = readFileSync(resolve(options.cwd, filePath), "utf8");
                    streams.stdout.write(content.endsWith("\n") ? content : `${content}\n`);
                    return "continue";
                }

                if (cmd === "script") {
                    const filePath = args[0];
                    if (!filePath) {
                        writeErrorJsonl(streams.stderr, {
                            type: "https://problems.plurnk.xyz/client/usage",
                            title: "Missing script path",
                            status: 400,
                            detail: "usage: /script <path>",
                        });
                        return "continue";
                    }
                    const text = readFileSync(resolve(options.cwd, filePath), "utf8");
                    const res = await client.action<{
                        readonly results?: ReadonlyArray<{
                            readonly status?: number;
                            readonly content?: string;
                            readonly message?: string;
                        }>;
                    }>("op.parse", { text }, bindingContext());
                    for (const r of res.results ?? []) {
                        const out = r.content ?? r.message ?? String(r.status ?? 200);
                        streams.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
                    }
                    return "continue";
                }

                const configMap: Record<string, string> = {
                    model: "model",
                    effort: "thought_level",
                    child: "spawn_model",
                    mode: "mode",
                };
                const mappedConfigId = configMap[cmd];
                if (mappedConfigId !== undefined) {
                    const arg = args[0];
                    if (arg === undefined || arg.length === 0) {
                        const opt = session.configOptions.find((o) => o.configId === mappedConfigId);
                        if (opt !== undefined) {
                            streams.stdout.write(`${formatConfigOption(opt)}\n`);
                        }
                        return "continue";
                    }
                    const value = cmd === "child" && arg === "inherit" ? "" : arg;
                    const res = await client.setConfigOption(session.sessionId, mappedConfigId, value);
                    session.configOptions = [...res.configOptions];
                    if (cmd === "model" && args[1]) {
                        const effortRes = await client.setConfigOption(
                            session.sessionId,
                            "thought_level",
                            args[1],
                        );
                        session.configOptions = [...effortRes.configOptions];
                    }
                    writeEventJsonl(streams.events, {
                        sessionUpdate: "config_option_update",
                        configOptions: session.configOptions,
                    });
                    const opt = session.configOptions.find((o) => o.configId === mappedConfigId);
                    if (opt !== undefined) {
                        streams.stdout.write(`${formatConfigOption(opt)}\n`);
                    }
                    return "continue";
                }

                if (["mcp", "skills", "members", "env", "schedule"].includes(cmd)) {
                    await handleFamilyCommand(cmd, args);
                    return "continue";
                }

                writeErrorJsonl(streams.stderr, {
                    type: "https://problems.plurnk.xyz/client/unknown-command",
                    title: "Unknown command",
                    status: 400,
                    detail: `Unknown interactive command: /${cmd}`,
                });
            } catch (err) {
                writeErrorJsonl(streams.stderr, {
                    type: "https://problems.plurnk.xyz/client/command-failed",
                    title: "Command failed",
                    status: 500,
                    detail: err instanceof Error ? err.message : String(err),
                });
            }
            return "continue";
        }

        if (line.startsWith("!")) {
            const shellCmd = line.replace(/^!+\s*/u, "");
            if (shellCmd.length === 0) {
                writeErrorJsonl(streams.stderr, {
                    type: "https://problems.plurnk.xyz/client/usage",
                    title: "Empty shell command",
                    status: 400,
                    detail: "usage: ! <command>",
                });
                return "continue";
            }
            const fence = `\`\`\`sh\n${shellCmd}\n\`\`\``;
            try {
                const res = await client.action<{
                    readonly results?: ReadonlyArray<{
                        readonly status?: number;
                        readonly content?: string;
                        readonly message?: string;
                    }>;
                }>("op.parse", { text: fence }, bindingContext());
                for (const r of res.results ?? []) {
                    const out = r.content ?? r.message ?? String(r.status ?? 200);
                    streams.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
                }
            } catch (err) {
                writeErrorJsonl(streams.stderr, {
                    type: "https://problems.plurnk.xyz/client/exec-failed",
                    title: "Execution failed",
                    status: 500,
                    detail: err instanceof Error ? err.message : String(err),
                });
            }
            return "continue";
        }

        if (line.startsWith("...")) {
            const injected = line.slice(3).trimStart();
            if (injected.length === 0) return "continue";
            try {
                await client.action("loop.inject", { message: injected }, bindingContext());
            } catch {
                void client.prompt(session.sessionId, [{ type: "text", text: injected }]).catch((err) => {
                    writeErrorJsonl(streams.stderr, {
                        type: "https://problems.plurnk.xyz/client/prompt-failed",
                        title: "Prompt failed",
                        status: 500,
                        detail: err instanceof Error ? err.message : String(err),
                    });
                });
            }
            return "continue";
        }

        let promptText = line;
        if (line.startsWith("?")) {
            forceReviewNextRun = true;
            promptText = line.slice(1).trimStart();
        } else if (line.startsWith(": ")) {
            promptText = line.slice(2);
        }

        const openPaths = extractOpenPaths(promptText, currentProjectRoot);
        currentLifecycle = "running";
        void client
            .prompt(session.sessionId, [{ type: "text", text: promptText }], {
                plurnk: {
                    ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
                    ...(options.auto ? { envelope: { auto: true } } : {}),
                    ...(openPaths.length > 0 ? { openPaths } : {}),
                },
            })
            .catch((err) => {
                writeErrorJsonl(streams.stderr, {
                    type: "https://problems.plurnk.xyz/client/prompt-failed",
                    title: "Prompt failed",
                    status: 500,
                    detail: err instanceof Error ? err.message : String(err),
                });
            });
        return "continue";
    };

    const rl = readline.createInterface({
        input: streams.stdin,
        terminal: false,
    });

    return await new Promise<number>((resolvePromise) => {
        let settled = false;
        let queue = Promise.resolve();

        const finish = (code: number): void => {
            if (settled) return;
            settled = true;
            flushReasoningNewline();
            rl.close();
            if (streams.stdin === process.stdin) {
                process.stdin.pause();
            }
            client.close();
            resolvePromise(code);
        };

        rl.on("line", (rawLine: string) => {
            queue = queue.then(async () => {
                if (settled) return;
                const action = await dispatchLine(rawLine);
                if (action === "quit") {
                    finish(0);
                }
            });
        });

        rl.on("close", () => {
            void queue.then(() => {
                finish(0);
            });
        });
    });
};

// Pure TUI viewport composed atop the 5-stream contract ([stdin, stdout, stderr, events, reasoning]).
// Holds no reference to AcpClient or AcpSession ({§cli-tui-mode}).
export const runTuiViewport = async (
    options: CliCommonOptions,
    outerStreams?: Partial<Pick<ClientStreams, "stdin" | "stdout" | "stderr">>,
): Promise<number> => {
    const replStdin = new PassThrough();
    const replStdout = new PassThrough();
    const replStderr = new PassThrough();
    const replEvents = new PassThrough();
    const replReasoning = new PassThrough();

    const termIn = outerStreams?.stdin ?? process.stdin;
    const termOut = outerStreams?.stdout ?? process.stdout;
    const termErr = outerStreams?.stderr ?? process.stderr;

    const presenter = new SessionPresenter({
        workspaceName: options.workspace ?? "default",
        sessionName: options.sessionId ?? options.tuiSession ?? "user",
        model: options.model ?? "default",
        yolo: options.yolo,
    });

    let initialPromptPrinted = false;

    replStdout.setEncoding("utf8");
    replStdout.on("data", (chunk: string) => {
        if (
            !initialPromptPrinted &&
            chunk.startsWith("workspace: ") &&
            presenter.workspaceName &&
            presenter.sessionName
        ) {
            initialPromptPrinted = true;
            termOut.write(`${chunk}[${presenter.workspaceName}/~${presenter.sessionName}] `);
            return;
        }
        if (chunk.startsWith("● ") && presenter.lastStatusLine.length > 0 && !chunk.includes("🎲")) {
            const trimmed = chunk.endsWith("\n") ? chunk.slice(0, -1) : chunk;
            termOut.write(`${trimmed}\n${presenter.lastStatusLine}\n`);
            return;
        }
        termOut.write(chunk);
    });

    replStderr.setEncoding("utf8");
    const stderrRl = readline.createInterface({ input: replStderr, terminal: false });
    stderrRl.on("line", (line: string) => {
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            // Daemon notices and terminal state_update problems also flow on replEvents
            // where SessionPresenter renders them in exact sequence before the status bar.
            if (
                typeof parsed.type === "string" &&
                parsed.type.startsWith("https://problems.plurnk.xyz/client/")
            ) {
                const detail =
                    typeof parsed.detail === "string"
                        ? parsed.detail
                        : typeof parsed.title === "string"
                          ? parsed.title
                          : line;
                termErr.write(`${detail}\n`);
            }
        } catch {
            termErr.write(`${line}\n`);
        }
    });

    replReasoning.setEncoding("utf8");
    replReasoning.on("data", (chunk: string) => {
        const trimmed = chunk.replace(/\r?\n$/u, "");
        if (trimmed.length > 0) {
            termOut.write(`${trimmed}\n`);
        }
    });

    replEvents.setEncoding("utf8");
    const eventsRl = readline.createInterface({ input: replEvents, terminal: false });
    eventsRl.on("line", (line: string) => {
        if (line.trim().length === 0) return;
        let event: Record<string, unknown>;
        try {
            event = JSON.parse(line) as Record<string, unknown>;
        } catch {
            return;
        }

        if (event.sessionUpdate === "session_bound") {
            if (typeof event.workspace === "string" && event.workspace.length > 0) {
                presenter.workspaceName = event.workspace;
            }
            if (typeof event.session === "string" && event.session.length > 0) {
                presenter.sessionName = event.session;
            }
            if (event._meta && typeof event._meta === "object") {
                presenter.ingestMeta(event._meta as Record<string, unknown>);
            }
            return;
        }

        if (
            event.sessionUpdate === "permission_request" ||
            event.sessionUpdate === "elicitation_request" ||
            event.sessionUpdate === "gate_resolved"
        ) {
            return;
        }

        const frames = presenter.apply(event as unknown as SessionUpdate);
        for (const frame of frames) {
            switch (frame.kind) {
                case "reasoning_tail":
                case "reasoning_retired":
                case "reply_chunk":
                case "subagent":
                    break;
                case "tool_call":
                    if (frame.title) {
                        termOut.write(`${frame.title}\n`);
                    }
                    for (const cLine of frame.contentLines) {
                        termOut.write(`${cLine}\n`);
                    }
                    break;
                case "terminal_output":
                    termOut.write(`${frame.rawData}\n`);
                    break;
                case "session_message":
                    termOut.write(`🐜 ${frame.senderSessionId}: ${frame.text}\n`);
                    break;
                case "notice":
                    termOut.write(`${frame.formatted}\n`);
                    break;
                case "status_bar":
                    if (frame.terminalDetail) {
                        termOut.write(`${frame.terminalDetail}\n`);
                    }
                    termOut.write(
                        `${frame.status.formattedStatusLine}\n[${presenter.workspaceName}/~${presenter.sessionName}(1/${frame.turns})] `,
                    );
                    break;
            }
        }
    });

    const userRl = readline.createInterface({ input: termIn, terminal: false });
    userRl.on("line", (line: string) => {
        if (
            line.trim().length > 0 &&
            !line.trim().startsWith("/") &&
            !line.trim().startsWith("!")
        ) {
            presenter.markTurnStart();
        }
        replStdin.write(`${line}\n`);
    });
    userRl.on("close", () => {
        replStdin.end();
    });

    try {
        return await runReplSession(options, {
            stdin: replStdin,
            stdout: replStdout,
            stderr: replStderr,
            events: replEvents,
            reasoning: replReasoning,
        });
    } finally {
        userRl.close();
        eventsRl.close();
        stderrRl.close();
    }
};
