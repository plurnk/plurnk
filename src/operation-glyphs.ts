// {§cli-operation-glyphs} Text-default symbols explicitly request emoji presentation.
const glyphs: Readonly<Record<string, string>> = {
    NOTE: "🗒️", FIND: "🔎", READ: "📖", EDIT: "📝", COPY: "🖨️", MOVE: "📦",
    KILL: "🗑️", WORK: "🐜", FORK: "🔱", BARE: "☁️", WAIT: "⏳", SEND: "✉️",
    "SEND [200]": "🐹", "SEND [499]": "❌",
    WARN: "⚠️", FAIL: "⛔", INFO: "📌", FACT: "📊", IDEA: "💡", PLAN: "🚧",
};

export const operationLabel = (name: string): string => Object.hasOwn(glyphs, name) ? glyphs[name]! : `⚙️ ${name}`;
