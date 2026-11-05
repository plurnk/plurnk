// Pure formatting, glyph resolution, and receipt-extraction helpers for SessionPresenter
// ({§cli-rendering}, {§cli-session-status}, {§cli-model-selection}).

export const OPERATION_GLYPH_MAP: Readonly<Record<string, string>> = {
    note: "🗒️",
    todo: "🚧",
    find: "🔎",
    read: "📖",
    edit: "📝",
    copy: "🖨️",
    move: "📦",
    kill: "🗑️",
    work: "🐜",
    fork: "🔱",
    bare: "☁️",
    wait: "⏳",
    send: "✉️",
    done: "🐹",
    warn: "⚠️",
    fail: "⛔",
    error: "⛔",
    info: "📌",
};

export const operationGlyphFor = (op: string | undefined): string => {
    if (typeof op === "string" && op in OPERATION_GLYPH_MAP) {
        return OPERATION_GLYPH_MAP[op]!;
    }
    if (typeof op === "string" && op.length > 0) {
        return `⚙️  ${op}`;
    }
    return "⚙️";
};

export const lifecycleGlyphFor = (lifecycle: string | undefined, status?: number): string => {
    switch (lifecycle) {
        case "queued":
            return "⏳";
        case "running":
            return "⌛︎";
        case "parked":
        case "requires_action":
            return "💤";
    }
    if (typeof status === "number" && status >= 400) {
        return status === 499 ? "🛑" : "❌";
    }
    switch (lifecycle) {
        case "cancelled":
            return "🛑";
        case "failed":
        case "error":
            return "❌";
        default:
            return "⏹️";
    }
};

export const extractTitleAside = (title: string | null | undefined): string | null => {
    if (typeof title !== "string") return null;
    const sepIdx = title.indexOf(" — ");
    if (sepIdx < 0) return null;
    const aside = title.slice(sepIdx + 3).trim();
    return aside.length > 0 ? aside : null;
};

export const extractTitleTarget = (title: string | null | undefined): string | null => {
    if (typeof title !== "string") return null;
    const head = title.includes(" — ") ? title.slice(0, title.indexOf(" — ")) : title;
    const parenMatch = head.match(/^\S+\s+\((.+)\)$/u);
    if (parenMatch?.[1]) return parenMatch[1];
    const spaceMatch = head.match(/^(?:read|edit|find|copy|move|kill)\s+(.+)$/u);
    return spaceMatch?.[1]?.trim() ?? null;
};

export const compactTarget = (target: string): string => {
    const clean = target.replace(/^file:\/\//u, "");
    const parts = clean.split("/").filter(Boolean);
    if (parts.length <= 2) return clean;
    return `…/${parts.slice(-2).join("/")}`;
};

export const formatLiveWait = (ms: number): string => {
    if (ms < 1000) return `${String(Math.max(1, Math.round(ms)))}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
};

export const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${String(Math.max(1, Math.round(ms)))}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3_600_000) {
        const m = Math.floor(ms / 60_000);
        const s = Math.floor((ms % 60_000) / 1000);
        return `${String(m)}m${String(s).padStart(2, "0")}s`;
    }
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    return `${String(h)}h${String(m).padStart(2, "0")}m`;
};

export const abbreviatedCount = (n: number): string => {
    if (n < 1000) return String(n);
    if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/u, "")}k`;
    if (n < 1_000_000) return `${String(Math.round(n / 1000))}k`;
    if (n < 10_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
    if (n < 1_000_000_000) return `${String(Math.round(n / 1_000_000))}M`;
    return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/u, "")}B`;
};

export const formatUsdSpend = (
    costUsd: string | null,
    options?: { readonly hasUnknownCost?: boolean },
): string | null => {
    const hasUnknown = options?.hasUnknownCost === true;
    if (costUsd !== null && costUsd.length > 0) {
        const num = Number(costUsd);
        if (Number.isFinite(num) && num > 0) {
            const formatted = `$${num.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
            return hasUnknown ? `${formatted} + ?` : formatted;
        }
    }
    return hasUnknown ? "$?" : null;
};

export const addDecimal = (a: string | null, b: string): string => {
    if (a === null || a.length === 0) return b;
    if (b.length === 0) return a;
    const [aInt = "0", aFrac = ""] = a.split(".");
    const [bInt = "0", bFrac = ""] = b.split(".");
    const scale = Math.max(aFrac.length, bFrac.length);
    const aScaled = BigInt(aInt + aFrac.padEnd(scale, "0"));
    const bScaled = BigInt(bInt + bFrac.padEnd(scale, "0"));
    const sum = (aScaled + bScaled).toString().padStart(scale + 1, "0");
    if (scale === 0) return sum;
    const intPart = sum.slice(0, sum.length - scale);
    const fracPart = sum.slice(sum.length - scale).replace(/0+$/u, "");
    return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
};

export const formatModelRoute = (
    model: string,
    effort: string | null,
    effortSource: "default" | "explicit" | null,
): string => {
    if (
        model !== "none" &&
        model.length > 0 &&
        effort !== null &&
        effort.length > 0 &&
        !model.endsWith(`(${effort})`) &&
        !model.endsWith(`[${effort}]`)
    ) {
        return effortSource === "default" ? `${model}(${effort})` : `${model}[${effort}]`;
    }
    return model;
};

export const extractRawString = (val: unknown): string | null => {
    if (typeof val === "string" && val.length > 0) return val;
    if (val && typeof val === "object" && typeof (val as { raw?: unknown }).raw === "string") {
        const raw = (val as { raw: string }).raw;
        return raw.length > 0 ? raw : null;
    }
    return null;
};

export const extractScopeToken = (lineMarker: unknown): string | null => {
    if (!lineMarker || typeof lineMarker !== "object") return null;
    const marks = (lineMarker as { marks?: unknown }).marks;
    if (!Array.isArray(marks) || marks.length === 0) return null;
    const tokens = marks.filter((m): m is number | string => typeof m === "number" || typeof m === "string");
    return tokens.length > 0 ? `<${tokens.map(String).join(",")}>` : null;
};

export const spanLength = (span: unknown): number | null => {
    if (!Array.isArray(span) || span.length !== 2) return null;
    const [start, end] = span;
    if (typeof start !== "number" || typeof end !== "number") return null;
    return Math.max(0, end - start + 1);
};

export const receiptCountFor = (op: string, rawOutput: Record<string, unknown> | undefined): number | null => {
    if (!rawOutput) return null;
    const range =
        rawOutput.range && typeof rawOutput.range === "object"
            ? (rawOutput.range as { returned?: unknown; total?: unknown })
            : undefined;
    if (op === "read") {
        if (Array.isArray(rawOutput.lineOrdinals)) {
            return rawOutput.lineOrdinals.length;
        }
        return (
            spanLength(range?.returned) ??
            (typeof rawOutput.count === "number" ? rawOutput.count : null)
        );
    }
    if (op === "find") {
        return (
            spanLength(range?.returned) ??
            (typeof range?.total === "number" ? range.total : null) ??
            (typeof rawOutput.count === "number" ? rawOutput.count : null) ??
            (typeof rawOutput.matches === "number" ? rawOutput.matches : null)
        );
    }
    return typeof rawOutput.count === "number"
        ? rawOutput.count
        : typeof rawOutput.matches === "number"
          ? rawOutput.matches
          : null;
};

export const NO_PREVIEW_VERBS = new Set([
    "read",
    "find",
    "copy",
    "move",
    "bare",
    "wait",
    "note",
    "todo",
]);

export const WORKER_OPS = new Set(["work", "fork", "bare"]);

export const formatActiveOperationLead = (op: string): string => {
    const glyph = OPERATION_GLYPH_MAP[op];
    if (glyph !== undefined) {
        const sep = glyph.endsWith("\uFE0F") ? "  " : " ";
        return `${glyph}${sep}${op}`;
    }
    return operationGlyphFor(op);
};

export const normalizeWorkerKey = (raw: string): string => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return "worker";
    if (trimmed.startsWith("session://")) {
        const withoutScheme = trimmed.replace(/^session:\/\/\/?/u, "");
        const withoutCoord = withoutScheme.includes("#")
            ? withoutScheme.slice(0, withoutScheme.indexOf("#"))
            : withoutScheme;
        const clean = withoutCoord.replace(/^[~/]+/u, "").replace(/\/+$/u, "");
        return clean.length > 0 ? clean : "worker";
    }
    if (trimmed.includes("#")) {
        const afterHash = trimmed.slice(trimmed.indexOf("#") + 1).replace(/^[~/]+/u, "");
        return afterHash.length > 0 ? afterHash : trimmed;
    }
    const clean = trimmed.replace(/^[~/]+/u, "").replace(/\/+$/u, "");
    return clean.length > 0 ? clean : trimmed;
};
