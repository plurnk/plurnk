// Term viewport keyboard shortcuts, config/command autocomplete cache, composer submission,
// and external editor handoff ({§cli-repl-mode}, {§cli-model-selection}, {§cli-inline-review}, {§cli-interactive-command-discovery}).

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PassThrough } from "node:stream";
import { matchesKey } from "@earendil-works/pi-tui";
import type { CliCommonOptions } from "./cli-connection.ts";
import { expandLearnCommand } from "./commands.ts";
import type { PresentationFrame, SessionPresenter } from "./session-presenter.ts";
import { makeAutocompleteProvider } from "./term-completion.ts";
import type Review from "./term-review.ts";
import type TermSurface from "./term-surface.ts";
import {
    ModelText,
    paint,
    renderSubmittedInput,
    type AttentionReason,
} from "./term-surface.ts";

export const ALT_SHORTCUTS: Readonly<Record<string, string>> = Object.freeze({
    m: "/models",
    s: "/workspaces",
    R: "/sessions",
    L: "/loops",
    N: "/workspace",
    M: "/members",
    x: "/stop",
    "?": "/help",
    e: "/editor",
    h: "/parent",
    l: "/enter",
    j: "/older",
    k: "/newer",
});

export const altShortcut = (forward: string): string | null => {
    const m = forward.match(/^\x1b([a-zA-Z?])$/u);
    return m ? (ALT_SHORTCUTS[m[1]!] ?? null) : null;
};

export const backTabShortcut = (forward: string): string | null =>
    matchesKey(forward, "shift+tab") || forward === "\x1b[Z" ? "/yolo" : null;

export interface TermViewportState {
    readonly options: CliCommonOptions;
    readonly replStdin: PassThrough;
    readonly termOut: NodeJS.WritableStream;
    readonly termErr: NodeJS.WritableStream;
    readonly surface: TermSurface | null;
    readonly review: Review | null;
    readonly attend: (reason: AttentionReason) => void;
    readonly presenter: SessionPresenter;
    initialPromptPrinted: boolean;
    initialWorkspaceConsumed: boolean;
    boundProjectRoot: string | null;
    cachedModels: string[];
    cachedEfforts: string[];
    cachedPersonas: string[];
    cachedSessions: string[];
    cachedWorkspaces: string[];
    cachedSkills: { readonly name: string; readonly description: string }[];
    cachedAvailableCommands: { readonly name: string; readonly description: string }[];
    currentPersona: string | null;
    currentMode: string | null;
    providerModelsFetcher: ((provider: string) => Promise<readonly string[]>) | null;
    modelSearchFetcher: ((query: string) => Promise<readonly string[]>) | null;
    modelEffortsFetcher: ((selector: string) => Promise<readonly string[] | null>) | null;
    readonly cachedFamilyAliases: Map<string, string[]>;
    currentTurns: number;
    cancelArmed: boolean;
    readonly focusedGateIds: string[];
    readonly suppressedStdoutQueue: string[];
    readonly localSubmittedPrompts: string[];
    updateSurfaceStatus(): void;
    ensureSurfaceStarted(): void;
    retireLiveReasoning(): void;
    renderToolCallToSurface(frame: Extract<PresentationFrame, { kind: "tool_call" }>): void;
}

export const applyAvailableCommandsToCache = (
    state: TermViewportState,
    rawCommands: readonly unknown[],
): void => {
    const nextSkills: { readonly name: string; readonly description: string }[] = [];
    const nextCommands: { readonly name: string; readonly description: string }[] = [];
    const seenSkills = new Set<string>();
    const seenCommands = new Set<string>();
    for (const rawCmd of rawCommands) {
        if (!rawCmd || typeof rawCmd !== "object") continue;
        const cmd = rawCmd as { type?: unknown; name?: unknown; description?: unknown };
        if (typeof cmd.name !== "string" || cmd.name.length === 0) continue;
        if (cmd.type === "skill") {
            if (seenSkills.has(cmd.name)) continue;
            seenSkills.add(cmd.name);
            nextSkills.push({
                name: cmd.name,
                description:
                    typeof cmd.description === "string" && cmd.description.length > 0
                        ? cmd.description
                        : "skill",
            });
        } else if (cmd.type === "command") {
            if (seenCommands.has(cmd.name)) continue;
            seenCommands.add(cmd.name);
            nextCommands.push({
                name: cmd.name,
                description:
                    typeof cmd.description === "string" && cmd.description.length > 0
                        ? cmd.description
                        : "command",
            });
        }
    }
    state.cachedSkills = nextSkills;
    state.cachedAvailableCommands = nextCommands;
};

export const flattenSelectOptionValues = (optionsList: readonly unknown[] | undefined): string[] => {
    if (!Array.isArray(optionsList)) return [];
    const values: string[] = [];
    for (const entry of optionsList) {
        if (!entry || typeof entry !== "object") continue;
        if ("options" in entry && Array.isArray((entry as { options?: unknown }).options)) {
            for (const sub of (entry as { options: readonly unknown[] }).options) {
                if (sub && typeof sub === "object" && typeof (sub as { value?: unknown }).value === "string") {
                    values.push((sub as { value: string }).value);
                }
            }
        } else if (typeof (entry as { value?: unknown }).value === "string") {
            values.push((entry as { value: string }).value);
        }
    }
    return values;
};

export const applyConfigOptionsToCache = (
    state: TermViewportState,
    rawOptions: readonly unknown[],
): void => {
    const { presenter } = state;
    for (const rawOpt of rawOptions) {
        const opt = rawOpt as {
            configId?: string;
            currentValue?: string;
            options?: readonly unknown[];
        };
        if (opt.configId === "model") {
            if (typeof opt.currentValue === "string") {
                presenter.model = opt.currentValue.length > 0 ? opt.currentValue : "none";
            }
            const incoming = flattenSelectOptionValues(opt.options).filter(
                (v) => v.length > 0 && v !== "none",
            );
            if (incoming.length > 0) {
                state.cachedModels = [...new Set([...incoming, ...state.cachedModels])];
            }
        } else if (opt.configId === "thought_level") {
            if (typeof opt.currentValue === "string") {
                presenter.effort = opt.currentValue.length > 0 ? opt.currentValue : null;
                if (presenter.effort !== null && presenter.effortSource === null) {
                    presenter.effortSource = "default";
                }
            }
            const efforts = flattenSelectOptionValues(opt.options).filter(Boolean);
            if (efforts.length > 0) {
                state.cachedEfforts = efforts;
            }
        } else if (opt.configId === "persona") {
            if (typeof opt.currentValue === "string") {
                state.currentPersona =
                    opt.currentValue.length > 0 && opt.currentValue !== "none"
                        ? opt.currentValue
                        : null;
            }
            const personas = flattenSelectOptionValues(opt.options).filter(
                (v) => v.length > 0 && v !== "custom",
            );
            if (personas.length > 0) {
                state.cachedPersonas = personas;
            }
        } else if (opt.configId === "child") {
            if (typeof opt.currentValue === "string") {
                presenter.childModel =
                    opt.currentValue.length > 0 && opt.currentValue !== "inherit"
                        ? opt.currentValue
                        : null;
            }
        } else if (opt.configId === "mode") {
            if (typeof opt.currentValue === "string") {
                state.currentMode = opt.currentValue.length > 0 ? opt.currentValue : null;
            }
        } else if (typeof opt.configId === "string" && opt.configId.includes(":")) {
            const colonIdx = opt.configId.indexOf(":");
            const family = opt.configId.slice(0, colonIdx);
            const alias = opt.configId.slice(colonIdx + 1);
            if (alias.length > 0) {
                const existing = state.cachedFamilyAliases.get(family) ?? [];
                if (!existing.includes(alias)) {
                    state.cachedFamilyAliases.set(family, [...existing, alias]);
                }
            }
        }
    }
};

export const editInExternalEditor = (
    initialText: string,
    env: Readonly<Record<string, string | undefined>>,
): string | null => {
    const editorCmd = env.VISUAL || env.EDITOR || "vi";
    const tmpDir = mkdtempSync(join(tmpdir(), "plurnk-term-editor-"));
    const tmpFile = join(tmpDir, "buffer.md");
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

const GATE_VERBS = new Set(["approve", "accept", "reject", "cancel", "edit", "answer"]);

export const routeAndSendLine = (state: TermViewportState, rawSubmission: string): void => {
    const trimmed = rawSubmission.trim();
    if (trimmed.length === 0) return;
    if (trimmed.startsWith("/")) {
        const tokens = trimmed.slice(1).split(/\s+/u);
        const verb = tokens[0]?.toLowerCase() ?? "";
        const firstArg = tokens[1];
        const focusedId = state.focusedGateIds[0];
        if (
            GATE_VERBS.has(verb) &&
            focusedId !== undefined &&
            (firstArg === undefined || !firstArg.startsWith("@"))
        ) {
            const afterVerb = trimmed.slice(1 + verb.length).trimStart();
            const routed = afterVerb.length > 0 ? `/${verb} @${focusedId} ${afterVerb}` : `/${verb} @${focusedId}`;
            state.replStdin.write(
                routed.includes("\n") ? `\x1b[200~${routed}\x1b[201~\n` : `${routed}\n`,
            );
            return;
        }
    }
    const leadingTrimmed = rawSubmission.trimStart();
    const slashVerb = trimmed.startsWith("/") ? (trimmed.slice(1).split(/\s+/u)[0] ?? "") : "";
    const isAdvertisedPromptCmd =
        slashVerb.includes(":") &&
        state.cachedAvailableCommands.some((c) => c.name.toLowerCase() === slashVerb.toLowerCase());
    if (
        ((!trimmed.startsWith("/") && trimmed !== "?" && leadingTrimmed !== ":" && !/^:\s+$/u.test(leadingTrimmed)) ||
            expandLearnCommand(trimmed, { projectRoot: state.boundProjectRoot }) !== null ||
            isAdvertisedPromptCmd) &&
        !trimmed.startsWith("!")
    ) {
        state.retireLiveReasoning();
        state.presenter.markTurnStart();
        state.presenter.buildStatusBar();
        state.updateSurfaceStatus();
    }
    state.replStdin.write(
        rawSubmission.includes("\n")
            ? `\x1b[200~${rawSubmission}\x1b[201~\n`
            : `${rawSubmission}\n`,
    );
};

const isLoopOrGateActive = (state: TermViewportState): boolean =>
    state.presenter.lifecycle === "running" ||
    state.presenter.lifecycle === "queued" ||
    state.presenter.lifecycle === "parked" ||
    state.presenter.lifecycle === "requires_action" ||
    state.focusedGateIds.length > 0;

export const cancelViewportRun = (state: TermViewportState): void => {
    state.replStdin.write("/stop\n");
    if (!state.cancelArmed && state.surface !== null) {
        state.cancelArmed = true;
        state.surface.append(paint("  cancelling… (ctrl-c again to quit)", "dim"));
        state.surface.renderNow();
    }
};

export const attachViewportSurfaceInput = (state: TermViewportState): (() => void) | null => {
    const { surface, options, presenter, review } = state;
    if (surface === null) return null;

    surface.setAutocompleteProvider(
        makeAutocompleteProvider({
            cwd: options.cwd,
            getProjectRoot: () => state.boundProjectRoot,
            getModels: () => state.cachedModels,
            getProviderModels: async (provider) =>
                state.providerModelsFetcher !== null ? await state.providerModelsFetcher(provider) : [],
            searchModels: async (query) =>
                state.modelSearchFetcher !== null ? await state.modelSearchFetcher(query) : [],
            getEfforts: () => state.cachedEfforts,
            getEffortsForModel: async (selector) =>
                state.modelEffortsFetcher !== null ? await state.modelEffortsFetcher(selector) : null,
            getPersonas: () => state.cachedPersonas,
            getFamilyAliases: (family) =>
                family === "personas"
                    ? state.cachedPersonas.filter((p) => p !== "none")
                    : (state.cachedFamilyAliases.get(family) ?? []),
            getSessionNames: () => state.cachedSessions,
            getWorkspaceNames: () => state.cachedWorkspaces,
            getPendingGateIds: () => state.focusedGateIds,
            getSkills: () => state.cachedSkills,
            getAvailableCommands: () => state.cachedAvailableCommands,
            getPromptSuggestions: () =>
                presenter.lifecycle === "running" ||
                presenter.lifecycle === "queued" ||
                presenter.lifecycle === "parked" ||
                presenter.lifecycle === "requires_action"
                    ? []
                    : presenter.promptSuggestions,
        }),
    );

    const removeInputListener = surface.addInputListener((text) => {
        if (surface.dialogOpen) return undefined;
        if (matchesKey(text, "escape")) {
            if (surface.leaveReview()) return { consume: true };
            if (isLoopOrGateActive(state)) {
                cancelViewportRun(state);
                return { consume: true };
            }
            if (surface.editor.getText().length > 0) {
                surface.setInput("");
            }
            return { consume: true };
        }
        if (matchesKey(text, "ctrl+c")) {
            if (state.cancelArmed) {
                state.cancelArmed = false;
                state.replStdin.write("/quit\n");
            } else if (isLoopOrGateActive(state)) {
                cancelViewportRun(state);
            } else if (surface.editor.getText().length > 0) {
                surface.setInput("");
            } else {
                state.replStdin.write("/quit\n");
            }
            return { consume: true };
        }
        if (matchesKey(text, "ctrl+d") && !surface.reviewing && surface.editor.getText().length === 0) {
            state.replStdin.write("/quit\n");
            return { consume: true };
        }
        const backTab = backTabShortcut(text);
        if (backTab !== null) {
            state.replStdin.write(`${backTab}\n`);
            return { consume: true };
        }
        if (surface.reviewing) return undefined;
        const shortcut = altShortcut(text);
        if (shortcut !== null) {
            if (shortcut === "/editor") {
                const draft = surface.editor.getText();
                void surface.handOff(() => editInExternalEditor(draft, options.env)).then((edited) => {
                    if (edited !== null) {
                        surface.setInput(edited.replace(/\r?\n$/u, ""));
                    }
                });
            } else {
                state.replStdin.write(`${shortcut}\n`);
            }
            return { consume: true };
        }
        return undefined;
    });

    surface.editor.onSubmit = (rawText: string) => {
        const trimmed = rawText.trim();
        if (trimmed.length === 0) return;
        surface.recordPrompt(rawText);
        const expandedLearn = expandLearnCommand(trimmed, { projectRoot: state.boundProjectRoot });
        if (expandedLearn !== null) {
            state.localSubmittedPrompts.push(expandedLearn);
        } else if (!trimmed.startsWith("/")) {
            state.localSubmittedPrompts.push(rawText);
        }
        surface.append("");
        surface.append(renderSubmittedInput(rawText));
        surface.append("");

        if (trimmed === "/review" && review !== null && review.waiting > 0) {
            surface.openReview();
            return;
        }

        if (trimmed === "/editor") {
            void surface.handOff(() => editInExternalEditor("", options.env)).then((edited) => {
                if (edited !== null) {
                    surface.setInput(edited.replace(/\r?\n$/u, ""));
                }
            });
            return;
        }

        const importMatch = trimmed.match(/^\/import(?:\s+(.+))?$/u);
        if (importMatch) {
            const filePath = importMatch[1]?.trim() ?? "";
            if (!filePath) {
                state.replStdin.write("/import\n");
                return;
            }
            try {
                const content = readFileSync(resolve(options.cwd, filePath), "utf8");
                surface.insertInput(content);
            } catch (err) {
                surface.append(
                    paint(
                        `error: ${ModelText.plain(err instanceof Error ? err.message : String(err))}`,
                        "failure",
                    ),
                );
            }
            return;
        }

        routeAndSendLine(state, rawText);
    };

    return removeInputListener;
};
