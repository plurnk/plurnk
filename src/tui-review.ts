// Inline proposal review and elicitation forms on `@earendil-works/pi-tui`
// ({§cli-inline-review}, {§cli-inline-review}, {§cli-inline-review}).

import { Container, Editor, SelectList, Text, type Focusable } from "@earendil-works/pi-tui";
import { Validator } from "@plurnk/plurnk-contracts";
import TuiSurface, { ModelText, editorTheme, paint } from "./tui-surface.ts";

export type QuestionAnswer =
    | { kind: "next" }
    | { kind: "invalid"; message: string }
    | { kind: "complete"; content: Record<string, unknown> };

const extractQuestionChoices = (schema: Record<string, unknown>): string[] => {
    const props = schema.properties;
    if (!props || typeof props !== "object" || Array.isArray(props)) return [];
    const entries = Object.values(props as Record<string, Record<string, unknown>>);
    if (entries.length !== 1) return [];
    const field = entries[0]!;
    if (Array.isArray(field.enum) && field.enum.every((v) => typeof v === "string")) {
        return field.enum as string[];
    }
    if (Array.isArray(field.oneOf)) {
        const vals = field.oneOf
            .map((item) => (item && typeof item === "object" ? (item as { const?: unknown }).const : undefined))
            .filter((v): v is string => typeof v === "string");
        if (vals.length === field.oneOf.length) return vals;
    }
    return [];
};

export class QuestionForm {
    readonly #schema: Record<string, unknown>;
    readonly #toolName: string | undefined;
    readonly #fields: Array<[string, Record<string, unknown>]> | null;
    readonly #required: Set<string>;
    readonly #content: Record<string, unknown> = {};
    #index = 0;

    static readonly #FORM_KEYS = new Set([
        "type",
        "properties",
        "required",
        "additionalProperties",
        "title",
        "description",
        "$schema",
    ]);
    static readonly #FIELD_KEYS = new Set([
        "type",
        "title",
        "description",
        "enum",
        "const",
        "default",
        "examples",
        "format",
        "minLength",
        "maxLength",
        "pattern",
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
    ]);

    constructor(schema: Record<string, unknown>, toolName?: string) {
        this.#schema = schema;
        this.#toolName = toolName;
        const properties = schema.properties ?? {};
        if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
            this.#required = new Set();
            this.#fields = null;
            return;
        }
        const fields = Object.entries(properties as Record<string, unknown>);
        this.#required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
        this.#fields =
            (schema.type === undefined || schema.type === "object") &&
            Object.keys(schema).every((key) => QuestionForm.#FORM_KEYS.has(key)) &&
            [...this.#required].every((key) => Object.hasOwn(properties, key)) &&
            fields.every(
                ([, field]) =>
                    field !== null &&
                    typeof field === "object" &&
                    !Array.isArray(field) &&
                    typeof (field as Record<string, unknown>).type === "string" &&
                    Object.keys(field as Record<string, unknown>).every((key) => QuestionForm.#FIELD_KEYS.has(key)),
            )
                ? (fields as Array<[string, Record<string, unknown>]>)
                : null;
    }

    get prompt(): string {
        if (this.#fields === null) {
            return `Response (JSON object matching this schema):\n${JSON.stringify(this.#schema, null, 2)}`;
        }
        const field = this.#fields[this.#index];
        if (field === undefined) return "Press Enter to submit the empty form.";
        const [key, schema] = field;
        const title = typeof schema.title === "string" ? `${schema.title} (${key})` : key;
        const type = typeof schema.type === "string" ? `${schema.type}; ` : "";
        const hint = `${type}${
            this.#required.has(key)
                ? "required"
                : this.choices.length > 0
                  ? "optional; select Skip to omit"
                  : "optional; Enter skips"
        }`;
        const description = typeof schema.description === "string" ? ` — ${schema.description}` : "";
        return `${title} (${hint})${description}`;
    }

    get choices(): string[] {
        const field = this.#fields?.[this.#index];
        return field === undefined || field[1].type !== "string"
            ? []
            : extractQuestionChoices({ properties: { [field[0]]: field[1] } });
    }

    get optional(): boolean {
        const field = this.#fields?.[this.#index];
        return field !== undefined && !this.#required.has(field[0]);
    }

    get #details(): Array<[string, Record<string, unknown>]> {
        const remaining = this.#fields?.slice(this.#index + 1) ?? [];
        return this.#toolName === "question" &&
            this.choices.length > 0 &&
            remaining.every(([, schema]) => schema.type === "string" && schema.enum === undefined)
            ? remaining
            : [];
    }

    get freeResponseChoice(): string | null {
        return this.#details.length > 0 && this.choices.includes("other") ? "other" : null;
    }

    static #validation(schema: Record<string, unknown>, value: unknown, label: string): QuestionAnswer | null {
        const result = Validator.validateJsonSchemaInstance(schema as never, value);
        return result.valid
            ? null
            : {
                  kind: "invalid",
                  message: `${label} does not satisfy its schema: ${result.errors
                      .map(({ instanceLocation, error }) => `${instanceLocation}: ${error}`)
                      .join("; ")}`,
              };
    }

    submit(line: string): QuestionAnswer {
        if (this.#fields === null) {
            let value: unknown;
            try {
                value = JSON.parse(line);
            } catch {
                return { kind: "invalid", message: "Response requires valid JSON." };
            }
            if (value === null || typeof value !== "object" || Array.isArray(value)) {
                return { kind: "invalid", message: "Response requires a JSON object." };
            }
            return (
                QuestionForm.#validation(this.#schema, value, "Response") ?? {
                    kind: "complete",
                    content: value as Record<string, unknown>,
                }
            );
        }
        const field = this.#fields[this.#index];
        if (field === undefined) {
            return line.trim() !== ""
                ? { kind: "invalid", message: "No fields remain. Press Enter to submit." }
                : { kind: "complete", content: { ...this.#content } };
        }
        const [key, schema] = field;
        const text = line.trim();
        if (text === "" && this.#required.has(key)) {
            return { kind: "invalid", message: `${key} is required.` };
        }
        if (text !== "") {
            const choices = this.choices;
            const ordinal = Number(text);
            let value: unknown =
                choices.length > 0 && Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= choices.length
                    ? choices[ordinal - 1]
                    : text;
            const type = schema.type;
            if (type !== undefined && type !== "string") {
                try {
                    value = JSON.parse(text);
                } catch {
                    return { kind: "invalid", message: `${key} requires a JSON ${String(type)} value.` };
                }
            }
            const invalid = QuestionForm.#validation(schema, value, key);
            if (invalid !== null) return invalid;
            Object.defineProperty(this.#content, key, { value, enumerable: true, configurable: true });
        } else {
            delete this.#content[key];
        }
        const details = this.#details;
        const fixedChoice =
            text !== "" &&
            this.#content[key] !== "other" &&
            details.length > 0 &&
            details.every(([name]) => !this.#required.has(name));
        if (fixedChoice || this.#index === this.#fields.length - 1) {
            return (
                QuestionForm.#validation(this.#schema, this.#content, "Response") ?? {
                    kind: "complete",
                    content: { ...this.#content },
                }
            );
        }
        this.#index++;
        return { kind: "next" };
    }
}

export interface PermissionGateEvent {
    readonly sessionUpdate?: "permission_request";
    readonly id: string;
    readonly title: string;
    readonly options?: ReadonlyArray<{
        readonly optionId: string;
        readonly name: string;
        readonly kind?: string;
    }>;
    readonly _meta?: Record<string, unknown>;
}

export interface ElicitationGateEvent {
    readonly sessionUpdate?: "elicitation_request";
    readonly id: string;
    readonly mode: "form" | "url";
    readonly message: string;
    readonly url?: string;
    readonly requestedSchema?: Record<string, unknown>;
    readonly _meta?: Record<string, unknown>;
}

export const isPermissionGateEvent = (value: unknown): value is PermissionGateEvent =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { title?: unknown }).title === "string";

export const isElicitationGateEvent = (value: unknown): value is ElicitationGateEvent =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    ((value as { mode?: unknown }).mode === "form" || (value as { mode?: unknown }).mode === "url") &&
    typeof (value as { message?: unknown }).message === "string";

interface ReviewActions {
    readonly sendStdin: (commandLine: string) => void;
    readonly editBody: (initialBody: string) => Promise<string | null>;
    readonly record: (text: string) => void;
}

type GateRequest = {
    id: string;
    title: string;
    details: string;
    control: Editor | SelectList;
    error: string;
    busy: boolean;
} & (
    | {
          kind: "permission";
          initialBody: string;
      }
    | {
          kind: "elicitation_url";
      }
    | {
          kind: "elicitation_form";
          form: QuestionForm;
      }
);

export default class Review extends Container implements Focusable {
    readonly #surface: TuiSurface;
    readonly #actions: ReviewActions;
    readonly #requests = new Map<string, GateRequest>();
    #control: Editor | SelectList | null = null;
    #focused = false;

    constructor(surface: TuiSurface, actions: ReviewActions) {
        super();
        this.#surface = surface;
        this.#actions = actions;
    }

    get focused(): boolean {
        return this.#focused;
    }

    set focused(value: boolean) {
        this.#focused = value;
        if (this.#control instanceof Editor) {
            this.#control.focused = value;
        }
    }

    get waiting(): number {
        return this.#requests.size;
    }

    get focusedGateId(): string | undefined {
        return this.#requests.keys().next().value;
    }

    get #current(): GateRequest | undefined {
        return this.#requests.values().next().value;
    }

    addPermissionGate(event: PermissionGateEvent): void {
        if (this.#requests.has(event.id)) return;
        const plurnkMeta = (event._meta?.plurnk ?? {}) as Record<string, unknown>;
        const proposal = (plurnkMeta.proposal ?? plurnkMeta) as Record<string, unknown>;
        const initialBody = typeof proposal.body === "string" ? proposal.body : "";
        const control = new SelectList(
            [
                { value: "accept", label: "Accept" },
                { value: "edit", label: "Edit", description: "$VISUAL / $EDITOR" },
                { value: "reject", label: "Reject" },
                { value: "cancel", label: "Cancel" },
            ],
            4,
            editorTheme.selectList,
        );
        const req: GateRequest = {
            id: event.id,
            kind: "permission",
            title: `@${event.id} · ${event.title}`,
            details: initialBody.length > 0 ? ModelText.plain(initialBody) : "",
            initialBody,
            control,
            error: "",
            busy: false,
        };
        control.onSelect = ({ value }) => {
            void this.#decidePermission(req, value as "accept" | "edit" | "reject" | "cancel");
        };
        this.#requests.set(req.id, req);
        this.#show();
    }

    addElicitationGate(event: ElicitationGateEvent): void {
        if (this.#requests.has(event.id)) return;
        if (event.mode === "url") {
            const control = new SelectList(
                [
                    { value: "accept", label: "Accept" },
                    { value: "reject", label: "Decline" },
                    { value: "cancel", label: "Cancel" },
                ],
                3,
                editorTheme.selectList,
            );
            const req: GateRequest = {
                id: event.id,
                kind: "elicitation_url",
                title: `@${event.id} · elicitation`,
                details: `${ModelText.plain(event.message)}${event.url ? `\n${ModelText.plain(event.url)}` : ""}`,
                control,
                error: "",
                busy: false,
            };
            control.onSelect = ({ value }) => {
                if (value === "accept") {
                    this.#actions.sendStdin(`/approve @${req.id}\n`);
                } else if (value === "reject") {
                    this.#actions.sendStdin(`/reject @${req.id}\n`);
                } else {
                    this.#actions.sendStdin(`/cancel @${req.id}\n`);
                }
            };
            this.#requests.set(req.id, req);
            this.#show();
            return;
        }

        const schema = event.requestedSchema ?? { type: "object", properties: {} };
        const plurnkMeta = (event._meta?.plurnk ?? {}) as Record<string, unknown>;
        const toolName = typeof plurnkMeta.toolName === "string" ? plurnkMeta.toolName : "question";
        const req: GateRequest = {
            id: event.id,
            kind: "elicitation_form",
            title: `@${event.id} · question`,
            details: ModelText.plain(event.message),
            form: new QuestionForm(schema, toolName),
            control: this.#surface.createEditor(),
            error: "",
            busy: false,
        };
        this.#configureFormControl(req);
        this.#requests.set(req.id, req);
        this.#show();
    }

    remove(id: string): void {
        if (!this.#requests.delete(id)) return;
        this.#show();
    }

    async #decidePermission(
        req: GateRequest & { kind: "permission" },
        action: "accept" | "edit" | "reject" | "cancel",
    ): Promise<void> {
        if (req.busy || !this.#requests.has(req.id)) return;
        req.busy = true;
        req.error = "";
        this.#show();
        try {
            if (action === "edit") {
                const edited = await this.#actions.editBody(req.initialBody);
                if (!this.#requests.has(req.id)) return;
                if (edited === null) {
                    req.busy = false;
                    this.#show();
                    return;
                }
                this.#actions.sendStdin(`\x1b[200~/edit @${req.id} ${edited}\x1b[201~\n`);
                return;
            }
            if (action === "accept") {
                this.#actions.sendStdin(`/approve @${req.id}\n`);
            } else if (action === "reject") {
                this.#actions.sendStdin(`/reject @${req.id}\n`);
            } else {
                this.#actions.sendStdin(`/cancel @${req.id}\n`);
            }
        } finally {
            req.busy = false;
            this.#show();
        }
    }

    #configureFormControl(req: GateRequest & { kind: "elicitation_form" }): void {
        const choices = req.form.choices;
        if (choices.length > 0) {
            const items = choices.map((label, index) => ({
                value: String(index + 1),
                label: label === req.form.freeResponseChoice ? "Free response" : ModelText.plain(label),
            }));
            if (req.form.optional) {
                items.push({ value: "", label: "Skip (optional)" });
            }
            const control = new SelectList(
                items,
                Math.max(1, Math.floor(this.#surface.rows / 3)),
                editorTheme.selectList,
            );
            control.onSelect = ({ value }) => {
                this.#submitFormAnswer(req, value);
            };
            req.control = control;
        } else {
            const control = this.#surface.createEditor();
            control.onSubmit = (line) => {
                this.#submitFormAnswer(req, line);
            };
            req.control = control;
        }
    }

    #submitFormAnswer(req: GateRequest & { kind: "elicitation_form" }, line: string): void {
        if (req.busy || !this.#requests.has(req.id)) return;
        let answer: QuestionAnswer;
        try {
            answer = req.form.submit(line);
        } catch {
            req.error = "Answer validation failed.";
            if (req.control instanceof Editor) req.control.setText(line);
            this.#show();
            return;
        }
        req.error = "";
        if (answer.kind === "invalid") {
            req.error = answer.message;
            if (req.control instanceof Editor) req.control.setText(line);
            this.#show();
            return;
        }
        if (answer.kind === "next") {
            this.#configureFormControl(req);
            this.#show();
            return;
        }
        this.#actions.sendStdin(`\x1b[200~/answer @${req.id} ${JSON.stringify(answer.content)}\x1b[201~\n`);
    }

    #show(): void {
        if (this.#control instanceof Editor) {
            this.#control.focused = false;
        }
        this.clear();
        const request = this.#current;
        this.#control = request?.control ?? null;
        if (request !== undefined) {
            this.addChild(new Text(paint(ModelText.plain(request.title), "bold"), 0, 0));
            if (request.details.length > 0) {
                this.addChild(new Text(request.details, 0, 0));
            }
            if (request.kind === "elicitation_form") {
                this.addChild(new Text(ModelText.plain(request.form.prompt), 0, 0));
            }
            if (request.error.length > 0) {
                this.addChild(new Text(paint(ModelText.plain(request.error), "failure"), 0, 0));
            }
            this.addChild(request.control);
            this.addChild(
                new Text(
                    paint(
                        request.busy
                            ? "Submitting… · Esc: composer"
                            : request.control instanceof SelectList
                              ? "↑/↓: choose · Enter: confirm · Esc: composer"
                              : "Enter: submit · Shift-Enter: newline · Esc: composer",
                        "dim",
                    ),
                    0,
                    0,
                ),
            );
        }
        this.#surface.setReview(request === undefined ? null : this, this.#requests.size);
    }

    handleInput(data: string): void {
        if (!this.#current?.busy) {
            this.#control?.handleInput(data);
        }
    }
}
