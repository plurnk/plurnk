import { actionViaAgui, type AguiTarget, type WorkspaceHandle } from "../src/agui.ts";
import { AguiTransport, type AguiTransportOpts } from "../src/transport.ts";

// {§cli-workspaces-and-workers}: fixtures acquire through the same public action as the terminal.
export const openTransport = async (target: AguiTarget, worker: string,
    { workspace: name, projectRoot, ...options }: AguiTransportOpts & { workspace: string; projectRoot?: string | null }): Promise<AguiTransport> => {
    const workspace = await actionViaAgui<WorkspaceHandle>(target, { threadId: "bootstrap", kind: "workspace.create",
        params: { name, ...(projectRoot === undefined ? {} : { projectRoot }), ...(options.settings === undefined ? {} : { settings: options.settings }) } });
    return new AguiTransport(target, { workspaceId: workspace.id, worker }, options);
};
