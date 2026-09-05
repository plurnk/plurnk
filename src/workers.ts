// The workspace directory as a topology ({§cli-workers-topology}): a forest of
// parent/child trees from `workspace.workers`, the bound worker's tree first.
export interface WorkerRow {
    id: number;
    name: string;
    created_at: string;
    origin?: "model" | "client" | "_plurnk";
    parentWorkerId?: number | null;
}

// A `worker://<name>` reference names a worker; `worker://~/…` and `worker:///…`
// are files in a worker's tree and name none.
export const workerNameFromTarget = (target: string): string | null =>
    /^worker:\/\/([^/~\s][^/\s]*)$/u.exec(target)?.[1] ?? null;

const byCreated = (a: WorkerRow, b: WorkerRow): number =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id - b.id;

// Lifecycle glyphs for workers other than the bound one arrive with
// plurnk-service#653; until then no glyph is inferred from row coordinates.
export const renderWorkerTopology = (workers: readonly WorkerRow[], bound: string | null): string => {
    if (workers.length === 0) return "  (no workers)\n";
    const byId = new Map(workers.map((worker) => [worker.id, worker]));
    const parentOf = (worker: WorkerRow): number | null =>
        worker.parentWorkerId !== undefined && worker.parentWorkerId !== null && byId.has(worker.parentWorkerId) ? worker.parentWorkerId : null;
    const children = new Map<number | null, WorkerRow[]>();
    for (const worker of workers) {
        const parent = parentOf(worker);
        const siblings = children.get(parent) ?? [];
        siblings.push(worker);
        children.set(parent, siblings);
    }
    for (const siblings of children.values()) siblings.sort(byCreated);
    const rootOf = (worker: WorkerRow): WorkerRow => {
        let current = worker;
        for (let parent = parentOf(current); parent !== null; parent = parentOf(current)) current = byId.get(parent)!;
        return current;
    };
    const boundRow = workers.find((worker) => worker.name === bound);
    const boundRootId = boundRow === undefined ? null : rootOf(boundRow).id;
    const roots = (children.get(null) ?? []).toSorted((a, b) =>
        a.id === boundRootId ? -1 : b.id === boundRootId ? 1 : byCreated(a, b));
    const rows: Array<{ tree: string; worker: WorkerRow }> = [];
    const walk = (worker: WorkerRow, prefix: string, connector: string): void => {
        rows.push({ tree: `${prefix}${connector}${worker.name === bound ? "●" : "○"} ${worker.name}`, worker });
        const kids = children.get(worker.id) ?? [];
        const childPrefix = connector === "" ? "" : `${prefix}${connector.startsWith("└") ? "   " : "│  "}`;
        kids.forEach((kid, index) => walk(kid, childPrefix, index === kids.length - 1 ? "└─ " : "├─ "));
    };
    for (const root of roots) walk(root, "", "");
    const width = Math.max(...rows.map(({ tree }) => tree.length));
    return `${rows.map(({ tree, worker }) =>
        `  ${tree.padEnd(width)}  ${(worker.origin ?? "?").padEnd(7)}  ${worker.created_at}${worker.name === bound ? "  ← bound" : ""}`,
    ).join("\n")}\n`;
};
