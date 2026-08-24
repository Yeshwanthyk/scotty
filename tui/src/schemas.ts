import { Option, Schema } from "effect";
import {
  PiConsoleCommandErrorV1Schema,
  PiConsoleCommandReceiptV1Schema,
  PiConsoleEventEnvelopeV1Schema,
  PiConsoleSnapshotV1Schema,
  PiConsoleStaleCommandV1Schema,
  PiConsoleUnavailableV1Schema,
  type PiConsoleCommandErrorV1,
  type PiConsoleCommandReceiptV1,
  type PiConsoleEventEnvelopeV1,
  type PiConsoleSnapshotV1,
  type PiConsoleStaleCommandV1,
  type PiConsoleUnavailableV1,
} from "../../protocol/pi-console.ts";

const encoder = new TextEncoder();
const boundedString = (maxBytes: number) =>
  Schema.String.check(
    Schema.makeFilter((value) => encoder.encode(value).byteLength <= maxBytes, {
      expected: `a string of at most ${maxBytes} UTF-8 bytes`,
    }),
  );
const ShortStringSchema = boundedString(4 * 1024);
const StreamingStringSchema = boundedString(256 * 1024);
export const SessionIdSchema = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{5,31}$/u));
const ClientCredentialSchema = Schema.String.check(
  Schema.isPattern(/^scotty_client\.[0-9a-f]{12}\.[A-Za-z0-9_-]{32,128}$/u),
);
const PairingCredentialSchema = Schema.String.check(
  Schema.isPattern(/^scotty_pair\.[0-9a-f]{12}\.[A-Za-z0-9_-]{32,128}$/u),
);

export const TuiConfigSchema = Schema.Struct({
  version: Schema.Literal(1),
  origin: ShortStringSchema,
  credential: ClientCredentialSchema,
});
export type TuiConfig = typeof TuiConfigSchema.Type;

const SessionStatusSchema = Schema.Literals(["provisioning", "warm", "stopped", "gone"]);
const ProviderSchema = Schema.Literals(["cloudflare", "runner"]);
const ActivitySchema = Schema.Literals(["working", "waiting", "completed", "tool-stalled"]);
const SessionOperationResultSchema = Schema.Struct({
  kind: Schema.Literals([
    "create",
    "snapshot",
    "resume",
    "refresh",
    "evidence",
    "hatch",
    "down",
    "vaporize",
  ]),
  stage: Schema.Literals([
    "acquired",
    "setup",
    "runtime",
    "checkpoint",
    "stop",
    "restore",
    "refresh",
    "evidence",
    "hatch",
    "publish",
    "cleanup",
    "reconcile",
    "commit",
  ]),
  progress: Schema.Literals(["pending", "running", "completed"]),
  lastProvenEffect: Schema.Literals([
    "none",
    "session_created",
    "runtime_ready",
    "checkpoint_committed",
    "runtime_stopped",
    "resources_absent",
  ]),
  retainedState: Schema.Literals([
    "session",
    "runtime",
    "checkpoint",
    "operation_lease",
    "cleanup_authority",
  ]),
  ambiguity: Schema.Literals(["none", "provider_effect_unknown"]),
  safeRetry: Schema.Literals(["none", "retry_operation", "reconcile_first"]),
  humanAction: Schema.Literals(["none", "retry", "inspect", "resume", "vaporize"]),
  outcome: Schema.Union([
    Schema.Struct({ status: Schema.Literal("pending") }),
    Schema.Struct({ status: Schema.Literal("succeeded") }),
    Schema.Struct({
      status: Schema.Literal("failed"),
      failure: Schema.Struct({
        code: Schema.Literals([
          "checkpoint_required",
          "checkpoint_runtime_unavailable",
          "create_ambiguous",
          "create_failed",
          "down_failed",
          "environment_refresh_failed",
          "hatch_failed",
          "hard_cap_checkpoint_failed",
          "resume_failed",
          "runner_runtime_absent",
          "runtime_stopped",
          "snapshot_failed",
        ]),
        message: ShortStringSchema,
      }),
    }),
  ]),
  stoppedReason: Schema.optionalKey(
    Schema.Literals(["snapshot", "inactivity", "hard_cap", "runtime_exit"]),
  ),
  recoveryAction: Schema.Literals(["none", "resume", "retry", "reconcile", "vaporize"]),
  startedAt: ShortStringSchema,
  updatedAt: ShortStringSchema,
});

export const FleetSessionSchema = Schema.Struct({
  version: Schema.Literal(1),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  id: SessionIdSchema,
  title: ShortStringSchema,
  status: SessionStatusSchema,
  provider: ProviderSchema,
  runner: Schema.optionalKey(ShortStringSchema),
  repo: ShortStringSchema,
  defaultBranch: ShortStringSchema,
  branch: ShortStringSchema,
  backupId: Schema.optionalKey(ShortStringSchema),
  codexThreadId: Schema.optionalKey(ShortStringSchema),
  agentState: Schema.optionalKey(ActivitySchema),
  lastAgentEventAt: Schema.optionalKey(ShortStringSchema),
  createdAt: ShortStringSchema,
  updatedAt: ShortStringSchema,
  hardCapAt: ShortStringSchema,
  projectedAt: ShortStringSchema,
  operationResult: Schema.optionalKey(SessionOperationResultSchema),
  ageSeconds: Schema.optionalKey(Schema.Finite),
  capRemainingSeconds: Schema.optionalKey(Schema.Finite),
});
export type FleetSession = typeof FleetSessionSchema.Type;

export const FleetResponseSchema = Schema.Array(FleetSessionSchema).check(Schema.isMaxLength(500));
export const SelectedSessionSchema = FleetSessionSchema;
export type SelectedSession = typeof SelectedSessionSchema.Type;

export const CreateSessionResultSchema = Schema.Struct({
  id: SessionIdSchema,
  title: ShortStringSchema,
  url: ShortStringSchema,
  branch: ShortStringSchema,
  provider: ProviderSchema,
  runner: Schema.optionalKey(ShortStringSchema),
  status: SessionStatusSchema,
});
export type CreateSessionResult = typeof CreateSessionResultSchema.Type;

export const VaporizeSessionResultSchema = Schema.Struct({
  id: SessionIdSchema,
  status: Schema.Literal("gone"),
});
export type VaporizeSessionResult = typeof VaporizeSessionResultSchema.Type;

const ApiErrorResponseSchema = Schema.Struct({
  error: Schema.Struct({
    message: ShortStringSchema,
  }),
});

export const PairingResponseSchema = Schema.Struct({
  client: Schema.Struct({ id: ShortStringSchema }),
});

export const ToolEventSchema = Schema.Struct({
  type: Schema.Literals(["tool_execution_start", "tool_execution_update", "tool_execution_end"]),
  toolCallId: Schema.optionalKey(ShortStringSchema),
  tool_call_id: Schema.optionalKey(ShortStringSchema),
  id: Schema.optionalKey(ShortStringSchema),
  toolName: Schema.optionalKey(ShortStringSchema),
  name: Schema.optionalKey(ShortStringSchema),
  args: Schema.optionalKey(Schema.Json),
  arguments: Schema.optionalKey(Schema.Json),
  partialResult: Schema.optionalKey(Schema.Json),
  output: Schema.optionalKey(Schema.Json),
});
export type ToolEvent = typeof ToolEventSchema.Type;

export const JsonObjectSchema = Schema.Record(Schema.String, Schema.Json);
export type JsonObject = typeof JsonObjectSchema.Type;
const decodeJsonObjectOption = Schema.decodeUnknownOption(JsonObjectSchema);
export const decodeJsonObject = (value: unknown): JsonObject | undefined =>
  Option.getOrUndefined(decodeJsonObjectOption(value));
export const RemoteToolArgumentsSchema = JsonObjectSchema;
export type RemoteToolArguments = typeof RemoteToolArgumentsSchema.Type;

const RemoteTextContentSchema = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});
const RemoteThinkingContentSchema = Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
});
const RemoteToolCallContentSchema = Schema.Struct({
  type: Schema.Literal("toolCall"),
  id: Schema.String,
  name: Schema.String,
  arguments: RemoteToolArgumentsSchema,
});
const RemoteAssistantContentSchema = Schema.Union([
  RemoteTextContentSchema,
  RemoteThinkingContentSchema,
  RemoteToolCallContentSchema,
]);
const RemoteTextContentArraySchema = Schema.Array(RemoteTextContentSchema);
const RemoteUserMessageSchema = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Union([Schema.String, RemoteTextContentArraySchema]),
});
const RemoteToolResultMessageSchema = Schema.Struct({
  role: Schema.Literal("toolResult"),
  toolCallId: Schema.String,
  toolName: Schema.String,
  content: RemoteTextContentArraySchema,
  isError: Schema.Boolean,
});
const RemoteAssistantMessageSchema = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(RemoteAssistantContentSchema),
  api: Schema.optionalKey(Schema.Unknown),
  provider: Schema.optionalKey(Schema.Unknown),
  model: Schema.optionalKey(Schema.Unknown),
  stopReason: Schema.optionalKey(Schema.Unknown),
  timestamp: Schema.optionalKey(Schema.Unknown),
  errorMessage: Schema.optionalKey(Schema.Unknown),
});
export type RemoteUserMessage = typeof RemoteUserMessageSchema.Type;
export type RemoteToolResultMessage = typeof RemoteToolResultMessageSchema.Type;
export type RemoteAssistantMessage = typeof RemoteAssistantMessageSchema.Type;
export type RemoteAssistantContent = RemoteAssistantMessage["content"][number];
export type RemoteToolCallContent = Extract<RemoteAssistantContent, { readonly type: "toolCall" }>;
const decodeRemoteUserMessageOption = Schema.decodeUnknownOption(RemoteUserMessageSchema);
const decodeRemoteToolResultMessageOption = Schema.decodeUnknownOption(
  RemoteToolResultMessageSchema,
);
const decodeRemoteAssistantMessageOption = Schema.decodeUnknownOption(RemoteAssistantMessageSchema);
export const decodeRemoteUserMessage = (value: unknown): RemoteUserMessage | undefined =>
  Option.getOrUndefined(decodeRemoteUserMessageOption(value));
export const decodeRemoteToolResultMessage = (
  value: unknown,
): RemoteToolResultMessage | undefined =>
  Option.getOrUndefined(decodeRemoteToolResultMessageOption(value));
export const decodeRemoteAssistantMessage = (value: unknown): RemoteAssistantMessage | undefined =>
  Option.getOrUndefined(decodeRemoteAssistantMessageOption(value));

const ContentIndexSchema = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1024 }));
const AssistantMessageEventSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text_start"), contentIndex: ContentIndexSchema }),
  Schema.Struct({
    type: Schema.Literal("text_delta"),
    contentIndex: ContentIndexSchema,
    delta: StreamingStringSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("text_end"),
    contentIndex: ContentIndexSchema,
    content: StreamingStringSchema,
  }),
  Schema.Struct({ type: Schema.Literal("thinking_start"), contentIndex: ContentIndexSchema }),
  Schema.Struct({
    type: Schema.Literal("thinking_delta"),
    contentIndex: ContentIndexSchema,
    delta: StreamingStringSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("thinking_end"),
    contentIndex: ContentIndexSchema,
    content: StreamingStringSchema,
  }),
  Schema.Struct({ type: Schema.Literal("toolcall_start"), contentIndex: ContentIndexSchema }),
  Schema.Struct({
    type: Schema.Literal("toolcall_delta"),
    contentIndex: ContentIndexSchema,
    delta: StreamingStringSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("toolcall_end"),
    contentIndex: ContentIndexSchema,
    toolCall: Schema.Struct({
      type: Schema.Literal("toolCall"),
      id: ShortStringSchema,
      name: ShortStringSchema,
      arguments: Schema.Record(Schema.String, Schema.Json),
      thoughtSignature: Schema.optionalKey(StreamingStringSchema),
    }),
  }),
]);
export type AssistantMessageEvent = typeof AssistantMessageEventSchema.Type;

export const MessageEventSchema = Schema.Struct({
  type: Schema.Literals(["message_start", "message_update", "message_end"]),
  message: Schema.optionalKey(Schema.Json),
  assistantMessageEvent: Schema.optionalKey(AssistantMessageEventSchema),
});
export type MessageEvent = typeof MessageEventSchema.Type;

const MessageIdentitySchema = Schema.Struct({
  id: Schema.optionalKey(ShortStringSchema),
  messageId: Schema.optionalKey(ShortStringSchema),
  message_id: Schema.optionalKey(ShortStringSchema),
  role: Schema.optionalKey(ShortStringSchema),
  timestamp: Schema.optionalKey(Schema.Union([ShortStringSchema, Schema.Finite])),
});

const QueueEventSchema = Schema.Struct({
  type: Schema.Literal("queue_update"),
  steering: Schema.optionalKey(Schema.Array(Schema.Json)),
  steer: Schema.optionalKey(Schema.Array(Schema.Json)),
  followUp: Schema.optionalKey(Schema.Array(Schema.Json)),
  follow_up: Schema.optionalKey(Schema.Array(Schema.Json)),
});

const PendingUiResolutionEventSchema = Schema.Struct({
  type: Schema.Literals([
    "extension_ui_response",
    "extension_ui_cancelled",
    "extension_ui_closed",
    "scotty_extension_ui_expired",
  ]),
  id: ShortStringSchema,
});

export const EventTypeSchema = Schema.Struct({ type: ShortStringSchema });

const ExtensionUiEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: ShortStringSchema,
    method: Schema.Literal("select"),
    title: ShortStringSchema,
    options: Schema.Array(ShortStringSchema).check(Schema.isMaxLength(100)),
    timeout: Schema.optionalKey(Schema.Finite),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: ShortStringSchema,
    method: Schema.Literal("confirm"),
    title: ShortStringSchema,
    message: ShortStringSchema,
    timeout: Schema.optionalKey(Schema.Finite),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: ShortStringSchema,
    method: Schema.Literal("input"),
    title: ShortStringSchema,
    placeholder: Schema.optionalKey(ShortStringSchema),
    timeout: Schema.optionalKey(Schema.Finite),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: ShortStringSchema,
    method: Schema.Literal("editor"),
    title: ShortStringSchema,
    prefill: Schema.optionalKey(ShortStringSchema),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: ShortStringSchema,
    method: Schema.Literal("notify"),
    message: ShortStringSchema,
    notifyType: Schema.optionalKey(Schema.Literals(["info", "warning", "error"])),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: ShortStringSchema,
    method: Schema.Literal("setStatus"),
    statusKey: ShortStringSchema,
    statusText: Schema.optionalKey(Schema.NullOr(ShortStringSchema)),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: ShortStringSchema,
    method: Schema.Literal("setWidget"),
    widgetKey: ShortStringSchema,
    widgetLines: Schema.optionalKey(
      Schema.NullOr(Schema.Array(ShortStringSchema).check(Schema.isMaxLength(20))),
    ),
    widgetPlacement: Schema.optionalKey(Schema.Literals(["aboveEditor", "belowEditor"])),
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: ShortStringSchema,
    method: Schema.Literal("setTitle"),
    title: ShortStringSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: ShortStringSchema,
    method: Schema.Literal("set_editor_text"),
    text: ShortStringSchema,
  }),
]);
export type ExtensionUiEvent = typeof ExtensionUiEventSchema.Type;

const StreamingStateSchema = Schema.Struct({
  isStreaming: Schema.optionalKey(Schema.Boolean),
  active: Schema.optionalKey(Schema.Boolean),
  isActive: Schema.optionalKey(Schema.Boolean),
});

const decodeFleetOption = Schema.decodeUnknownOption(FleetResponseSchema, {
  onExcessProperty: "error",
});
const decodeSelectedOption = Schema.decodeUnknownOption(SelectedSessionSchema, {
  onExcessProperty: "error",
});
const decodeCreateSessionResultOption = Schema.decodeUnknownOption(CreateSessionResultSchema, {
  onExcessProperty: "error",
});
const decodeVaporizeSessionResultOption = Schema.decodeUnknownOption(VaporizeSessionResultSchema, {
  onExcessProperty: "error",
});
const decodeApiErrorResponseOption = Schema.decodeUnknownOption(ApiErrorResponseSchema);
const decodePairingOption = Schema.decodeUnknownOption(PairingResponseSchema);
const decodeSnapshotOption = Schema.decodeUnknownOption(PiConsoleSnapshotV1Schema, {
  onExcessProperty: "error",
});
const decodeUnavailableOption = Schema.decodeUnknownOption(PiConsoleUnavailableV1Schema, {
  onExcessProperty: "error",
});
const decodeReceiptOption = Schema.decodeUnknownOption(PiConsoleCommandReceiptV1Schema, {
  onExcessProperty: "error",
});
const decodeCommandErrorOption = Schema.decodeUnknownOption(PiConsoleCommandErrorV1Schema, {
  onExcessProperty: "error",
});
const decodeStaleCommandOption = Schema.decodeUnknownOption(PiConsoleStaleCommandV1Schema, {
  onExcessProperty: "error",
});
const decodeEnvelopeOption = Schema.decodeUnknownOption(PiConsoleEventEnvelopeV1Schema, {
  onExcessProperty: "error",
});
const decodeJsonOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeToolEventOption = Schema.decodeUnknownOption(ToolEventSchema);
const decodeMessageEventOption = Schema.decodeUnknownOption(MessageEventSchema);
const decodeMessageIdentityOption = Schema.decodeUnknownOption(MessageIdentitySchema);
const decodeQueueEventOption = Schema.decodeUnknownOption(QueueEventSchema);
const decodePendingUiResolutionEventOption = Schema.decodeUnknownOption(
  PendingUiResolutionEventSchema,
);
const decodeEventTypeOption = Schema.decodeUnknownOption(EventTypeSchema);
const decodeExtensionUiEventOption = Schema.decodeUnknownOption(ExtensionUiEventSchema);
const decodeStreamingStateOption = Schema.decodeUnknownOption(StreamingStateSchema);

export const decodeFleet = (value: unknown): ReadonlyArray<FleetSession> | undefined =>
  Option.getOrUndefined(decodeFleetOption(value));
export const decodeSelected = (value: unknown): SelectedSession | undefined =>
  Option.getOrUndefined(decodeSelectedOption(value));
export const decodeCreateSessionResult = (value: unknown): CreateSessionResult | undefined =>
  Option.getOrUndefined(decodeCreateSessionResultOption(value));
export const decodeVaporizeSessionResult = (value: unknown): VaporizeSessionResult | undefined =>
  Option.getOrUndefined(decodeVaporizeSessionResultOption(value));
export const decodeApiErrorMessage = (value: unknown): string | undefined =>
  Option.getOrUndefined(decodeApiErrorResponseOption(value))?.error.message;
export const decodePairing = (
  value: unknown,
): { readonly client: { readonly id: string } } | undefined =>
  Option.getOrUndefined(decodePairingOption(value));
export const decodeSnapshot = (value: unknown): PiConsoleSnapshotV1 | undefined =>
  Option.getOrUndefined(decodeSnapshotOption(value));
export const decodeUnavailable = (value: unknown): PiConsoleUnavailableV1 | undefined =>
  Option.getOrUndefined(decodeUnavailableOption(value));
export const decodeReceipt = (value: unknown): PiConsoleCommandReceiptV1 | undefined =>
  Option.getOrUndefined(decodeReceiptOption(value));
export const decodeCommandError = (value: unknown): PiConsoleCommandErrorV1 | undefined =>
  Option.getOrUndefined(decodeCommandErrorOption(value));
export const decodeStaleCommand = (value: unknown): PiConsoleStaleCommandV1 | undefined =>
  Option.getOrUndefined(decodeStaleCommandOption(value));
export const decodeEnvelope = (value: unknown): PiConsoleEventEnvelopeV1 | undefined =>
  Option.getOrUndefined(decodeEnvelopeOption(value));
export const decodeJsonText = (value: string): unknown | undefined =>
  Option.getOrUndefined(decodeJsonOption(value));
const decodeClientCredentialOption = Schema.decodeUnknownOption(ClientCredentialSchema);
const decodePairingCredentialOption = Schema.decodeUnknownOption(PairingCredentialSchema);
export const decodeClientCredential = (value: unknown): string | undefined =>
  Option.getOrUndefined(decodeClientCredentialOption(value));
export const decodePairingCredential = (value: unknown): string | undefined =>
  Option.getOrUndefined(decodePairingCredentialOption(value));
export const decodeToolEvent = (value: unknown): ToolEvent | undefined =>
  Option.getOrUndefined(decodeToolEventOption(value));
export const decodeMessageEvent = (value: unknown): MessageEvent | undefined =>
  Option.getOrUndefined(decodeMessageEventOption(value));
export const decodeMessageIdentity = (
  value: unknown,
): typeof MessageIdentitySchema.Type | undefined =>
  Option.getOrUndefined(decodeMessageIdentityOption(value));
export const decodeQueueEvent = (value: unknown): typeof QueueEventSchema.Type | undefined =>
  Option.getOrUndefined(decodeQueueEventOption(value));
export const decodePendingUiResolutionEvent = (
  value: unknown,
): typeof PendingUiResolutionEventSchema.Type | undefined =>
  Option.getOrUndefined(decodePendingUiResolutionEventOption(value));
export const decodeEventType = (value: unknown): { readonly type: string } | undefined =>
  Option.getOrUndefined(decodeEventTypeOption(value));
export const decodeExtensionUiEvent = (value: unknown): ExtensionUiEvent | undefined =>
  Option.getOrUndefined(decodeExtensionUiEventOption(value));
export const decodeStreaming = (value: unknown): boolean => {
  const state = Option.getOrUndefined(decodeStreamingStateOption(value));
  return state?.isStreaming ?? state?.active ?? state?.isActive ?? false;
};

export type ConsoleSnapshotResult = PiConsoleSnapshotV1 | PiConsoleUnavailableV1;
