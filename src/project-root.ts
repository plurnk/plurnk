import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { actionViaAgui, type AguiTarget } from "./agui.ts";
import { clientFlagInvalid, clientProblem, ProblemError } from "./diagnostics.ts";

export const resolveProjectRoot = (raw: string | undefined, cwd = process.cwd()): string | null => {
    if (raw === undefined) return cwd;
    if (raw.length === 0) return null;
    if (!isAbsolute(raw)) throw new ProblemError(clientFlagInvalid("--project-root", raw, "must be an absolute path"));
    return raw;
};

type ChooseProjectRoot = (home: string) => Promise<string | null | undefined>;

/** {§cli-project-root}: a creation default, not authority over an existing workspace. */
export default class ProjectRoot {
    readonly #target: AguiTarget;
    readonly #cwd: string;
    readonly #home: string;
    #explicit: boolean;
    #root: string | null;

    constructor(target: AguiTarget, raw: string | undefined, cwd = process.cwd(), home = homedir()) {
        this.#target = target;
        this.#cwd = cwd;
        this.#home = home;
        this.#explicit = raw !== undefined;
        this.#root = resolveProjectRoot(raw, cwd);
    }

    async resolve(workspace: string | undefined, choose?: ChooseProjectRoot): Promise<string | null | undefined> {
        if (workspace !== undefined) {
            const { workspaces } = await actionViaAgui<{ workspaces: { name: string; project_root: string | null }[] }>(
                this.#target, { threadId: "bootstrap", kind: "workspace.list" },
            );
            const existing = workspaces.find(({ name }) => name === workspace);
            if (existing !== undefined) {
                if (existing.project_root !== null && typeof existing.project_root !== "string") {
                    throw new Error("workspace.list returned a workspace without its project_root.");
                }
                return existing.project_root;
            }
        }
        if (this.#explicit) return this.#root;
        const [cwd, home] = await Promise.all([realpath(this.#cwd), realpath(this.#home)]);
        if (cwd !== home) return this.#root;
        if (choose === undefined) throw new ProblemError(clientProblem(
            "project-root", "required", 400,
            "Choose a project folder before creating a workspace from your home directory.",
            { recovery: "Use --project-root=/absolute/project, --project-root= for no folder, or explicitly select your home directory." },
        ));
        const selected = await choose(this.#home);
        if (selected !== undefined) {
            this.#root = selected;
            this.#explicit = true;
        }
        return selected;
    }
}
