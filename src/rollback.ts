// workspace.rollback — the daemon reverses the bound worker's settled file mutations after a log
// coordinate, latest first, as this client's own operations, and reports what it did.
export interface RollbackReport {
    readonly to: string;
    readonly restored: ReadonlyArray<{ readonly coordinate: string; readonly path: string; readonly action: "update" | "create" | "delete" }>;
    readonly skipped: ReadonlyArray<{ readonly coordinate: string; readonly reason: "no-patch" | "already-reversed" }>;
    readonly stopped: null | { readonly coordinate: string; readonly path: string; readonly reason: "drift" | "refused"; readonly detail: string };
}

const ACTION: Record<RollbackReport["restored"][number]["action"], string> = {
    update: "restored", create: "recreated", delete: "removed",
};
const SKIPPED: Record<RollbackReport["skipped"][number]["reason"], string> = {
    "no-patch": "kept no patch", "already-reversed": "already reversed",
};

export const formatRollback = ({ to, restored, skipped, stopped }: RollbackReport): string => [
    `rollback: to log:///${to}`,
    ...restored.map(({ coordinate, path, action }) => `rollback: ${ACTION[action]} ${path} (log:///${coordinate})`),
    ...skipped.map(({ coordinate, reason }) => `rollback: skipped log:///${coordinate}, ${SKIPPED[reason]}`),
    ...(stopped === null
        ? [restored.length === 0 ? "rollback: nothing to reverse" : `rollback: ${restored.length} file mutation${restored.length === 1 ? "" : "s"} reversed, each as your own operation`]
        : [`rollback: stopped at log:///${stopped.coordinate} (${stopped.path}), ${stopped.reason}: ${stopped.detail}`]),
].join("\n");
