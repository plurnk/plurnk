import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Container, Editor, SelectList, Text, matchesKey, type Focusable } from "@earendil-works/pi-tui";
import { completePath } from "./completion.ts";
import type Lifetime from "./lifetime.ts";
import TuiSurface, { editorTheme } from "./tui-surface.ts";
import TerminalGuards from "./tui-guards.ts";

class FolderChoice extends Container implements Focusable {
    readonly #editor: Editor;
    readonly #menu: SelectList;
    readonly #label = new Text("Launched from your home directory. Choose a project folder:", 0, 0);
    readonly #error = new Text("", 0, 0);
    readonly #done: (root: string | null | undefined) => void;
    #editing = false;
    #busy = false;
    #closed = false;

    constructor(surface: TuiSurface, home: string, done: (root: string | null | undefined) => void) {
        super();
        this.#done = (root) => { this.#closed = true; done(root); };
        this.#editor = surface.createEditor();
        const expand = (path: string): string => path === "~" ? home : path.startsWith("~/") ? `${home}/${path.slice(2)}` : path;
        this.#editor.setAutocompleteProvider({
            triggerCharacters: ["/"],
            getSuggestions: async (lines, row, col) => {
                const prefix = lines[row].slice(0, col);
                const [hits] = await completePath(expand(prefix), home);
                const items = hits.filter((path) => path.endsWith("/")).map((value) => ({ value, label: value }));
                return items.length > 0 ? { items, prefix } : null;
            },
            applyCompletion: (lines, row, col, item, prefix) => ({
                lines: lines.map((line, index) => index === row ? line.slice(0, col - prefix.length) + item.value + line.slice(col) : line),
                cursorLine: row, cursorCol: col - prefix.length + item.value.length,
            }),
        });
        this.#editor.onSubmit = (text) => {
            if (this.#busy) return;
            this.#busy = true;
            void (async () => {
                try {
                    if (text.trim().length === 0) throw new Error("Enter a project folder.");
                    const path = resolve(home, expand(text));
                    if (!(await stat(path)).isDirectory()) throw new Error("That path is not a directory.");
                    if (!this.#closed) this.#done(path);
                } catch (cause) {
                    if (!this.#closed) {
                        this.#error.setText(cause instanceof Error ? cause.message : String(cause));
                        this.#editor.setText(text);
                        surface.requestRender();
                    }
                } finally { this.#busy = false; }
            })();
        };
        this.#menu = new SelectList([
            { value: "folder", label: "Choose a project folder" },
            { value: "headless", label: "No project folder" },
            { value: "home", label: "Use home directory", description: home },
        ], 3, editorTheme.selectList);
        this.#menu.onSelect = ({ value }) => {
            if (value !== "folder") { this.#done(value === "headless" ? null : home); return; }
            this.#editing = true;
            this.#label.setText("Project folder (Tab completes; Esc cancels):");
            this.clear();
            this.addChild(this.#label);
            this.addChild(this.#error);
            this.addChild(this.#editor);
            this.#editor.focused = true;
        };
        this.addChild(this.#label);
        this.addChild(this.#menu);
    }

    get focused(): boolean { return this.#editor.focused; }
    set focused(value: boolean) { this.#editor.focused = value && this.#editing; }

    handleInput(data: string): void {
        if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "ctrl+d")) this.#done(undefined);
        else if (this.#editing) this.#editor.handleInput(data);
        else this.#menu.handleInput(data);
    }
}

export default async function promptProjectRoot(home: string, lifetime: Lifetime, existing?: TuiSurface): Promise<string | null | undefined> {
    const surface = existing ?? new TuiSurface();
    const release = existing === undefined ? TerminalGuards.install(surface, lifetime) : undefined;
    try {
        const result = new Promise<string | null | undefined>((done) => surface.setDialog(new FolderChoice(surface, home, done)));
        if (existing === undefined) surface.start();
        return await result;
    } finally {
        surface.setDialog(null);
        if (existing === undefined) surface.stop();
        release?.();
    }
}
