import { Option, Schema } from "effect";
import { PI_CONSOLE_MAX_STRING_BYTES } from "../../protocol/pi-console.ts";
import { redactRemoteString } from "./redaction.ts";
import { SessionIdSchema, type FleetSession } from "./schemas.ts";
import { projectDesktopTranscript } from "./desktop-transcript.ts";
import type { FleetConsoleState, LiveProjection, SessionViewCache } from "./state.ts";

export const DESKTOP_PROTOCOL_VERSION = 1 as const;
export const DESKTOP_MAX_COMMAND_BYTES = 64 * 1024;
export const DESKTOP_MAX_FRAME_BYTES = 8 * 1024 * 1024;

const encoder = new TextEncoder();
const boundedString = (maxBytes: number) =>
  Schema.String.check(
    Schema.makeFilter((value) => encoder.encode(value).byteLength <= maxBytes, {
      expected: `a string of at most ${maxBytes} UTF-8 bytes`,
    }),
  );
const MessageSchema = boundedString(PI_CONSOLE_MAX_STRING_BYTES);
const ShortStringSchema = boundedString(4 * 1024);
const SelectionFenceFields = {
  sessionId: SessionIdSchema,
  expectedEpoch: ShortStringSchema,
  expectedSessionRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
};

export const DesktopCommandSchema = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), type: Schema.Literal("refresh_fleet") }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("select"),
    sessionId: SessionIdSchema,
  }),
  Schema.Struct({ version: Schema.Literal(1), type: Schema.Literal("close") }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("set_draft"),
    sessionId: SessionIdSchema,
    text: MessageSchema,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("submit"),
    ...SelectionFenceFields,
    text: MessageSchema,
    forceFollowUp: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("abort"),
    ...SelectionFenceFields,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("answer"),
    ...SelectionFenceFields,
    requestId: ShortStringSchema,
    answer: Schema.Union([
      Schema.Struct({ type: Schema.Literal("value"), value: MessageSchema }),
      Schema.Struct({ type: Schema.Literal("confirmed"), confirmed: Schema.Boolean }),
      Schema.Struct({ type: Schema.Literal("cancelled") }),
    ]),
  }),
  Schema.Struct({ version: Schema.Literal(1), type: Schema.Literal("shutdown") }),
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

const projectFleetSession = (session: FleetSession) => ({
  id: session.id,
  title: redactRemoteString(session.title).slice(0, 1024),
  status: session.status,
  provider: session.provider,
  repo: redactRemoteString(session.repo).slice(0, 1024),
  branch: redactRemoteString(session.branch).slice(0, 1024),
  agentState: session.agentState,
  updatedAt: redactRemoteString(session.updatedAt).slice(0, 1024),
});

const projectLive = (live: LiveProjection | undefined) =>
  live === undefined
    ? undefined
    : {
        epoch: live.epoch,
        sequence: live.sequence,
        sessionRevision: live.sessionRevision,
        isStreaming: live.isStreaming,
        transcript: projectDesktopTranscript(live.messages, [...live.activeTools.values()]),
        pendingUi: live.pendingUi,
        activity: live.activity,
        sidecarTruncated: live.truncated.messages || live.truncated.values,
      };

const projectSelected = (cache: SessionViewCache | undefined) =>
  cache === undefined
    ? undefined
    : {
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
    fleetError:
      state.fleetError === undefined
        ? undefined
        : redactRemoteString(state.fleetError).slice(0, 1024),
    selectedSessionId,
    loading: state.loading,
    selected:
      selectedSessionId === undefined ? undefined : projectSelected(state.cache(selectedSessionId)),
  } as const;
};

export type DesktopState = ReturnType<typeof projectDesktopState>;

export type DesktopFrame =
  | { readonly version: 1; readonly type: "ready" }
  | { readonly version: 1; readonly type: "state"; readonly state: DesktopState }
  | {
      readonly version: 1;
      readonly type: "error";
      readonly code: "invalid_command" | "command_failed" | "frame_too_large";
      readonly message: string;
    }
  | { readonly version: 1; readonly type: "stopped" };

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
