// The workspace directory as a topology ({§cli-workers-topology}): a forest of
// parent/child trees from `workspace.workers`, the bound worker's tree first.
export interface WorkerRow {
    id: number;
    name: string;
    created_at: string;
    origin?: "model" | "client" | "_plurnk";
    parentWorkerId?: number | null;
}

// Only a pathless `worker://<name>` references an actor; scratch paths do not.
export const workerNameFromTarget = (target: string): string | null =>
    /^worker:\/\/([^/~\s][^/\s]*)$/u.exec(target)?.[1] ?? null;

// Newest first ({§cli-workers-topology}): the child you just spawned is the one you reach first.
const byRecency = (a: WorkerRow, b: WorkerRow): number =>
    a.created_at > b.created_at ? -1 : a.created_at < b.created_at ? 1 : b.id - a.id;

// The places a session can be: conversations and their descendants. The daemon's own
// maintenance worker and a connection's scratch worker are not places.
const isPlace = (worker: WorkerRow): boolean => worker.origin === "model";

const parentIn = (byId: ReadonlyMap<number, WorkerRow>) => (worker: WorkerRow): WorkerRow | null =>
    worker.parentWorkerId !== undefined && worker.parentWorkerId !== null ? byId.get(worker.parentWorkerId) ?? null : null;

// The lineage from the tree root to the bound worker. `~` is a display cursor,
// not a resource alias: `/~main`, `/main/fork-1/~recheck`, or `/~` before binding.
export const workerPath = (workers: readonly WorkerRow[], bound: string | null): string => {
    const byId = new Map(workers.map((worker) => [worker.id, worker]));
    const parentOf = parentIn(byId);
    let current = workers.find((worker) => worker.name === bound) ?? null;
    if (current === null) return bound === null ? "/~" : `/~${bound}`;
    const segments: string[] = [`~${current.name}`];
    for (let parent = parentOf(current); parent !== null; parent = parentOf(current)) {
        current = parent;
        segments.unshift(current.name);
    }
    return `/${segments.join("/")}`;
};

export type Hop = "parent" | "enter" | "older" | "newer";

// One traversal step over the workspace tree ({§cli-workers-topology}): `parent` climbs, `enter`
// descends to the newest child, `older`/`newer` walk siblings and wrap. A step with
// nowhere to go names why. Position is the bound worker's place among its siblings, newest first.
export const traverse = (
    workers: readonly WorkerRow[],
    bound: string | null,
    hop: Hop,
): { target: WorkerRow | null; notice: string | null } => {
    const byId = new Map(workers.map((worker) => [worker.id, worker]));
    const parentOf = parentIn(byId);
    const current = workers.find((worker) => worker.name === bound) ?? null;
    if (current === null) return { target: null, notice: "no bound worker yet: run a prompt or /attach <name> first" };
    if (hop === "parent") {
        const parent = parentOf(current);
        return parent === null ? { target: null, notice: "at the root: no parent" } : { target: parent, notice: null };
    }
    if (hop === "enter") {
        const child = workers.filter((worker) => isPlace(worker) && parentOf(worker)?.id === current.id).toSorted(byRecency)[0] ?? null;
        return child === null ? { target: null, notice: "no children" } : { target: child, notice: null };
    }
    const siblings = siblingsOf(workers, current);
    const index = siblings.findIndex((worker) => worker.id === current.id);
    if (siblings.length < 2) return { target: null, notice: "no siblings" };
    const step = hop === "older" ? 1 : -1;
    return { target: siblings[(index + step + siblings.length) % siblings.length]!, notice: null };
};

export const siblingPosition = (workers: readonly WorkerRow[], bound: string | null): { index: number; count: number } | null => {
    const current = workers.find((worker) => worker.name === bound) ?? null;
    if (current === null) return null;
    const siblings = siblingsOf(workers, current);
    return siblings.length < 2 ? null : { index: siblings.findIndex((worker) => worker.id === current.id) + 1, count: siblings.length };
};

const siblingsOf = (workers: readonly WorkerRow[], current: WorkerRow): WorkerRow[] => {
    const byId = new Map(workers.map((worker) => [worker.id, worker]));
    const parentOf = parentIn(byId);
    const parent = parentOf(current);
    return workers
        .filter((worker) => (isPlace(worker) || worker.id === current.id) && (parentOf(worker)?.id ?? null) === (parent?.id ?? null))
        .toSorted(byRecency);
};

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
    for (const siblings of children.values()) siblings.sort(byRecency);
    const rootOf = (worker: WorkerRow): WorkerRow => {
        let current = worker;
        for (let parent = parentOf(current); parent !== null; parent = parentOf(current)) current = byId.get(parent)!;
        return current;
    };
    const boundRow = workers.find((worker) => worker.name === bound);
    const boundRootId = boundRow === undefined ? null : rootOf(boundRow).id;
    const roots = (children.get(null) ?? []).toSorted((a, b) =>
        a.id === boundRootId ? -1 : b.id === boundRootId ? 1 : byRecency(a, b));
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
