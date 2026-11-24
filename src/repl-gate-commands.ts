// Interactive REPL gate & YOLO slash-command handlers (`/yolo`, `/review`, `/approve`, `/accept`,
// `/reject`, `/cancel`, `/edit`, `/answer`) ({§cli-inline-review}, {§cli-repl-mode}, {§cli-problems-and-notices}).

import type {
    CreateElicitationRequest,
    CreateElicitationResponse,
    ElicitationContentValue,
    RequestPermissionRequest,
    RequestPermissionResponse,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type { AcpClient } from "./acp-client.ts";
import type { AcpSession } from "./acp-session.ts";
import {
    writeErrorJsonl,
    writeEventJsonl,
    type ClientStreams,
} from "./repl-commands.ts";

export interface PendingPermissionGate {
    readonly kind: "permission";
    readonly id: string;
    readonly sessionId: string;
    readonly request: RequestPermissionRequest;
    readonly resolveGate: (res: RequestPermissionResponse) => void;
}

export interface PendingElicitationGate {
    readonly kind: "elicitation";
    readonly id: string;
    readonly sessionId: string;
    readonly request: CreateElicitationRequest;
    readonly resolveGate: (res: CreateElicitationResponse) => void;
}

export type PendingGate = PendingPermissionGate | PendingElicitationGate;

export interface GateSlashContext {
    readonly client: AcpClient;
    readonly streams: ClientStreams;
    readonly pendingGates: Map<string, PendingGate>;
    getSession(): AcpSession;
    getYolo(): boolean;
    setYolo(next: boolean): void;
    clearForceReviewNextRun(): void;
}

const resolveRequiredGate = (
    streams: ClientStreams,
    pendingGates: Map<string, PendingGate>,
    cmdName: string,
    usage: string,
    rawTarget: string | undefined,
): PendingGate | undefined => {
    if (!rawTarget || !rawTarget.startsWith("@") || rawTarget.length < 2) {
        writeErrorJsonl(streams.stderr, {
            type: "https://problems.plurnk.xyz/client/usage",
            title: "Missing gate identifier",
            status: 400,
            detail: `usage: ${usage} (/${cmdName} requires @<id> in REPL mode; inspect pending gates with /review or fd 3 events).`,
        });
        return undefined;
    }
    const id = rawTarget.slice(1);
    const gate = pendingGates.get(id);
    if (!gate) {
        writeErrorJsonl(streams.stderr, {
            type: "https://problems.plurnk.xyz/client/gate-not-found",
            title: "Gate not found",
            status: 404,
            detail: `No pending gate with id @${id}.`,
        });
        return undefined;
    }
    return gate;
};

export const dispatchGateSlashCommand = async (
    cmd: string,
    args: readonly string[],
    rawLine: string,
    ctx: GateSlashContext,
): Promise<boolean> => {
    const { client, streams, pendingGates } = ctx;

    if (cmd === "yolo") {
        const session = ctx.getSession();
        const modeOpt = session.configOptions.find((o) => o.configId === "mode");
        const currentAccept =
            modeOpt !== undefined && "currentValue" in modeOpt
                ? modeOpt.currentValue === "accept"
                : ctx.getYolo();
        const nextYolo = !currentAccept;
        ctx.setYolo(nextYolo);
        if (modeOpt !== undefined) {
            const res = await client.setConfigOption(
                session.sessionId,
                "mode",
                nextYolo ? "accept" : "review",
            );
            session.configOptions = [...res.configOptions];
            const latestMeta = (res as { _meta?: unknown })._meta;
            writeEventJsonl(streams.events, {
                sessionUpdate: "config_option_update",
                configOptions: session.configOptions,
                ...(latestMeta !== undefined ? { _meta: latestMeta } : {}),
            });
        }
        streams.stdout.write(`yolo: ${nextYolo ? "on" : "off"}\n`);
        if (nextYolo) {
            ctx.clearForceReviewNextRun();
            for (const gate of [...pendingGates.values()]) {
                if (gate.kind !== "permission") continue;
                const allowOpt =
                    gate.request.options.find(
                        (o) => o.kind === "allow_once" || o.kind === "allow_always",
                    ) ?? gate.request.options[0];
                gate.resolveGate({
                    outcome: allowOpt
                        ? { outcome: "selected", optionId: allowOpt.optionId }
                        : { outcome: "cancelled" },
                });
            }
        }
        return true;
    }

    if (cmd === "review") {
        if (pendingGates.size === 0) {
            streams.stdout.write("review: none\n");
            return true;
        }
        for (const gate of pendingGates.values()) {
            if (gate.kind === "permission") {
                const opts = gate.request.options.map((o) => o.optionId).join(", ");
                streams.stdout.write(`@${gate.id}  permission  ${gate.request.title}  [${opts}]\n`);
            } else {
                streams.stdout.write(`@${gate.id}  elicitation  ${gate.request.message}\n`);
            }
        }
        return true;
    }

    if (cmd === "approve" || cmd === "accept") {
        const gate = resolveRequiredGate(streams, pendingGates, cmd, `/${cmd} @<id> [optionId]`, args[0]);
        if (!gate) return true;
        const explicitOptionId = args[1];
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
        return true;
    }

    if (cmd === "reject") {
        const gate = resolveRequiredGate(streams, pendingGates, cmd, "/reject @<id> [optionId]", args[0]);
        if (!gate) return true;
        const explicitOptionId = args[1];
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
        return true;
    }

    if (cmd === "cancel") {
        const gate = resolveRequiredGate(streams, pendingGates, cmd, "/cancel @<id>", args[0]);
        if (!gate) return true;
        if (gate.kind === "permission") {
            gate.resolveGate({ outcome: { outcome: "cancelled" } });
        } else {
            gate.resolveGate({ action: "cancel" });
        }
        return true;
    }

    if (cmd === "edit") {
        const gate = resolveRequiredGate(streams, pendingGates, cmd, "/edit @<id> <body...>", args[0]);
        if (!gate) return true;
        if (gate.kind !== "permission") {
            writeErrorJsonl(streams.stderr, {
                type: "https://problems.plurnk.xyz/client/gate-not-found",
                title: "Gate not found",
                status: 404,
                detail: `Gate @${gate.id} is not a permission gate.`,
            });
            return true;
        }
        const afterTargetMatch = rawLine.match(/^\/\S+\s+\S+(?:\r?\n|[ \t])([\s\S]*)$/u);
        const editedBody = afterTargetMatch?.[1] ?? "";
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
        return true;
    }

    if (cmd === "answer") {
        const gate = resolveRequiredGate(streams, pendingGates, cmd, "/answer @<id> <json>", args[0]);
        if (!gate) return true;
        if (gate.kind !== "elicitation") {
            writeErrorJsonl(streams.stderr, {
                type: "https://problems.plurnk.xyz/client/gate-not-found",
                title: "Gate not found",
                status: 404,
                detail: `Gate @${gate.id} is not an elicitation gate.`,
            });
            return true;
        }
        const afterTargetMatch = rawLine.match(/^\/\S+\s+\S+(?:\r?\n|[ \t])([\s\S]*)$/u);
        const rawPayload = (afterTargetMatch?.[1] ?? "").trim();
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
        return true;
    }

    return false;
};
