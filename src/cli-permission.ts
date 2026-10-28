// One-shot and REPL proposal review, per-runtime acceptance (`PLURNK_CLIENT_ACCEPT_<runtime>`),
// colored udiff preview, and elicitation handlers ({§cli-inline-review}).

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as readline from "node:readline";
import {
    CreateElicitationRequest,
    ElicitationPropertySchema,
    type CreateElicitationResponse,
    type ElicitationContentValue,
    type RequestPermissionRequest,
    type RequestPermissionResponse,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import { ModelText, paint, withColorOutput, type ColorOutput } from "./color.ts";
import { extractRawString, extractTitleTarget } from "./presenter-formatters.ts";

const ACCEPT_ENV_PREFIX = `${["PLURNK", "CLIENT"].join("_")}_ACCEPT_`;

const isTruthySwitch = (value: string | undefined): boolean => {
    if (value === undefined) return false;
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
};

const extractProposalRuntimeAndTool = (
    request: RequestPermissionRequest,
): { readonly runtime: string | null; readonly tool: string | null } => {
    const plurnk = (request._meta?.plurnk ?? {}) as Record<string, unknown>;
    const proposal =
        plurnk.proposal && typeof plurnk.proposal === "object"
            ? (plurnk.proposal as Record<string, unknown>)
            : plurnk;
    const attrs =
        proposal.attrs && typeof proposal.attrs === "object"
            ? (proposal.attrs as Record<string, unknown>)
            : plurnk.attrs && typeof plurnk.attrs === "object"
              ? (plurnk.attrs as Record<string, unknown>)
              : undefined;
    const op = extractRawString(proposal.op) ?? extractRawString(plurnk.op);
    const rawRuntime =
        extractRawString(proposal.runtime) ??
        (op === "EXEC" ? (extractRawString(proposal.target) ?? extractRawString(plurnk.target)) : null) ??
        op ??
        request.title?.split(/[\s(:—]/u)[0] ??
        null;
    const rawTool =
        extractRawString(proposal.tool) ??
        extractRawString(attrs?.tool) ??
        extractRawString(plurnk.tool) ??
        (op !== "EXEC" ? (extractRawString(proposal.target) ?? extractRawString(plurnk.target)) : null) ??
        extractTitleTarget(request.title);
    return {
        runtime: rawRuntime ? rawRuntime.trim() : null,
        tool: rawTool ? rawTool.trim() : null,
    };
};

// {§cli-inline-review} — Evaluates `PLURNK_CLIENT_ACCEPT_<runtime>=1` and optional
// `PLURNK_CLIENT_ACCEPT_<runtime>_TOOLS` JSON array. `TOOLS` alone enables nothing.
export const matchesRuntimeAcceptance = (
    request: RequestPermissionRequest,
    env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => {
    const { runtime, tool } = extractProposalRuntimeAndTool(request);
    if (!runtime || runtime.length === 0) return false;

    const normalizedRuntime = runtime.toLowerCase().replaceAll("-", "_");
    const upperRuntime = normalizedRuntime.toUpperCase();
    const candidates = [...new Set([runtime, normalizedRuntime, upperRuntime])];

    const matchedKey = candidates.find((key) => isTruthySwitch(env[`${ACCEPT_ENV_PREFIX}${key}`]));
    if (matchedKey === undefined) {
        return false;
    }

    const toolsRaw =
        candidates
            .map((key) => env[`${ACCEPT_ENV_PREFIX}${key}_TOOLS`])
            .find((val) => val !== undefined) ?? undefined;
    if (toolsRaw === undefined || toolsRaw.trim().length === 0) {
        return true;
    }

    try {
        const parsed = JSON.parse(toolsRaw) as unknown;
        if (!Array.isArray(parsed) || parsed.length === 0) {
            return false;
        }
        const allowedTools = parsed.filter((item): item is string => typeof item === "string");
        return tool !== null && allowedTools.includes(tool);
    } catch {
        return false;
    }
};

// {§cli-inline-review} — Formats proposal diff or body with colored udiff lines for stderr review.
export const formatProposalDiffPreview = (
    request: RequestPermissionRequest,
    output: ColorOutput = process.stderr,
): string => {
    const plurnk = (request._meta?.plurnk ?? {}) as Record<string, unknown>;
    const proposal =
        plurnk.proposal && typeof plurnk.proposal === "object"
            ? (plurnk.proposal as Record<string, unknown>)
            : plurnk;
    const rawDiff =
        extractRawString(proposal.diff) ??
        extractRawString(proposal.patch) ??
        extractRawString(proposal.preview) ??
        extractRawString(proposal.body) ??
        (typeof request.description === "string" ? request.description : null);
    if (!rawDiff || rawDiff.trim().length === 0) return "";

    return withColorOutput(output, () =>
        ModelText.plain(rawDiff)
            .replace(/\r\n/gu, "\n")
            .trimEnd()
            .split("\n")
            .map((line) => {
                if (line.startsWith("+++") || line.startsWith("---")) {
                    return paint(`  ${line}`, "bold");
                }
                if (line.startsWith("+")) {
                    return paint(`  ${line}`, "added");
                }
                if (line.startsWith("-")) {
                    return paint(`  ${line}`, "removed");
                }
                if (line.startsWith("@@")) {
                    return paint(`  ${line}`, "reference");
                }
                return paint(`  ${line}`, "dim");
            })
            .join("\n"),
    );
};

const editInExternalEditor = (
    initialText: string,
    env: Readonly<Record<string, string | undefined>>,
): string | null => {
    const editorCmd = env.VISUAL || env.EDITOR || "vi";
    const tmpDir = mkdtempSync(join(tmpdir(), "plurnk-cli-review-"));
    const tmpFile = join(tmpDir, "proposal.md");
    try {
        writeFileSync(tmpFile, initialText, "utf8");
        const res = spawnSync(editorCmd, [tmpFile], {
            stdio: "inherit",
            shell: true,
            env: env as NodeJS.ProcessEnv,
        });
        if (res.status === 0) {
            return readFileSync(tmpFile, "utf8");
        }
        return null;
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
};

const promptLineWithAbort = (
    question: string,
    signal: AbortSignal,
    stdin: NodeJS.ReadableStream = process.stdin,
    stderr: NodeJS.WritableStream = process.stderr,
    isTTY: boolean = Boolean(process.stdin.isTTY),
): Promise<string | null> =>
    new Promise((resolvePrompt) => {
        if (signal.aborted || !isTTY) {
            resolvePrompt(null);
            return;
        }
        const rl = readline.createInterface({
            input: stdin,
            output: stderr,
        });
        const onAbort = () => {
            rl.close();
            resolvePrompt(null);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        rl.question(question, (answer) => {
            signal.removeEventListener("abort", onAbort);
            rl.close();
            resolvePrompt(answer.trim());
        });
    });

export interface CliPermissionHandlerOptions {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly forceReview?: boolean;
    readonly auto?: boolean;
    readonly stdin?: NodeJS.ReadableStream;
    readonly stderr?: NodeJS.WritableStream & { readonly isTTY?: boolean };
    readonly isTTY?: boolean;
    readonly editBody?: (initialBody: string) => Promise<string | null> | string | null;
}

export const createCliPermissionHandler = (
    yolo: boolean,
    options?: CliPermissionHandlerOptions,
) =>
    async (
        request: RequestPermissionRequest,
        signal: AbortSignal,
    ): Promise<RequestPermissionResponse> => {
        if (signal.aborted) {
            return { outcome: { outcome: "cancelled" } };
        }
        const env = options?.env ?? process.env;
        const forceReview = options?.forceReview === true;
        const allowOption =
            request.options.find((opt) => opt.kind === "allow_once" || opt.kind === "allow_always") ??
            request.options[0];
        const rejectOption = request.options.find(
            (opt) => opt.kind === "reject_once" || opt.kind === "reject_always",
        );

        // {§cli-inline-review} Precedence: `?` prefix -> `--yolo` -> `PLURNK_CLIENT_ACCEPT_<runtime>=1`
        if (!forceReview && (yolo || matchesRuntimeAcceptance(request, env))) {
            if (allowOption !== undefined) {
                return {
                    outcome: {
                        outcome: "selected",
                        optionId: allowOption.optionId,
                    },
                };
            }
            return { outcome: { outcome: "cancelled" } };
        }

        const stdin = options?.stdin ?? process.stdin;
        const stderr = options?.stderr ?? process.stderr;
        const isTTY = options?.isTTY ?? Boolean((stdin as { isTTY?: boolean }).isTTY);

        if (options?.auto === true || !isTTY) {
            if (rejectOption !== undefined) {
                return {
                    outcome: {
                        outcome: "selected",
                        optionId: rejectOption.optionId,
                    },
                };
            }
            return { outcome: { outcome: "cancelled" } };
        }

        stderr.write(`\n[permission] ${request.title}\n`);
        const diffPreview = formatProposalDiffPreview(request, stderr);
        if (diffPreview.length > 0) {
            stderr.write(`${diffPreview}\n`);
        } else if (request.description) {
            stderr.write(`${request.description}\n`);
        }
        for (let i = 0; i < request.options.length; i += 1) {
            const opt = request.options[i]!;
            stderr.write(`  ${String(i + 1)}) ${opt.name} (${opt.optionId})\n`);
        }
        const answer = await promptLineWithAbort(
            "[a]ccept · [e]dit · [r]eject · [c]ancel [1]: ",
            signal,
            stdin,
            stderr,
            isTTY,
        );
        if (answer === null || signal.aborted) {
            return { outcome: { outcome: "cancelled" } };
        }

        const lower = answer.toLowerCase();
        if (lower === "c" || lower === "cancel") {
            return { outcome: { outcome: "cancelled" } };
        }
        if (lower === "r" || lower === "reject") {
            if (rejectOption !== undefined) {
                return {
                    outcome: {
                        outcome: "selected",
                        optionId: rejectOption.optionId,
                    },
                };
            }
            return { outcome: { outcome: "cancelled" } };
        }
        if (lower === "e" || lower === "edit") {
            const plurnk = (request._meta?.plurnk ?? {}) as Record<string, unknown>;
            const proposal =
                plurnk.proposal && typeof plurnk.proposal === "object"
                    ? (plurnk.proposal as Record<string, unknown>)
                    : plurnk;
            const initialBody = extractRawString(proposal.body) ?? "";
            const edited = options?.editBody
                ? await options.editBody(initialBody)
                : editInExternalEditor(initialBody, env);
            if (edited === null || signal.aborted || allowOption === undefined) {
                return { outcome: { outcome: "cancelled" } };
            }
            return {
                outcome: {
                    outcome: "selected",
                    optionId: allowOption.optionId,
                },
                _meta: {
                    plurnk: {
                        body: edited,
                    },
                },
            } as RequestPermissionResponse;
        }
        if (lower === "" || lower === "a" || lower === "accept") {
            if (allowOption !== undefined) {
                return {
                    outcome: {
                        outcome: "selected",
                        optionId: allowOption.optionId,
                    },
                };
            }
            return { outcome: { outcome: "cancelled" } };
        }

        const idx = Number.parseInt(answer, 10) - 1;
        const chosen = request.options[idx] ?? request.options[0];
        if (chosen === undefined) {
            return { outcome: { outcome: "cancelled" } };
        }
        return {
            outcome: {
                outcome: "selected",
                optionId: chosen.optionId,
            },
        };
    };

export const createCliElicitationHandler = () =>
    async (
        request: CreateElicitationRequest,
        signal: AbortSignal,
    ): Promise<CreateElicitationResponse> => {
        if (signal.aborted) {
            return { action: "cancel" };
        }
        if (!process.stdin.isTTY) {
            return { action: "decline" };
        }
        if (CreateElicitationRequest.isUrl(request)) {
            process.stderr.write(`\n[elicitation] ${request.message}\n  URL: ${request.url}\n`);
            const answer = await promptLineWithAbort("  Open/Confirm [y/N]: ", signal);
            if (answer === null || signal.aborted) {
                return { action: "cancel" };
            }
            const normalized = answer.trim().toLowerCase();
            return normalized === "y" || normalized === "yes"
                ? { action: "accept" }
                : { action: "decline" };
        }
        if (!CreateElicitationRequest.isForm(request)) {
            return { action: "decline" };
        }

        process.stderr.write(`\n[elicitation] ${request.message}\n`);
        const content: Record<string, ElicitationContentValue> = {};
        const properties = request.requestedSchema.properties ?? {};
        for (const [key, prop] of Object.entries(properties)) {
            const label =
                (ElicitationPropertySchema.isString(prop) ||
                    ElicitationPropertySchema.isNumber(prop) ||
                    ElicitationPropertySchema.isInteger(prop) ||
                    ElicitationPropertySchema.isBoolean(prop) ||
                    ElicitationPropertySchema.isArray(prop)) &&
                typeof prop.title === "string" &&
                prop.title.length > 0
                    ? prop.title
                    : key;
            const answer = await promptLineWithAbort(`  ${label}: `, signal);
            if (answer === null || signal.aborted) {
                return { action: "cancel" };
            }
            if (ElicitationPropertySchema.isBoolean(prop)) {
                content[key] = answer === "true" || answer === "1" || answer === "yes" || answer === "y";
            } else if (
                ElicitationPropertySchema.isNumber(prop) ||
                ElicitationPropertySchema.isInteger(prop)
            ) {
                content[key] = Number(answer);
            } else {
                content[key] = answer;
            }
        }
        return {
            action: "accept",
            content,
        };
    };
