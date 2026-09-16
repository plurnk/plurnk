import { questionChoices } from "./proposal.ts";
import { Validator } from "@plurnk/plurnk-contracts";

export type QuestionAnswer =
    | { kind: "next" }
    | { kind: "invalid"; message: string }
    | { kind: "complete"; content: Record<string, unknown> };

export default class QuestionForm {
    readonly #schema: Record<string, unknown>;
    readonly #fields: Array<[string, Record<string, unknown>]> | null;
    readonly #required: Set<string>;
    readonly #content: Record<string, unknown> = {};
    #index = 0;

    // Independent, directly typed fields can be prompted one at a time. Other
    // schemas stay whole so references and cross-field rules keep their context.
    static readonly #FORM_KEYS = new Set(["type", "properties", "required", "additionalProperties", "title", "description", "$schema"]);
    static readonly #FIELD_KEYS = new Set([
        "type", "title", "description", "enum", "const", "default", "examples",
        "format", "minLength", "maxLength", "pattern", "minimum", "maximum",
        "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
    ]);

    constructor(schema: Record<string, unknown>) {
        this.#schema = schema;
        const properties = schema.properties ?? {};
        if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
            throw new Error("The question has no object-shaped properties.");
        }
        const fields = Object.entries(properties);
        this.#required = new Set(Array.isArray(schema.required) ? schema.required : []);
        this.#fields = (schema.type === undefined || schema.type === "object")
            && Object.keys(schema).every((key) => QuestionForm.#FORM_KEYS.has(key))
            && [...this.#required].every((key) => Object.hasOwn(properties, key))
            && fields.every(([, field]) => field !== null && typeof field === "object" && !Array.isArray(field)
                && typeof field.type === "string"
                && Object.keys(field).every((key) => QuestionForm.#FIELD_KEYS.has(key)))
            ? fields as Array<[string, Record<string, unknown>]> : null;
    }

    get prompt(): string {
        if (this.#fields === null) return `Response (JSON object matching this schema):\n${JSON.stringify(this.#schema, null, 2)}`;
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
        const field = this.#fields?.[this.#index];
        return field === undefined || field[1].type !== "string" ? [] : questionChoices({ properties: { [field[0]]: field[1] } });
    }

    static #validation(schema: Record<string, unknown>, value: unknown, label: string): QuestionAnswer | null {
        const result = Validator.validateJsonSchemaInstance(schema, value);
        return result.valid ? null : {
            kind: "invalid",
            message: `${label} does not satisfy its schema: ${result.errors.map(({ instanceLocation, error }) => `${instanceLocation}: ${error}`).join("; ")}`,
        };
    }

    submit(line: string): QuestionAnswer {
        if (this.#fields === null) {
            let value: unknown;
            try { value = JSON.parse(line); }
            catch { return { kind: "invalid", message: "Response requires valid JSON." }; }
            if (value === null || typeof value !== "object" || Array.isArray(value)) {
                return { kind: "invalid", message: "Response requires a JSON object." };
            }
            return QuestionForm.#validation(this.#schema, value, "Response")
                ?? { kind: "complete", content: value as Record<string, unknown> };
        }
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
            }
            const invalid = QuestionForm.#validation(schema, value, key);
            if (invalid !== null) return invalid;
            Object.defineProperty(this.#content, key, { value, enumerable: true, configurable: true });
        }
        this.#index++;
        return this.#index === this.#fields.length
            ? QuestionForm.#validation(this.#schema, this.#content, "Response")
                ?? { kind: "complete", content: { ...this.#content } }
            : { kind: "next" };
    }
}
