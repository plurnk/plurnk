// Reusable `pi-tui` main-screen components: `SingleLineText`, `TranscriptSlot`, `TailText`,
// and `ComposerEditor` ({§cli-session-status}, {§cli-rendering}, {§cli-markdown-projection}, {§cli-inline-review}).

import {
    CURSOR_MARKER,
    Editor,
    renderFakeCursor,
    Text,
    truncateToWidth,
    visibleWidth,
    type Component,
    type EditorOptions,
    type EditorTheme,
    type TUI,
} from "@earendil-works/pi-tui";
import { styled } from "./color.ts";

// {§cli-session-status} — Single-line muted footer/banner that truncates to terminal width instead of wrapping.
export class SingleLineText implements Component {
    #text = "";

    setText(text: string): void {
        this.#text = text;
    }

    invalidate(): void {}

    render(width: number): string[] {
        const normalized = this.#text.replace(/\t/gu, "   ");
        if (normalized.trim().length === 0) return [];
        const single = normalized.split("\n", 1)[0] ?? "";
        const safeWidth = Math.max(1, width);
        return [styled("dim")(truncateToWidth(single, safeWidth, "…", true))];
    }
}

export type CoordinateTuple = readonly [number, number, number];

export const parseCoordinate = (id: string | null | undefined): CoordinateTuple | null => {
    if (typeof id !== "string") return null;
    const m = /^(\d+)\/(\d+)\/(\d+)$/u.exec(id.trim());
    if (!m) return null;
    const loopSeq = Number(m[1]);
    const turnSeq = Number(m[2]);
    const seq = Number(m[3]);
    if (!Number.isSafeInteger(loopSeq) || !Number.isSafeInteger(turnSeq) || !Number.isSafeInteger(seq)) {
        return null;
    }
    return [loopSeq, turnSeq, seq];
};

export const compareCoordinates = (a: CoordinateTuple, b: CoordinateTuple): number => {
    if (a[0] !== b[0]) return a[0] - b[0];
    if (a[1] !== b[1]) return a[1] - b[1];
    return a[2] - b[2];
};

// {§cli-rendering} {§cli-session-status} — Anchored transcript slot for in-place operation materialization.
export class TranscriptSlot implements Component {
    readonly epoch: number;
    readonly coordinate: CoordinateTuple | null;
    #inner: Text | null = null;
    #rawText = "";
    #trailingBlankLine = false;

    constructor(epoch: number, coordinate: CoordinateTuple | null, text = "", trailingBlankLine = false) {
        this.epoch = epoch;
        this.coordinate = coordinate;
        if (text.length > 0) {
            this.setText(text, trailingBlankLine);
        }
    }

    get rawText(): string {
        return this.#rawText;
    }

    get hasContent(): boolean {
        return this.#inner !== null;
    }

    get trailingBlankLine(): boolean {
        return this.#trailingBlankLine;
    }

    setText(text: string, trailingBlankLine = false): void {
        const normalized = text.replace(/\n$/u, "");
        this.#rawText = normalized;
        this.#trailingBlankLine = trailingBlankLine && normalized.length > 0;
        if (normalized.length === 0) {
            this.#inner = null;
        } else if (this.#inner !== null) {
            this.#inner.setText(normalized);
        } else {
            this.#inner = new Text(normalized, 0, 0);
        }
    }

    invalidate(): void {
        this.#inner?.invalidate();
    }

    render(width: number): string[] {
        if (this.#inner === null) return [];
        const lines = this.#inner.render(width);
        if (this.#trailingBlankLine && lines.length > 0) {
            return [...lines, ""];
        }
        return [...lines];
    }
}

// Live reasoning ticker (at most 3 rolling lines) plus 1 active streams/workers strip above the composer ({§cli-markdown-projection}, {§cli-rendering}).
export class TailText implements Component {
    #text = "";
    #activity = "";
    #reserved = false;
    readonly #maxLines: () => number;

    constructor(maxLines: () => number = () => 3) {
        this.#maxLines = maxLines;
    }

    get hasText(): boolean {
        return this.#text.length > 0;
    }

    get hasActivity(): boolean {
        return this.#activity.length > 0;
    }

    get reserved(): boolean {
        return this.#reserved;
    }

    setText(text: string): void {
        this.#text = text;
    }

    setActivity(activity: string): void {
        this.#activity = activity;
    }

    setReserved(reserved: boolean): void {
        this.#reserved = reserved;
    }

    invalidate(): void {}

    render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        const max = Math.max(1, this.#maxLines());
        let reasoningLines: string[] = [];
        if (this.#text.length > 0) {
            const rawLines = this.#text.replace(/\t/gu, "   ").split("\n");
            const tailRaw = rawLines.length <= max ? rawLines : rawLines.slice(rawLines.length - max);
            reasoningLines = tailRaw.map((line) => truncateToWidth(line, safeWidth, "…"));
        }
        let activityLine = "";
        if (this.#activity.length > 0) {
            const singleActivity = this.#activity.replace(/\t/gu, "   ").split("\n", 1)[0] ?? "";
            activityLine = truncateToWidth(singleActivity, safeWidth, "…");
        }
        if (this.#reserved) {
            const paddedReasoning = [
                ...reasoningLines,
                ...Array.from({ length: Math.max(0, max - reasoningLines.length) }, () => ""),
            ];
            return [...paddedReasoning, activityLine];
        }
        const out: string[] = [...reasoningLines];
        if (activityLine.length > 0) {
            out.push(activityLine);
        }
        return out;
    }
}

export interface ComposerHintState {
    readonly yolo?: boolean;
    readonly mode?: string | null;
    readonly persona?: string | null;
    readonly childModel?: string | null;
}

export const formatComposerHint = (state: ComposerHintState = {}): string => {
    const segments: string[] = [];
    if (typeof state.persona === "string" && state.persona.length > 0 && state.persona !== "none") {
        segments.push(`persona:${state.persona}`);
    }
    if (
        typeof state.childModel === "string" &&
        state.childModel.length > 0 &&
        state.childModel !== "inherit"
    ) {
        segments.push(`child:${state.childModel}`);
    }
    if (state.mode === "reject") {
        segments.push("mode:reject");
    }
    const yoloOn = state.yolo === true || state.mode === "accept";
    if (yoloOn) {
        segments.push("yolo: on (Shift-Tab)", "?review");
    } else {
        segments.push("yolo: off (Shift-Tab)");
    }
    segments.push("!cmd", "@file", "/help");
    return segments.join(" · ");
};

export const EMPTY_COMPOSER_HINT = formatComposerHint();

export class ComposerEditor extends Editor {
    #placeholder: string;

    constructor(tui: TUI, theme: EditorTheme, options: EditorOptions, placeholder = "") {
        super(tui, theme, options);
        this.#placeholder = placeholder;
    }

    get placeholder(): string {
        return this.#placeholder;
    }

    setPlaceholder(placeholder: string): boolean {
        if (this.#placeholder === placeholder) return false;
        this.#placeholder = placeholder;
        return true;
    }

    override render(width: number): string[] {
        const lines = super.render(width);
        if (this.#placeholder.length === 0 || this.getText().length > 0 || lines.length < 3 || width <= 2) {
            return lines;
        }
        const safeHint = truncateToWidth(this.#placeholder, Math.max(1, width), "…", true);
        const firstChar = [...safeHint][0] ?? " ";
        const rest = safeHint.slice(firstChar.length);
        const marker = this.focused ? CURSOR_MARKER : "";
        const lead = `${marker}${renderFakeCursor(styled("dim")(firstChar))}${rest.length > 0 ? styled("dim")(rest) : ""}`;
        const pad = " ".repeat(Math.max(0, width - visibleWidth(safeHint)));
        const copy = [...lines];
        copy[1] = `${lead}${pad}`;
        return copy;
    }
}
