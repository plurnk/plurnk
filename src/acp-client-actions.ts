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

export interface PlurnkFamilyListQuery extends Record<string, unknown> {
    readonly query?: string;
    readonly state?: "active" | "dormant" | "disabled" | "unavailable" | "authorization-required";
    readonly origin?: "host" | "service" | "workspace" | "session";
    readonly offset?: number;
    readonly limit?: number;
}

export interface PlurnkFamilyListResult extends Record<string, unknown> {
    readonly definitions?: ReadonlyArray<Record<string, unknown>>;
    readonly offset?: number;
    readonly total?: number;
    readonly nextOffset?: number;
}

export interface PlurnkFamilyDiscoverResult extends Record<string, unknown> {
    readonly candidates?: ReadonlyArray<Record<string, unknown>>;
    readonly total?: number;
    readonly nextCursor?: string;
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
    readonly "service.config.list": PlurnkActionEntry<Record<string, unknown>, Record<string, unknown>>;
    readonly "service.config.set": PlurnkActionEntry<
        { readonly key: string; readonly value: string },
        Record<string, unknown>
    >;
    readonly "service.config.unset": PlurnkActionEntry<{ readonly key: string }, Record<string, unknown>>;
    readonly "workspace.config.list": PlurnkActionEntry<Record<string, unknown>, Record<string, unknown>>;
    readonly "workspace.config.set": PlurnkActionEntry<
        { readonly key: string; readonly value: string },
        Record<string, unknown>
    >;
    readonly "workspace.config.unset": PlurnkActionEntry<{ readonly key: string }, Record<string, unknown>>;
    readonly "workspace.list": PlurnkActionEntry<
        { readonly archived?: boolean; readonly includeArchived?: boolean },
        { readonly workspaces: ReadonlyArray<Record<string, unknown>> } & Record<string, unknown>
    >;
    readonly "workspace.create": PlurnkActionEntry<
        {
            readonly name?: string;
            readonly projectRoot?: string | null;
            readonly config?: Readonly<Record<string, string>>;
            readonly client?: string;
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
    readonly "workspace.skills.list": PlurnkActionEntry<PlurnkFamilyListQuery, PlurnkFamilyListResult>;
    readonly "workspace.skills.discover": PlurnkActionEntry<
        { readonly source?: string; readonly query?: string; readonly cursor?: string; readonly limit?: number } & Record<string, unknown>,
        PlurnkFamilyDiscoverResult
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
    readonly "workspace.personas.list": PlurnkActionEntry<PlurnkFamilyListQuery, PlurnkFamilyListResult>;
    readonly "workspace.personas.discover": PlurnkActionEntry<
        { readonly query?: string; readonly source?: string; readonly cursor?: string; readonly limit?: number } & Record<string, unknown>,
        PlurnkFamilyDiscoverResult
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
    readonly "workspace.members.list": PlurnkActionEntry<PlurnkFamilyListQuery, PlurnkFamilyListResult>;
    readonly "workspace.members.discover": PlurnkActionEntry<
        { readonly query?: string; readonly cursor?: string; readonly limit?: number } & Record<string, unknown>,
        PlurnkFamilyDiscoverResult
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
    readonly "workspace.env.list": PlurnkActionEntry<PlurnkFamilyListQuery, PlurnkFamilyListResult>;
    readonly "workspace.env.discover": PlurnkActionEntry<
        { readonly query?: string; readonly source?: string; readonly cursor?: string; readonly limit?: number } & Record<string, unknown>,
        PlurnkFamilyDiscoverResult
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
    readonly "session.env.list": PlurnkActionEntry<PlurnkFamilyListQuery, PlurnkFamilyListResult>;
    readonly "session.env.discover": PlurnkActionEntry<
        { readonly query?: string; readonly source?: string; readonly cursor?: string; readonly limit?: number } & Record<string, unknown>,
        PlurnkFamilyDiscoverResult
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
    readonly "workspace.mcp.list": PlurnkActionEntry<PlurnkFamilyListQuery, PlurnkFamilyListResult>;
    readonly "workspace.mcp.discover": PlurnkActionEntry<
        { readonly query?: string; readonly cursor?: string; readonly limit?: number } & Record<string, unknown>,
        PlurnkFamilyDiscoverResult
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
    readonly "workspace.schedule.list": PlurnkActionEntry<PlurnkFamilyListQuery, PlurnkFamilyListResult>;
    readonly "workspace.schedule.discover": PlurnkActionEntry<
        { readonly rule?: string; readonly cursor?: string; readonly limit?: number } & Record<string, unknown>,
        PlurnkFamilyDiscoverResult
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
    readonly "service.skills.list": PlurnkActionEntry<PlurnkFamilyListQuery, PlurnkFamilyListResult>;
    readonly "service.skills.discover": PlurnkActionEntry<
        { readonly source: string; readonly query?: string; readonly cursor?: string; readonly limit?: number } & Record<string, unknown>,
        PlurnkFamilyDiscoverResult
    >;
    readonly "service.skills.add": PlurnkActionEntry<Record<string, unknown>, Record<string, unknown>>;
    readonly "service.skills.replace": PlurnkActionEntry<Record<string, unknown>, Record<string, unknown>>;
    readonly "service.skills.enable": PlurnkActionEntry<{ readonly alias: string } & Record<string, unknown>, Record<string, unknown>>;
    readonly "service.skills.disable": PlurnkActionEntry<{ readonly alias: string } & Record<string, unknown>, Record<string, unknown>>;
    readonly "service.skills.remove": PlurnkActionEntry<{ readonly alias: string } & Record<string, unknown>, Record<string, unknown>>;
    readonly "service.personas.list": PlurnkActionEntry<PlurnkFamilyListQuery, PlurnkFamilyListResult>;
    readonly "service.personas.discover": PlurnkActionEntry<
        { readonly query?: string; readonly source?: string; readonly cursor?: string; readonly limit?: number } & Record<string, unknown>,
        PlurnkFamilyDiscoverResult
    >;
    readonly "service.personas.add": PlurnkActionEntry<Record<string, unknown>, Record<string, unknown>>;
    readonly "service.personas.replace": PlurnkActionEntry<Record<string, unknown>, Record<string, unknown>>;
    readonly "service.personas.enable": PlurnkActionEntry<{ readonly alias: string } & Record<string, unknown>, Record<string, unknown>>;
    readonly "service.personas.disable": PlurnkActionEntry<{ readonly alias: string } & Record<string, unknown>, Record<string, unknown>>;
    readonly "service.personas.remove": PlurnkActionEntry<{ readonly alias: string } & Record<string, unknown>, Record<string, unknown>>;
    readonly "service.members.list": PlurnkActionEntry<PlurnkFamilyListQuery, PlurnkFamilyListResult>;
    readonly "service.members.discover": PlurnkActionEntry<
        { readonly query: string; readonly cursor?: string; readonly limit?: number } & Record<string, unknown>,
        PlurnkFamilyDiscoverResult
    >;
    readonly "service.members.add": PlurnkActionEntry<{ readonly files: readonly string[] } & Record<string, unknown>, Record<string, unknown>>;
    readonly "service.members.enable": PlurnkActionEntry<{ readonly file: string } & Record<string, unknown>, Record<string, unknown>>;
    readonly "service.members.disable": PlurnkActionEntry<{ readonly file: string } & Record<string, unknown>, Record<string, unknown>>;
    readonly "service.members.remove": PlurnkActionEntry<{ readonly file: string } & Record<string, unknown>, Record<string, unknown>>;
    readonly "service.env.list": PlurnkActionEntry<PlurnkFamilyListQuery, PlurnkFamilyListResult>;
    readonly "service.env.discover": PlurnkActionEntry<
        { readonly query?: string; readonly source?: string; readonly cursor?: string; readonly limit?: number } & Record<string, unknown>,
        PlurnkFamilyDiscoverResult
    >;
    readonly "service.env.add": PlurnkActionEntry<{ readonly alias: string; readonly value: string } & Record<string, unknown>, Record<string, unknown>>;
    readonly "service.env.replace": PlurnkActionEntry<{ readonly alias: string; readonly value: string } & Record<string, unknown>, Record<string, unknown>>;
    readonly "service.env.enable": PlurnkActionEntry<{ readonly alias: string } & Record<string, unknown>, Record<string, unknown>>;
    readonly "service.env.disable": PlurnkActionEntry<{ readonly alias: string } & Record<string, unknown>, Record<string, unknown>>;
    readonly "service.env.remove": PlurnkActionEntry<{ readonly alias: string } & Record<string, unknown>, Record<string, unknown>>;
    readonly "service.mcp.list": PlurnkActionEntry<PlurnkFamilyListQuery, PlurnkFamilyListResult>;
    readonly "service.mcp.discover": PlurnkActionEntry<
        { readonly query?: string; readonly cursor?: string; readonly limit?: number } & Record<string, unknown>,
        PlurnkFamilyDiscoverResult
    >;
    readonly "service.mcp.add": PlurnkActionEntry<Record<string, unknown>, Record<string, unknown>>;
    readonly "service.mcp.replace": PlurnkActionEntry<Record<string, unknown>, Record<string, unknown>>;
    readonly "service.mcp.enable": PlurnkActionEntry<{ readonly alias: string } & Record<string, unknown>, Record<string, unknown>>;
    readonly "service.mcp.disable": PlurnkActionEntry<{ readonly alias: string } & Record<string, unknown>, Record<string, unknown>>;
    readonly "service.mcp.remove": PlurnkActionEntry<{ readonly alias: string } & Record<string, unknown>, Record<string, unknown>>;
    readonly "service.mcp.oauth.begin": PlurnkActionEntry<
        { readonly alias: string; readonly redirectUrl?: string } & Record<string, unknown>,
        { readonly authorizationUrl?: string } & Record<string, unknown>
    >;
    readonly "service.mcp.oauth.complete": PlurnkActionEntry<
        { readonly alias: string; readonly code?: string; readonly callbackUrl?: string } & Record<string, unknown>,
        Record<string, unknown>
    >;
    readonly "service.schedule.list": PlurnkActionEntry<PlurnkFamilyListQuery, PlurnkFamilyListResult>;
    readonly "service.schedule.discover": PlurnkActionEntry<
        { readonly rule?: string; readonly cursor?: string; readonly limit?: number } & Record<string, unknown>,
        PlurnkFamilyDiscoverResult
    >;
    readonly "service.schedule.add": PlurnkActionEntry<ScheduleActionInput & Record<string, unknown>, Record<string, unknown>>;
    readonly "service.schedule.replace": PlurnkActionEntry<ScheduleActionInput & Record<string, unknown>, Record<string, unknown>>;
    readonly "service.schedule.enable": PlurnkActionEntry<{ readonly alias: string } & Record<string, unknown>, Record<string, unknown>>;
    readonly "service.schedule.disable": PlurnkActionEntry<{ readonly alias: string } & Record<string, unknown>, Record<string, unknown>>;
    readonly "service.schedule.remove": PlurnkActionEntry<{ readonly alias: string } & Record<string, unknown>, Record<string, unknown>>;
}

export type PlurnkActionKind = keyof PlurnkActionMap;

export const ACP_ACTION_KINDS = [
    "ping",
    "discover",
    "models.list",
    "service.update",
    "service.config.list",
    "service.config.set",
    "service.config.unset",
    "workspace.config.list",
    "workspace.config.set",
    "workspace.config.unset",
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
    "service.skills.list",
    "service.skills.discover",
    "service.skills.add",
    "service.skills.replace",
    "service.skills.enable",
    "service.skills.disable",
    "service.skills.remove",
    "service.personas.list",
    "service.personas.discover",
    "service.personas.add",
    "service.personas.replace",
    "service.personas.enable",
    "service.personas.disable",
    "service.personas.remove",
    "service.members.list",
    "service.members.discover",
    "service.members.add",
    "service.members.enable",
    "service.members.disable",
    "service.members.remove",
    "service.env.list",
    "service.env.discover",
    "service.env.add",
    "service.env.replace",
    "service.env.enable",
    "service.env.disable",
    "service.env.remove",
    "service.mcp.list",
    "service.mcp.discover",
    "service.mcp.add",
    "service.mcp.replace",
    "service.mcp.enable",
    "service.mcp.disable",
    "service.mcp.remove",
    "service.mcp.oauth.begin",
    "service.mcp.oauth.complete",
    "service.schedule.list",
    "service.schedule.discover",
    "service.schedule.add",
    "service.schedule.replace",
    "service.schedule.enable",
    "service.schedule.disable",
    "service.schedule.remove",
] as const satisfies readonly PlurnkActionKind[];

type _AssertExhaustivePlurnkActionKinds = Exclude<
    PlurnkActionKind,
    (typeof ACP_ACTION_KINDS)[number]
> extends never
    ? true
    : never;
const _exhaustivePlurnkActionKinds: _AssertExhaustivePlurnkActionKinds = true;
void _exhaustivePlurnkActionKinds;
