import { questionChoices } from "./proposal.ts";

export type QuestionAnswer =
    | { kind: "next" }
    | { kind: "invalid"; message: string }
    | { kind: "complete"; content: Record<string, unknown> };

export default class QuestionForm {
    readonly #fields: Array<[string, Record<string, unknown>]>;
    readonly #required: Set<string>;
    readonly #content: Record<string, unknown> = {};
    #index = 0;

    constructor(schema: Record<string, unknown>) {
        const properties = schema.properties ?? {};
        if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
            throw new Error("The question has no object-shaped properties.");
        }
        this.#fields = Object.entries(properties).map(([key, value]) => {
            if (value === null || typeof value !== "object" || Array.isArray(value)) {
                throw new Error(`Question field '${key}' has no schema object.`);
            }
            return [key, value as Record<string, unknown>];
        });
        this.#required = new Set(Array.isArray(schema.required) ? schema.required : []);
    }

    get prompt(): string {
        const field = this.#fields[this.#index];
        if (field === undefined) return "Press Enter to submit the empty form.";
        const [key, schema] = field;
        const title = typeof schema.title === "string" ? `${schema.title} (${key})` : key;
        const type = typeof schema.type === "string" ? `${schema.type}; ` : "";
        const hint = `${type}${this.#required.has(key) ? "required" : "optional; Enter skips"}`;
        const description = typeof schema.description === "string" ? ` — ${schema.description}` : "";
        return `${title} (${hint})${description}`;
    }

    get choices(): string[] {
        const field = this.#fields[this.#index];
        return field === undefined ? [] : questionChoices({ properties: { [field[0]]: field[1] } });
    }

    submit(line: string): QuestionAnswer {
        const field = this.#fields[this.#index];
        if (field === undefined) return line.trim() !== ""
            ? { kind: "invalid", message: "No fields remain. Press Enter to submit, or /cancel." }
            : { kind: "complete", content: { ...this.#content } };
        const [key, schema] = field;
        const text = line.trim();
        if (text === "" && this.#required.has(key)) {
            return { kind: "invalid", message: `${key} is required.` };
        }
        if (text !== "") {
            const choices = this.choices;
            const ordinal = Number(text);
            let value: unknown = choices.length > 0 && Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= choices.length
                ? choices[ordinal - 1] : text;
            const type = schema.type;
            if (type !== undefined && type !== "string") {
                try { value = JSON.parse(text); }
                catch { return { kind: "invalid", message: `${key} requires a JSON ${String(type)} value.` }; }
                const matches = type === "integer" ? Number.isInteger(value)
                    : type === "array" ? Array.isArray(value)
                        : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
                            : typeof value === type;
                if (!matches) return { kind: "invalid", message: `${key} requires a ${String(type)} value.` };
            }
            Object.defineProperty(this.#content, key, { value, enumerable: true, configurable: true });
        }
        this.#index++;
        return this.#index === this.#fields.length
            ? { kind: "complete", content: { ...this.#content } }
            : { kind: "next" };
    }
}
