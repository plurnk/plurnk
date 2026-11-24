// Typed `_plurnk/action` residual-bridge catalog, handler signatures, and conformance
// exhaustiveness map ({§cli-conformance}, {§cli-configuration-source}).

import type {
    AuthStatusUpdateNotification,
    CreateElicitationRequest,
    CreateElicitationResponse,
    RequestPermissionRequest,
    RequestPermissionResponse,
    SessionUpdate,
    UpdateSessionNotification,
} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type Credential from "./credential.ts";

export type SessionUpdateHandler = (notification: UpdateSessionNotification) => void | Promise<void>;

export type AuthStatusUpdateHandler = (notification: AuthStatusUpdateNotification) => void | Promise<void>;

export type PermissionRequestHandler = (
    request: RequestPermissionRequest,
    signal: AbortSignal,
) => Promise<RequestPermissionResponse>;

export type ElicitationRequestHandler = (
    request: CreateElicitationRequest,
    signal: AbortSignal,
) => Promise<CreateElicitationResponse>;

export interface AcpClientOptions {
    readonly url: string;
    readonly token?: string;
    readonly credential?: Credential;
    readonly env?: Record<string, string | undefined>;
    readonly headers?: Readonly<Record<string, string>>;
    readonly clientName?: string;
    readonly clientVersion?: string;
    readonly debugNoMeta?: boolean;
    readonly onSessionUpdate?: SessionUpdateHandler;
    readonly onAuthStatusUpdate?: AuthStatusUpdateHandler;
    readonly onPermissionRequest?: PermissionRequestHandler;
    readonly onElicitationRequest?: ElicitationRequestHandler;
    readonly onDisconnect?: () => void | Promise<void>;
}

export interface PlurnkActionContext {
    readonly workspace?: string;
    readonly workspaceId?: number;
    readonly session?: string;
    readonly sessionId?: string;
    readonly cwd?: string;
}

export interface PlurnkActionEntry<
    P extends Record<string, unknown> = Record<string, unknown>,
    R = Record<string, unknown>,
> {
    readonly params: P;
    readonly result: R;
}

export interface PlurnkFamilyListResult extends Record<string, unknown> {
    readonly definitions?: ReadonlyArray<Record<string, unknown>>;
}

export interface ScheduledToolCall {
    readonly server: string;
    readonly tool: string;
    readonly arguments?: Readonly<Record<string, unknown>>;
    readonly aside?: string;
}

export type ScheduleActionInput =
    | {
          readonly alias: string;
          readonly rule?: string;
          readonly target: string;
          readonly prompt: string;
          readonly persona?: string;
          readonly catchup?: boolean;
      }
    | {
          readonly alias: string;
          readonly rule?: string;
          readonly run: readonly ScheduledToolCall[];
          readonly target?: string;
          readonly catchup?: boolean;
      };

export interface ScheduledStepReceipt {
    readonly index: number;
    readonly server: string;
    readonly tool: string;
    readonly status: number;
    readonly uri?: string;
    readonly preview?: string;
    readonly problem?: Readonly<Record<string, unknown>>;
}

export interface ScheduleRunResult {
    readonly alias: string;
    readonly status: "open" | "done" | "fail";
    readonly loopId?: number | null;
    readonly lastFiredAt?: string | null;
    readonly doneAt?: string | null;
    readonly results?: readonly ScheduledStepReceipt[];
}

export interface PlurnkActionMap {
    readonly ping: PlurnkActionEntry<Record<string, unknown>, { readonly ok?: boolean } & Record<string, unknown>>;
    readonly discover: PlurnkActionEntry<Record<string, unknown>, Record<string, unknown>>;
    readonly "models.list": PlurnkActionEntry<
        {
            readonly search?: string;
            readonly provider?: string;
            readonly availability?: "configured" | "all";
            readonly all?: boolean;
            readonly offset?: number;
            readonly limit?: number;
        },
        {
            readonly total: number;
            readonly offset: number;
            readonly nextOffset?: number;
            readonly items: ReadonlyArray<Record<string, unknown>>;
        } & Record<string, unknown>
    >;
    readonly "service.update": PlurnkActionEntry<
        Record<string, never>,
        { readonly catalog: Record<string, unknown>; readonly service: Record<string, unknown> } & Record<string, unknown>
    >;
    readonly "workspace.list": PlurnkActionEntry<
        { readonly archived?: boolean; readonly includeArchived?: boolean },
        { readonly workspaces: ReadonlyArray<Record<string, unknown>> } & Record<string, unknown>
    >;
    readonly "workspace.create": PlurnkActionEntry<
        {
            readonly name?: string;
            readonly projectRoot?: string | null;
            readonly settings?: string | Record<string, unknown>;
        },
        Record<string, unknown>
    >;
    readonly "workspace.attach": PlurnkActionEntry<
        {
            readonly id?: number;
            readonly workspaceId?: number;
            readonly name?: string;
            readonly projectRoot?: string;
        },
        Record<string, unknown>
    >;
    readonly "workspace.sessions": PlurnkActionEntry<
        { readonly archived?: boolean; readonly includeArchived?: boolean } & Record<string, unknown>,
        { readonly sessions: ReadonlyArray<Record<string, unknown>> } & Record<string, unknown>
    >;
    readonly "log.read": PlurnkActionEntry<
        {
            readonly loopId?: number;
            readonly turnId?: number;
            readonly sinceId?: number;
            readonly beforeId?: number;
            readonly limit?: number;
            readonly loopSeq?: number;
            readonly turnSeq?: number;
            readonly sequence?: number;
        } & Record<string, unknown>,
        { readonly entries: ReadonlyArray<Record<string, unknown>> } & Record<string, unknown>
    >;
    readonly "workspace.prompts": PlurnkActionEntry<
        { readonly limit?: number } & Record<string, unknown>,
        { readonly prompts: readonly string[] } & Record<string, unknown>
    >;
    readonly "session.loops": PlurnkActionEntry<
        { readonly loopSeq?: number } & Record<string, unknown>,
        {
            readonly items: ReadonlyArray<Record<string, unknown>>;
            readonly updates?: ReadonlyArray<SessionUpdate>;
        } & Record<string, unknown>
    >;
    readonly "workspace.share": PlurnkActionEntry<
        { readonly folder: string } & Record<string, unknown>,
        { readonly folder: string } & Record<string, unknown>
    >;
    readonly "workspace.rename": PlurnkActionEntry<
        { readonly from?: string; readonly name?: string; readonly to?: string } & Record<string, unknown>,
        { readonly id: number; readonly name: string } & Record<string, unknown>
    >;
    readonly "workspace.archive": PlurnkActionEntry<
        { readonly archived?: boolean } & Record<string, unknown>,
        { readonly id: number; readonly archivedAt: string | null } & Record<string, unknown>
    >;
    readonly "session.rollback": PlurnkActionEntry<
        { readonly to: string } & Record<string, unknown>,
        {
            readonly to: string;
            readonly restored: ReadonlyArray<unknown>;
            readonly skipped: ReadonlyArray<unknown>;
            readonly stopped: Record<string, unknown> | null;
        } & Record<string, unknown>
    >;
    readonly "entry.read": PlurnkActionEntry<
        {
            readonly target: string;
            readonly channel?: string;
            readonly offset?: number;
        } & Record<string, unknown>,
        {
            readonly status: number;
            readonly entry?: Record<string, unknown> | null;
            readonly problem?: Record<string, unknown>;
        } & Record<string, unknown>
    >;
    readonly "op.exec": PlurnkActionEntry<
        { readonly text: string } & Record<string, unknown>,
        {
            readonly results: ReadonlyArray<{
                readonly status?: number;
                readonly content?: string;
                readonly message?: string;
                readonly problem?: { readonly detail?: string } & Record<string, unknown>;
            } & Record<string, unknown>>;
        } & Record<string, unknown>
    >;
    readonly "workspace.skills.list": PlurnkActionEntry<Record<string, unknown>, PlurnkFamilyListResult>;
    readonly "workspace.skills.discover": PlurnkActionEntry<
        { readonly source?: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.skills.add": PlurnkActionEntry<
        { readonly alias: string; readonly source?: string; readonly ref?: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.skills.replace": PlurnkActionEntry<
        { readonly alias: string; readonly source?: string; readonly ref?: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.skills.enable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.skills.disable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.skills.remove": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.personas.list": PlurnkActionEntry<Record<string, unknown>, PlurnkFamilyListResult>;
    readonly "workspace.personas.discover": PlurnkActionEntry<
        { readonly query?: string; readonly source?: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.personas.add": PlurnkActionEntry<
        {
            readonly alias: string;
            readonly source?: string;
            readonly description?: string;
            readonly body?: string;
            readonly model?: string;
            readonly effort?: string;
        } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.personas.replace": PlurnkActionEntry<
        {
            readonly alias: string;
            readonly source?: string;
            readonly description?: string;
            readonly body?: string;
            readonly model?: string;
            readonly effort?: string;
        } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.personas.enable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.personas.disable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.personas.remove": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.members.list": PlurnkActionEntry<Record<string, unknown>, PlurnkFamilyListResult>;
    readonly "workspace.members.discover": PlurnkActionEntry<
        { readonly query?: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.members.add": PlurnkActionEntry<
        { readonly files: readonly string[] } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.members.enable": PlurnkActionEntry<
        { readonly file: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.members.disable": PlurnkActionEntry<
        { readonly file: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.members.remove": PlurnkActionEntry<
        { readonly file: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.env.list": PlurnkActionEntry<Record<string, unknown>, PlurnkFamilyListResult>;
    readonly "workspace.env.discover": PlurnkActionEntry<
        { readonly query?: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.env.add": PlurnkActionEntry<
        { readonly alias: string; readonly value: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.env.replace": PlurnkActionEntry<
        { readonly alias: string; readonly value: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.env.enable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.env.disable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.env.remove": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "session.env.list": PlurnkActionEntry<Record<string, unknown>, PlurnkFamilyListResult>;
    readonly "session.env.discover": PlurnkActionEntry<
        { readonly query?: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "session.env.add": PlurnkActionEntry<
        { readonly alias: string; readonly value: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "session.env.replace": PlurnkActionEntry<
        { readonly alias: string; readonly value: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "session.env.enable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "session.env.disable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "session.env.remove": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.mcp.list": PlurnkActionEntry<Record<string, unknown>, PlurnkFamilyListResult>;
    readonly "workspace.mcp.discover": PlurnkActionEntry<
        { readonly query?: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.mcp.add": PlurnkActionEntry<
        (
            | { readonly alias: string; readonly type: "streamable-http"; readonly url: string }
            | {
                  readonly alias: string;
                  readonly type: "stdio";
                  readonly command: string;
                  readonly args?: readonly string[];
              }
        ) &
            Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.mcp.replace": PlurnkActionEntry<
        (
            | { readonly alias: string; readonly type: "streamable-http"; readonly url: string }
            | {
                  readonly alias: string;
                  readonly type: "stdio";
                  readonly command: string;
                  readonly args?: readonly string[];
              }
        ) &
            Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.mcp.enable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.mcp.disable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.mcp.remove": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.schedule.list": PlurnkActionEntry<Record<string, unknown>, PlurnkFamilyListResult>;
    readonly "workspace.schedule.discover": PlurnkActionEntry<
        { readonly rule?: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.schedule.add": PlurnkActionEntry<
        ScheduleActionInput & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.schedule.replace": PlurnkActionEntry<
        ScheduleActionInput & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.schedule.enable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.schedule.disable": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.schedule.remove": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.schedule.run": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        ScheduleRunResult & Record<string, unknown>
    >;
    readonly "workspace.schedule.status": PlurnkActionEntry<
        { readonly alias: string; readonly status: "open" | "done" | "fail" } & Record<string, unknown>,
        ScheduleRunResult & Record<string, unknown>
    >;
    readonly "workspace.mcp.oauth.begin": PlurnkActionEntry<
        { readonly alias: string } & Record<string, unknown>,
        { readonly authorizationUrl?: string } & Record<string, unknown>
    >;
    readonly "workspace.mcp.oauth.complete": PlurnkActionEntry<
        { readonly alias: string; readonly code?: string; readonly callbackUrl?: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "workspace.mcp.complete": PlurnkActionEntry<Record<string, unknown>, Record<string, unknown>>;
    readonly "workspace.mcp.skills": PlurnkActionEntry<Record<string, unknown>, Record<string, unknown>>;
}

export type PlurnkActionKind = keyof PlurnkActionMap;

export const ACP_ACTION_KINDS = [
    "ping",
    "discover",
    "models.list",
    "service.update",
    "workspace.list",
    "workspace.create",
    "workspace.attach",
    "workspace.sessions",
    "log.read",
    "workspace.prompts",
    "session.loops",
    "workspace.share",
    "workspace.rename",
    "workspace.archive",
    "session.rollback",
    "entry.read",
    "op.exec",
    "workspace.skills.list",
    "workspace.skills.discover",
    "workspace.skills.add",
    "workspace.skills.replace",
    "workspace.skills.enable",
    "workspace.skills.disable",
    "workspace.skills.remove",
    "workspace.personas.list",
    "workspace.personas.discover",
    "workspace.personas.add",
    "workspace.personas.replace",
    "workspace.personas.enable",
    "workspace.personas.disable",
    "workspace.personas.remove",
    "workspace.members.list",
    "workspace.members.discover",
    "workspace.members.add",
    "workspace.members.enable",
    "workspace.members.disable",
    "workspace.members.remove",
    "workspace.env.list",
    "workspace.env.discover",
    "workspace.env.add",
    "workspace.env.replace",
    "workspace.env.enable",
    "workspace.env.disable",
    "workspace.env.remove",
    "session.env.list",
    "session.env.discover",
    "session.env.add",
    "session.env.replace",
    "session.env.enable",
    "session.env.disable",
    "session.env.remove",
    "workspace.mcp.list",
    "workspace.mcp.discover",
    "workspace.mcp.add",
    "workspace.mcp.replace",
    "workspace.mcp.enable",
    "workspace.mcp.disable",
    "workspace.mcp.remove",
    "workspace.schedule.list",
    "workspace.schedule.discover",
    "workspace.schedule.add",
    "workspace.schedule.replace",
    "workspace.schedule.enable",
    "workspace.schedule.disable",
    "workspace.schedule.remove",
    "workspace.schedule.run",
    "workspace.schedule.status",
    "workspace.mcp.oauth.begin",
    "workspace.mcp.oauth.complete",
    "workspace.mcp.complete",
    "workspace.mcp.skills",
] as const satisfies readonly PlurnkActionKind[];

type _AssertExhaustivePlurnkActionKinds = Exclude<
    PlurnkActionKind,
    (typeof ACP_ACTION_KINDS)[number]
> extends never
    ? true
    : never;
const _exhaustivePlurnkActionKinds: _AssertExhaustivePlurnkActionKinds = true;
void _exhaustivePlurnkActionKinds;
