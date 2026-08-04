import { Option, Schema } from "effect";
import {
  PI_CONSOLE_MAX_COMMAND_BYTES,
  PI_CONSOLE_MAX_STRING_BYTES,
  PiConsoleImagesSchema,
} from "../../protocol/pi-console.ts";
import { redactRemoteString, truncateRemoteString } from "./redaction.ts";
import { SessionIdSchema, type FleetSession } from "./schemas.ts";
import { projectDesktopTranscript } from "./desktop-transcript.ts";
import type { FleetConsoleState, LiveProjection, SessionViewCache } from "./state.ts";

export const DESKTOP_PROTOCOL_VERSION = 2 as const;
export const DESKTOP_MAX_COMMAND_BYTES = PI_CONSOLE_MAX_COMMAND_BYTES;
export const DESKTOP_MAX_FRAME_BYTES = 8 * 1024 * 1024;

const encoder = new TextEncoder();
const boundedString = (maxBytes: number) =>
  Schema.String.check(
    Schema.makeFilter((value) => encoder.encode(value).byteLength <= maxBytes, {
      expected: `a string of at most ${maxBytes} UTF-8 bytes`,
    }),
  );
const MessageSchema = boundedString(PI_CONSOLE_MAX_STRING_BYTES);
const InitialPromptSchema = boundedString(PI_CONSOLE_MAX_STRING_BYTES);
const ShortStringSchema = boundedString(4 * 1024);
const RequestIdSchema = boundedString(64).pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9._:-]+$/u)),
);
const SessionTitleSchema = boundedString(120).pipe(Schema.check(Schema.isNonEmpty()));
const RepositorySchema = boundedString(200).pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u)),
);
const HardCapSecondsSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(60),
  Schema.isLessThanOrEqualTo(24 * 60 * 60),
);
const SelectionFenceFields = {
  sessionId: SessionIdSchema,
  expectedEpoch: ShortStringSchema,
  expectedSessionRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
};

export const DesktopCommandSchema = Schema.Union([
  Schema.Struct({ version: Schema.Literal(2), type: Schema.Literal("refresh_fleet") }),
  Schema.Struct({
    version: Schema.Literal(2),
    type: Schema.Literal("select"),
    sessionId: SessionIdSchema,
  }),
  Schema.Struct({ version: Schema.Literal(2), type: Schema.Literal("close") }),
  Schema.Struct({
    version: Schema.Literal(2),
    type: Schema.Literal("set_draft"),
    sessionId: SessionIdSchema,
    text: MessageSchema,
  }),
  Schema.Struct({
    version: Schema.Literal(2),
    type: Schema.Literal("submit"),
    ...SelectionFenceFields,
    text: MessageSchema,
    images: Schema.optionalKey(PiConsoleImagesSchema),
    forceFollowUp: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    version: Schema.Literal(2),
    type: Schema.Literal("abort"),
    ...SelectionFenceFields,
  }),
  Schema.Struct({
    version: Schema.Literal(2),
    type: Schema.Literal("answer"),
    ...SelectionFenceFields,
    requestId: ShortStringSchema,
    answer: Schema.Union([
      Schema.Struct({ type: Schema.Literal("value"), value: MessageSchema }),
      Schema.Struct({ type: Schema.Literal("confirmed"), confirmed: Schema.Boolean }),
      Schema.Struct({ type: Schema.Literal("cancelled") }),
    ]),
  }),
  Schema.Struct({
    version: Schema.Literal(2),
    type: Schema.Literal("create_sandbox"),
    requestId: RequestIdSchema,
    title: SessionTitleSchema,
    prompt: InitialPromptSchema,
    repo: RepositorySchema,
    hardCapSeconds: HardCapSecondsSchema,
  }),
  Schema.Struct({
    version: Schema.Literal(2),
    type: Schema.Literal("rename_sandbox"),
    requestId: RequestIdSchema,
    sessionId: SessionIdSchema,
    title: SessionTitleSchema,
  }),
  Schema.Struct({
    version: Schema.Literal(2),
    type: Schema.Literals(["snapshot_sandbox", "resume_sandbox", "vaporize_sandbox"]),
    requestId: RequestIdSchema,
    sessionId: SessionIdSchema,
  }),
  Schema.Struct({ version: Schema.Literal(2), type: Schema.Literal("shutdown") }),
]);
export type DesktopCommand = typeof DesktopCommandSchema.Type;

const decodeDesktopCommandOption = Schema.decodeUnknownOption(
  Schema.fromJsonString(DesktopCommandSchema),
  { onExcessProperty: "error" },
);

export const decodeDesktopCommand = (line: string): DesktopCommand | undefined =>
  encoder.encode(line).byteLength > DESKTOP_MAX_COMMAND_BYTES
    ? undefined
    : Option.getOrUndefined(decodeDesktopCommandOption(line));

const projectString = (value: string, maxLength: number): string =>
  truncateRemoteString(redactRemoteString(value), maxLength);

const projectFleetSession = (session: FleetSession) => ({
  id: session.id,
  title: projectString(session.title, 120),
  status: session.status,
  provider: session.provider,
  repo: projectString(session.repo, 200),
  defaultBranch: projectString(session.defaultBranch, 1024),
  branch: projectString(session.branch, 1024),
  backupId: session.backupId === undefined ? undefined : projectString(session.backupId, 1024),
  agentState: session.agentState,
  createdAt: projectString(session.createdAt, 1024),
  updatedAt: projectString(session.updatedAt, 1024),
  hardCapAt: projectString(session.hardCapAt, 1024),
  projectedAt: projectString(session.projectedAt, 1024),
  ageSeconds: session.ageSeconds,
  capRemainingSeconds: session.capRemainingSeconds,
  failure:
    session.failure === undefined
      ? undefined
      : {
          code: projectString(session.failure.code, 1024),
          message: projectString(session.failure.message, 1024),
          recoverable: session.failure.recoverable,
        },
});

const projectLive = (live: LiveProjection | undefined) => {
  if (live === undefined) return undefined;
  const transcript = projectDesktopTranscript(live.messages, [...live.activeTools.values()]);
  return {
    epoch: live.epoch,
    sequence: live.sequence,
    sessionRevision: live.sessionRevision,
    isStreaming: live.isStreaming,
    transcript: transcript.items,
    pendingUi: live.pendingUi,
    activity: live.activity,
    sidecarTruncated: transcript.truncated || live.truncated.messages || live.truncated.values,
  };
};

const projectSelected = (cache: SessionViewCache | undefined) =>
  cache === undefined
    ? undefined
    : {
        metadata: cache.metadata === undefined ? undefined : projectFleetSession(cache.metadata),
        draft: cache.draft,
        draftGeneration: cache.draftGeneration,
        live: projectLive(cache.live),
        unavailable: cache.unavailable,
        error: cache.error,
        commandStatus: cache.commandStatus,
      };

export const projectDesktopState = (state: FleetConsoleState) => {
  const selectedSessionId = state.selectedSessionId;
  return {
    version: DESKTOP_PROTOCOL_VERSION,
    fleet: state.fleet.map(projectFleetSession),
    fleetError: state.fleetError === undefined ? undefined : projectString(state.fleetError, 1024),
    selectedSessionId,
    loading: state.loading,
    selected:
      selectedSessionId === undefined ? undefined : projectSelected(state.cache(selectedSessionId)),
  } as const;
};

export type DesktopState = ReturnType<typeof projectDesktopState>;

export type DesktopManagementAction = "create" | "rename" | "snapshot" | "resume" | "vaporize";

export type DesktopFrame =
  | { readonly version: 2; readonly type: "ready" }
  | { readonly version: 2; readonly type: "state"; readonly state: DesktopState }
  | {
      readonly version: 2;
      readonly type: "operation";
      readonly requestId: string;
      readonly action: DesktopManagementAction;
      readonly sessionId?: string;
      readonly status: "started" | "succeeded" | "failed" | "unknown";
      readonly message: string;
    }
  | {
      readonly version: 2;
      readonly type: "error";
      readonly code: "invalid_command" | "command_failed" | "frame_too_large";
      readonly message: string;
    }
  | { readonly version: 2; readonly type: "stopped" };

export const encodeDesktopFrame = (frame: DesktopFrame): string | undefined => {
  let candidate = frame;
  while (true) {
    const encoded = `${JSON.stringify(candidate)}\n`;
    if (encoder.encode(encoded).byteLength <= DESKTOP_MAX_FRAME_BYTES) return encoded;
    if (candidate.type !== "state") return undefined;
    const selected = candidate.state.selected;
    if (selected === undefined) return undefined;
    const live = selected.live;
    if (live === undefined || live.transcript.length <= 1) return undefined;
    candidate = {
      ...candidate,
      state: {
        ...candidate.state,
        selected: {
          ...selected,
          live: {
            ...live,
            transcript: live.transcript.slice(Math.floor(live.transcript.length / 2)),
            sidecarTruncated: true,
          },
        },
      },
    };
  }
};
