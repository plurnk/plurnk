import { actionViaAcp, type AcpTarget, type WorkspaceHandle } from "../src/acp.ts";
import { AcpTransport, type AcpTransportOpts } from "../src/transport.ts";

// {§cli-workspaces-and-workers}: fixtures acquire through the same public action as the terminal.
export const openTransport = async (target: AcpTarget, worker: string,
    { workspace: name, projectRoot, ...options }: AcpTransportOpts & { workspace: string; projectRoot?: string | null }): Promise<AcpTransport> => {
    const workspace = await actionViaAcp<WorkspaceHandle>(target, { threadId: "bootstrap", kind: "workspace.create",
        params: { name, ...(projectRoot === undefined ? {} : { projectRoot }), ...(options.settings === undefined ? {} : { settings: options.settings }) } });
    return new AcpTransport(target, { workspaceId: workspace.id, worker }, options);
};
