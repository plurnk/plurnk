import { Container, Editor, SelectList, Text, type Focusable } from "@earendil-works/pi-tui";
import { paint } from "./color.ts";
import ModelText from "./model-text.ts";
import QuestionForm, { type QuestionAnswer } from "./QuestionForm.ts";
import { formatTarget, renderBody, type ProposalParams, type Resolution } from "./proposal.ts";
import type { RunHandlers } from "./transport.ts";
import TuiSurface, { editorTheme } from "./tui-surface.ts";

type Question = Parameters<NonNullable<RunHandlers["onInteraction"]>>[0];
type Action = "accept" | "edit" | "reject" | "cancel";
type Request = {
    id: string;
    title: string;
    details: string;
    control: Editor | SelectList;
    error: string;
    busy: boolean;
} & ({ kind: "proposal"; proposal: ProposalParams } | { kind: "question"; question: Question; form: QuestionForm });

interface Actions {
    resolveProposal: (proposal: ProposalParams, resolution: Resolution) => Promise<void>;
    editProposal: (proposal: ProposalParams) => Promise<Resolution>;
    resolveQuestion: (id: number, answer: Record<string, unknown> | "cancel") => Promise<void>;
    record: (text: string) => void;
    error: (cause: unknown) => void;
}

/** {§cli-inline-review} — a view of transport-owned interrupts, not another run lifecycle. */
export default class Review extends Container implements Focusable {
    readonly #surface: TuiSurface;
    readonly #actions: Actions;
    readonly #requests = new Map<string, Request>();
    #control: Editor | SelectList | null = null;
    #focused = false;

    constructor(surface: TuiSurface, actions: Actions) {
        super();
        this.#surface = surface;
        this.#actions = actions;
    }

    get focused(): boolean { return this.#focused; }
    set focused(value: boolean) {
        this.#focused = value;
        if (this.#control instanceof Editor) this.#control.focused = value;
    }

    get #current(): Request | undefined { return this.#requests.values().next().value; }

    addProposal(proposal: ProposalParams): void {
        const control = new SelectList([
            { value: "accept", label: "Accept" },
            { value: "edit", label: "Edit", description: "$VISUAL / $EDITOR" },
            { value: "reject", label: "Reject" },
            { value: "cancel", label: "Cancel" },
        ], 4, editorTheme.selectList);
        const request: Request = {
            id: `prop:${proposal.logEntryId}`, kind: "proposal", proposal, control,
            title: `proposal ${proposal.op} ${formatTarget(proposal.target, proposal.op)}`,
            details: renderBody(proposal.op, ModelText.plain(proposal.body)), error: "", busy: false,
        };
        control.onSelect = ({ value }) => { void this.#decide(request, value as Action); };
        this.#add(request);
    }

    addQuestion(question: Question): void {
        const request: Request = {
            id: `int:${question.interactionId}`, kind: "question", question,
            form: new QuestionForm(question.responseSchema), control: this.#surface.createEditor(),
            title: "question", details: ModelText.plain(question.message), error: "", busy: false,
        };
        this.#questionControl(request);
        this.#add(request);
    }

    #add(request: Request): void {
        if (this.#requests.has(request.id)) throw new Error(`Duplicate review interrupt ${request.id}.`);
        this.#requests.set(request.id, request);
        this.#show();
    }

    remove(id: string): void {
        if (!this.#requests.delete(id)) return;
        this.#show();
    }

    async decide(action: Action): Promise<void> {
        const request = this.#current;
        if (request === undefined) { this.#actions.record("  (no pending review)"); return; }
        await this.#decide(request, action);
    }

    async #decide(request: Request, action: Action): Promise<void> {
        if (request.kind === "question") {
            if (action !== "cancel") {
                this.#actions.record("  Answer the pending question with /review, or /cancel.");
                return;
            }
            await this.#settle(request, async () => {
                await this.#actions.resolveQuestion(request.question.interactionId, "cancel");
                return "cancelled";
            });
            return;
        }
        await this.#settle(request, async () => {
            const resolution = action === "edit"
                ? await this.#actions.editProposal(request.proposal) : { decision: action };
            // The external editor can outlive its interrupt. Never apply its result to a successor.
            if (!this.#requests.has(request.id)) return null;
            await this.#actions.resolveProposal(request.proposal, resolution);
            return { accept: "accepted", reject: "rejected", cancel: "cancelled" }[resolution.decision];
        });
    }

    #questionControl(request: Request & { kind: "question" }): void {
        const choices = request.form.choices;
        if (choices.length > 0) {
            const items = choices.map((label, index) => ({ value: String(index + 1), label: ModelText.plain(label) }));
            if (request.form.optional) items.push({ value: "", label: "Skip (optional)" });
            const control = new SelectList(items, Math.max(1, Math.floor(this.#surface.rows / 3)), editorTheme.selectList);
            control.onSelect = ({ value }) => { this.#answer(request, value); };
            request.control = control;
        } else {
            const control = this.#surface.createEditor();
            control.onSubmit = (line) => { this.#answer(request, line); };
            request.control = control;
        }
    }

    #answer(request: Request & { kind: "question" }, line: string): void {
        if (request.busy || !this.#requests.has(request.id)) return;
        let answer: QuestionAnswer;
        try { answer = request.form.submit(line); }
        catch (cause) {
            request.error = "Answer validation failed.";
            if (request.control instanceof Editor) request.control.setText(line);
            this.#actions.error(cause);
            this.#show();
            return;
        }
        request.error = "";
        if (answer.kind === "invalid") {
            request.error = answer.message;
            if (request.control instanceof Editor) request.control.setText(line);
        } else if (answer.kind === "next") this.#questionControl(request);
        else {
            if (request.control instanceof Editor) request.control.setText(line);
            void this.#settle(request, async () => {
                await this.#actions.resolveQuestion(request.question.interactionId, answer.content);
                return "answered";
            });
            return;
        }
        this.#show();
    }

    async #settle(request: Request, work: () => Promise<string | null>): Promise<void> {
        if (request.busy || !this.#requests.has(request.id)) return;
        request.busy = true;
        request.error = "";
        this.#show();
        try {
            const result = await work();
            if (result !== null) this.#actions.record(`  ${ModelText.plain(request.title)} — ${result}`);
        } catch (cause) {
            request.error = "Resolution failed; the request remains available while pending.";
            this.#actions.error(cause);
        } finally {
            request.busy = false;
            this.#show();
        }
    }

    #show(): void {
        if (this.#control instanceof Editor) this.#control.focused = false;
        this.clear();
        const request = this.#current;
        this.#control = request?.control ?? null;
        if (request !== undefined) {
            this.addChild(new Text(paint(ModelText.plain(request.title), "bold"), 0, 0));
            this.addChild(new Text(request.details, 0, 0));
            if (request.kind === "question") this.addChild(new Text(ModelText.plain(request.form.prompt), 0, 0));
            if (request.error) this.addChild(new Text(paint(ModelText.plain(request.error), "failure"), 0, 0));
            this.addChild(request.control);
            this.addChild(new Text(paint(request.busy ? "Submitting… · Esc: composer" :
                request.control instanceof SelectList ? "↑/↓: choose · Enter: confirm · Esc: composer" :
                    "Enter: submit · Shift-Enter: newline · Esc: composer", "dim"), 0, 0));
        }
        this.#surface.setReview(request === undefined ? null : this, this.#requests.size);
    }

    handleInput(data: string): void {
        if (!this.#current?.busy) this.#control?.handleInput(data);
    }
}
