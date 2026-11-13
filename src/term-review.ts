// Inline proposal review and elicitation forms on `@earendil-works/pi-tui`
// ({§cli-inline-review}).

import { Container, decodeKittyPrintable, Editor, SelectList, Text, type Focusable } from "@earendil-works/pi-tui";
import { Validator } from "@plurnk/plurnk-contracts";
import TermSurface, { ModelText, editorTheme, paint } from "./term-surface.ts";

export type QuestionAnswer =
    | { kind: "next" }
    | { kind: "invalid"; message: string }
    | { kind: "complete"; content: Record<string, unknown> };

export interface QuestionChoice {
    readonly value: string;
    readonly label: string;
    readonly description?: string;
}

const extractTitledOptions = (list: unknown): QuestionChoice[] => {
    if (!Array.isArray(list) || list.length === 0) return [];
    const out: QuestionChoice[] = [];
    for (const item of list) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
        const rec = item as Record<string, unknown>;
        if (typeof rec.const !== "string") return [];
        const label = typeof rec.title === "string" && rec.title.length > 0 ? rec.title : rec.const;
        const description =
            typeof rec.description === "string" && rec.description.length > 0 ? rec.description : undefined;
        out.push(description !== undefined ? { value: rec.const, label, description } : { value: rec.const, label });
    }
    return out;
};

const extractFieldChoiceOptions = (field: Record<string, unknown>): QuestionChoice[] => {
    if (field.type === "string") {
        if (Array.isArray(field.enum) && field.enum.length > 0 && field.enum.every((v) => typeof v === "string")) {
            const names = Array.isArray(field.enumNames) ? field.enumNames : undefined;
            return (field.enum as string[]).map((v, idx) => ({
                value: v,
                label: typeof names?.[idx] === "string" && (names[idx] as string).length > 0 ? (names[idx] as string) : v,
            }));
        }
        return extractTitledOptions(field.oneOf ?? field.anyOf);
    }
    if (field.type === "array" && field.items !== null && typeof field.items === "object" && !Array.isArray(field.items)) {
        const items = field.items as Record<string, unknown>;
        if (Array.isArray(items.enum) && items.enum.length > 0 && items.enum.every((v) => typeof v === "string")) {
            const names = Array.isArray(items.enumNames) ? items.enumNames : undefined;
            return (items.enum as string[]).map((v, idx) => ({
                value: v,
                label: typeof names?.[idx] === "string" && (names[idx] as string).length > 0 ? (names[idx] as string) : v,
            }));
        }
        return extractTitledOptions(items.anyOf ?? items.oneOf);
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
        "enumNames",
        "oneOf",
        "anyOf",
        "items",
        "minItems",
        "maxItems",
        "uniqueItems",
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
        "_meta",
    ]);

    static #isSupportedField(field: unknown): field is Record<string, unknown> {
        if (field === null || typeof field !== "object" || Array.isArray(field)) return false;
        const rec = field as Record<string, unknown>;
        if (!Object.keys(rec).every((key) => QuestionForm.#FIELD_KEYS.has(key))) return false;
        if (rec.type === "string" || rec.type === "number" || rec.type === "integer" || rec.type === "boolean") {
            if ((rec.oneOf !== undefined || rec.anyOf !== undefined) && extractFieldChoiceOptions(rec).length === 0) {
                return false;
            }
            return true;
        }
        if (rec.type === "array") {
            return extractFieldChoiceOptions(rec).length > 0;
        }
        return false;
    }

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
            fields.every(([, field]) => QuestionForm.#isSupportedField(field))
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
        const description = typeof schema.description === "string" ? ` — ${schema.description}` : "";
        if (this.#fields.length === 1 && key === "answer" && typeof schema.title !== "string") {
            const reqHint = this.#required.has(key) ? "required" : "optional";
            if (this.multiSelect) return `Select options (${reqHint})${description}`;
            if (this.choices.length > 0) return `Select an option (${reqHint})${description}`;
            const type = typeof schema.type === "string" ? `${schema.type}; ` : "";
            return `Answer (${type}${this.#required.has(key) ? "required" : "optional; Enter skips"})${description}`;
        }
        const title = typeof schema.title === "string" ? `${schema.title} (${key})` : key;
        const type = typeof schema.type === "string" ? `${schema.type}; ` : "";
        const hint = `${type}${
            this.#required.has(key)
                ? "required"
                : this.choices.length > 0
                  ? "optional; select Skip to omit"
                  : "optional; Enter skips"
        }`;
        return `${title} (${hint})${description}`;
    }

    get choiceOptions(): ReadonlyArray<QuestionChoice> {
        const field = this.#fields?.[this.#index];
        return field === undefined ? [] : extractFieldChoiceOptions(field[1]);
    }

    get choices(): string[] {
        return this.choiceOptions.map((c) => c.value);
    }

    get multiSelect(): boolean {
        const field = this.#fields?.[this.#index];
        return field !== undefined && field[1].type === "array" && this.choiceOptions.length > 0;
    }

    get defaultSelection(): string[] {
        const field = this.#fields?.[this.#index];
        if (field === undefined || !Array.isArray(field[1].default)) return [];
        const allowed = new Set(this.choices);
        return (field[1].default as unknown[]).filter((v): v is string => typeof v === "string" && allowed.has(v));
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
            let value: unknown;
            if (this.multiSelect) {
                if (text.startsWith("[")) {
                    try {
                        value = JSON.parse(text);
                    } catch {
                        return { kind: "invalid", message: `${key} requires a JSON array value.` };
                    }
                } else {
                    value = text
                        .split(",")
                        .map((part) => part.trim())
                        .filter((part) => part.length > 0)
                        .map((part) => {
                            const ord = Number(part);
                            return Number.isInteger(ord) && ord >= 1 && ord <= choices.length
                                ? choices[ord - 1]!
                                : part;
                        });
                }
            } else {
                const ordinal = Number(text);
                value =
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
    readonly #surface: TermSurface;
    readonly #actions: ReviewActions;
    readonly #requests = new Map<string, GateRequest>();
    #control: Editor | SelectList | null = null;
    #focused = false;

    constructor(surface: TermSurface, actions: ReviewActions) {
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
        const choiceOptions = req.form.choiceOptions;
        if (req.form.multiSelect && choiceOptions.length > 0) {
            const selected = new Set<string>(req.form.defaultSelection);
            const buildMultiControl = (cursorIndex = 0): void => {
                const items = choiceOptions.map((opt, index) => ({
                    value: `toggle:${index}`,
                    label: `[${selected.has(opt.value) ? "x" : " "}] ${ModelText.plain(opt.label)}`,
                    ...(opt.description !== undefined ? { description: ModelText.plain(opt.description) } : {}),
                }));
                items.push({ value: "submit", label: `Submit (${selected.size} selected)` });
                if (req.form.optional) {
                    items.push({ value: "skip", label: "Skip (optional)" });
                }
                const control = new SelectList(
                    items,
                    Math.max(1, Math.floor(this.#surface.rows / 3)),
                    editorTheme.selectList,
                );
                control.setSelectedIndex(cursorIndex);
                control.onSelect = ({ value }) => {
                    if (value.startsWith("toggle:")) {
                        const idx = Number(value.slice("toggle:".length));
                        const opt = choiceOptions[idx];
                        if (opt !== undefined) {
                            if (selected.has(opt.value)) selected.delete(opt.value);
                            else selected.add(opt.value);
                            buildMultiControl(idx);
                            this.#show();
                        }
                        return;
                    }
                    if (value === "skip") {
                        this.#submitFormAnswer(req, "");
                        return;
                    }
                    const ordered = choiceOptions.map((o) => o.value).filter((v) => selected.has(v));
                    this.#submitFormAnswer(req, JSON.stringify(ordered));
                };
                req.control = control;
            };
            buildMultiControl(0);
        } else if (choiceOptions.length > 0) {
            const items = choiceOptions.map((opt, index) => ({
                value: String(index + 1),
                label: opt.value === req.form.freeResponseChoice ? "Free response" : ModelText.plain(opt.label),
                ...(opt.description !== undefined ? { description: ModelText.plain(opt.description) } : {}),
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
                              ? request.kind === "elicitation_form" && request.form.multiSelect
                                  ? "↑/↓: move · Space/Enter: toggle/submit · Esc: composer"
                                  : request.kind === "permission"
                                    ? "↑/↓ or y/e/n: choose · Enter: confirm · Shift-Tab: yolo on · Esc: composer"
                                    : "↑/↓: choose · Enter: confirm · Esc: composer"
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
        const current = this.#current;
        if (current?.busy) return;
        if (
            data === " " &&
            current?.kind === "elicitation_form" &&
            current.form.multiSelect &&
            this.#control instanceof SelectList
        ) {
            const item = this.#control.getSelectedItem();
            if (item !== null && item.value.startsWith("toggle:")) {
                this.#control.onSelect?.(item);
                return;
            }
        }
        if (current?.kind === "permission" && this.#control instanceof SelectList) {
            const ch = (data.length === 1 ? data : decodeKittyPrintable(data))?.toLowerCase();
            const shortcutIndex =
                ch === "y" || ch === "a"
                    ? 0
                    : ch === "e"
                      ? 1
                      : ch === "n" || ch === "r"
                        ? 2
                        : ch === "c"
                          ? 3
                          : undefined;
            if (shortcutIndex !== undefined) {
                this.#control.setSelectedIndex(shortcutIndex);
                this.#surface.requestRender();
                return;
            }
        }
        this.#control?.handleInput(data);
    }
}
