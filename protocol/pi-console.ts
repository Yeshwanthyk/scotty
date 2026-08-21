import { Option, Schema } from "effect";
export {
  CREDENTIAL_SENTINEL_PREFIXES,
  ENVIRONMENT_SENTINEL_PREFIX,
  PI_CONSOLE_PASSIVE_NO_HEARTBEAT_HEADER,
  canonicalJson,
  commandIntentDigest,
  redactCredentialSentinels,
} from "./pi-console-shared.mjs";

export const PI_CONSOLE_PROTOCOL_VERSION = 1 as const;
export const PI_CONSOLE_PUBLIC_PATH_SEGMENT = "console/v1";
export const PI_CONSOLE_PROXY_PREFIX = "/_scotty/pi-console/v1";
export const PI_CONSOLE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const PI_CONSOLE_MAX_COMMAND_BYTES = 8 * 1024 * 1024;
export const PI_CONSOLE_MAX_IMAGES = 4;
export const PI_CONSOLE_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const PI_CONSOLE_ALLOWED_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;
export const PI_CONSOLE_MAX_EVENTS = 2_000;
export const PI_CONSOLE_MAX_MESSAGES = 500;
export const PI_CONSOLE_MAX_ACTIVE_TOOLS = 100;
export const PI_CONSOLE_MAX_PENDING_UI = 32;
export const PI_CONSOLE_MAX_STATUSES = 32;
export const PI_CONSOLE_MAX_WIDGETS = 16;
export const PI_CONSOLE_MAX_WIDGET_LINES = 20;
export const PI_CONSOLE_MAX_QUEUE_ITEMS = 100;
export const PI_CONSOLE_MAX_STRING_BYTES = 16 * 1024;

const utf8Encoder = new TextEncoder();
const BoundedStringSchema = Schema.String.check(
  Schema.makeFilter(
    (value) => utf8Encoder.encode(value).byteLength <= PI_CONSOLE_MAX_STRING_BYTES,
    { expected: `a string of at most ${PI_CONSOLE_MAX_STRING_BYTES} UTF-8 bytes` },
  ),
);
const NonEmptyBoundedStringSchema = BoundedStringSchema.check(Schema.isMinLength(1));
const IdentifierSchema = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/),
);
const CommandIdSchema = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu),
);
const DigestSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const SequenceSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const SessionRevisionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const WorkflowRunIdSchema = Schema.String.check(Schema.isPattern(/^wf_[0-9a-f]{12}$/u));
const BrowserSteerMessageSchema = Schema.String.check(
  Schema.makeFilter(
    (message) =>
      Array.from(message).length <= 2_048 &&
      Array.from(message).every((character) => {
        const code = character.charCodeAt(0);
        return code >= 32 && code !== 127 && (code < 128 || code > 159);
      }) &&
      message.trim().length > 0,
    { expected: "a non-empty browser steer message of at most 2048 characters" },
  ),
);
const BrowserSteerPayloadSchema = Schema.Struct({
  version: Schema.Literal(PI_CONSOLE_PROTOCOL_VERSION),
  action: Schema.Literal("steer"),
  childId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u)),
  revision: SessionRevisionSchema,
  message: BrowserSteerMessageSchema,
});
const decodeBrowserSteerPayloadJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(BrowserSteerPayloadSchema),
);
const BrowserSteerArgumentsSchema = Schema.String.check(
  Schema.makeFilter(
    (argumentsText) =>
      utf8Encoder.encode(argumentsText).byteLength <= 4 * 1_024 &&
      Option.isSome(decodeBrowserSteerPayloadJson(argumentsText)),
    { expected: "a versioned browser steer payload" },
  ),
);
const StatusesSchema = Schema.Record(IdentifierSchema, BoundedStringSchema).check(
  Schema.makeFilter((statuses) => Object.keys(statuses).length <= PI_CONSOLE_MAX_STATUSES, {
    expected: `at most ${PI_CONSOLE_MAX_STATUSES} extension statuses`,
  }),
);

export const PiConsoleEventEnvelopeV1Schema = Schema.Struct({
  epoch: IdentifierSchema,
  sequence: SequenceSchema,
  event: Schema.Json,
});
export type PiConsoleEventEnvelopeV1 = typeof PiConsoleEventEnvelopeV1Schema.Type;

const QueueItemSchema = Schema.Struct({
  id: IdentifierSchema,
  text: BoundedStringSchema,
});

const ActiveToolSchema = Schema.Struct({
  id: IdentifierSchema,
  name: BoundedStringSchema,
  status: Schema.Literal("running"),
  arguments: Schema.optionalKey(Schema.Json),
  partialResult: Schema.optionalKey(Schema.Json),
});

const PendingUiRequestSchema = Schema.Union([
  Schema.Struct({
    id: IdentifierSchema,
    method: Schema.Literal("select"),
    title: BoundedStringSchema,
    options: Schema.Array(BoundedStringSchema).check(Schema.isMaxLength(100)),
    timeout: Schema.optionalKey(Schema.Finite),
  }),
  Schema.Struct({
    id: IdentifierSchema,
    method: Schema.Literal("confirm"),
    title: BoundedStringSchema,
    message: BoundedStringSchema,
    timeout: Schema.optionalKey(Schema.Finite),
  }),
  Schema.Struct({
    id: IdentifierSchema,
    method: Schema.Literal("input"),
    title: BoundedStringSchema,
    placeholder: Schema.optionalKey(BoundedStringSchema),
    timeout: Schema.optionalKey(Schema.Finite),
  }),
  Schema.Struct({
    id: IdentifierSchema,
    method: Schema.Literal("editor"),
    title: BoundedStringSchema,
    prefill: Schema.optionalKey(BoundedStringSchema),
  }),
]);

const CommandProjectionSchema = Schema.Struct({
  name: Schema.Literals(["subagents", "workflows"]),
  description: Schema.optionalKey(BoundedStringSchema),
  source: Schema.Literal("extension"),
});

const ModelProjectionSchema = Schema.Struct({
  provider: NonEmptyBoundedStringSchema,
  id: NonEmptyBoundedStringSchema,
  name: Schema.optionalKey(BoundedStringSchema),
});

const PiConsoleRelaySnapshotV1Schema = Schema.Struct({
  version: Schema.Literal(PI_CONSOLE_PROTOCOL_VERSION),
  epoch: IdentifierSchema,
  baseSequence: SequenceSchema,
  sequence: SequenceSchema,
  state: Schema.Json,
  messages: Schema.Array(Schema.Json).check(Schema.isMaxLength(PI_CONSOLE_MAX_MESSAGES)),
  overlapEvents: Schema.Array(PiConsoleEventEnvelopeV1Schema).check(
    Schema.isMaxLength(PI_CONSOLE_MAX_EVENTS),
  ),
  activeTools: Schema.Array(ActiveToolSchema).check(
    Schema.isMaxLength(PI_CONSOLE_MAX_ACTIVE_TOOLS),
  ),
  queue: Schema.Struct({
    steer: Schema.Array(QueueItemSchema).check(Schema.isMaxLength(PI_CONSOLE_MAX_QUEUE_ITEMS)),
    followUp: Schema.Array(QueueItemSchema).check(Schema.isMaxLength(PI_CONSOLE_MAX_QUEUE_ITEMS)),
  }),
  pendingUi: Schema.Array(PendingUiRequestSchema).check(
    Schema.isMaxLength(PI_CONSOLE_MAX_PENDING_UI),
  ),
  pendingUiAuthority: Schema.Struct({
    status: Schema.Literal("partial"),
    reason: Schema.Literal("pi_0_83_signal_cancellation_unobservable"),
  }),
  extensionSurface: Schema.Struct({
    statuses: StatusesSchema,
    widgets: Schema.Array(
      Schema.Struct({
        key: IdentifierSchema,
        lines: Schema.Array(BoundedStringSchema).check(
          Schema.isMaxLength(PI_CONSOLE_MAX_WIDGET_LINES),
        ),
        placement: Schema.optionalKey(Schema.Literals(["aboveEditor", "belowEditor"])),
      }),
    ).check(Schema.isMaxLength(PI_CONSOLE_MAX_WIDGETS)),
    title: Schema.optionalKey(BoundedStringSchema),
  }),
  capabilities: Schema.Struct({
    models: Schema.Array(ModelProjectionSchema).check(Schema.isMaxLength(100)),
    thinkingLevels: Schema.Array(IdentifierSchema).check(Schema.isMaxLength(20)),
    commands: Schema.Array(CommandProjectionSchema).check(Schema.isMaxLength(2)),
  }),
  truncated: Schema.Struct({
    messages: Schema.Boolean,
    values: Schema.Boolean,
  }),
});
export type PiConsoleRelaySnapshotV1 = typeof PiConsoleRelaySnapshotV1Schema.Type;

export const PiConsoleSnapshotV1Schema = Schema.Struct({
  ...PiConsoleRelaySnapshotV1Schema.fields,
  sessionRevision: SessionRevisionSchema,
});
export type PiConsoleSnapshotV1 = typeof PiConsoleSnapshotV1Schema.Type;

const maxBase64ImageCharacters = Math.ceil(PI_CONSOLE_MAX_IMAGE_BYTES / 3) * 4;
const isBase64Character = (code: number): boolean =>
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  (code >= 48 && code <= 57) ||
  code === 43 ||
  code === 47;
const isBase64 = (data: string): boolean => {
  if (data.length === 0 || data.length % 4 !== 0) return false;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const contentLength = data.length - padding;
  for (let index = 0; index < contentLength; index += 1)
    if (!isBase64Character(data.charCodeAt(index))) return false;
  for (let index = contentLength; index < data.length; index += 1)
    if (data.charCodeAt(index) !== 61) return false;
  return true;
};
const decodedBase64Bytes = (data: string): number =>
  (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
const ImageDataSchema = Schema.String.check(
  Schema.isMaxLength(maxBase64ImageCharacters),
  Schema.makeFilter(isBase64, { expected: "a base64 encoded string" }),
);
export const PiConsoleImageSchema = Schema.Struct({
  type: Schema.Literal("image"),
  data: ImageDataSchema,
  mimeType: Schema.Literals(PI_CONSOLE_ALLOWED_IMAGE_MIME_TYPES),
});
export type PiConsoleImage = typeof PiConsoleImageSchema.Type;
export const PiConsoleImagesSchema = Schema.Array(PiConsoleImageSchema).check(
  Schema.isMaxLength(PI_CONSOLE_MAX_IMAGES),
  Schema.makeFilter(
    (images) =>
      images.reduce((total, image) => total + decodedBase64Bytes(image.data), 0) <=
      PI_CONSOLE_MAX_IMAGE_BYTES,
    { expected: `images totaling at most ${PI_CONSOLE_MAX_IMAGE_BYTES} decoded bytes` },
  ),
);

const PromptIntentSchema = Schema.Struct({
  type: Schema.Literal("prompt"),
  message: BoundedStringSchema,
  images: Schema.optionalKey(PiConsoleImagesSchema),
  streamingBehavior: Schema.optionalKey(Schema.Literals(["steer", "followUp"])),
}).check(Schema.makeFilter((intent) => !intent.message.trimStart().startsWith("/")));
const MessageIntentSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("steer"),
    message: BoundedStringSchema,
    images: Schema.optionalKey(PiConsoleImagesSchema),
  }),
  Schema.Struct({
    type: Schema.Literal("follow_up"),
    message: BoundedStringSchema,
    images: Schema.optionalKey(PiConsoleImagesSchema),
  }),
]);
const ExtensionUiResponseIntentSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("extension_ui_response"),
    id: IdentifierSchema,
    value: BoundedStringSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_response"),
    id: IdentifierSchema,
    confirmed: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_response"),
    id: IdentifierSchema,
    cancelled: Schema.Literal(true),
  }),
]);

export const PiConsoleRemoteIntentV1Schema = Schema.Union([
  PromptIntentSchema,
  MessageIntentSchema,
  Schema.Struct({ type: Schema.Literal("abort") }),
  ExtensionUiResponseIntentSchema,
  Schema.Struct({
    type: Schema.Literal("set_model"),
    provider: NonEmptyBoundedStringSchema,
    modelId: NonEmptyBoundedStringSchema,
  }),
  Schema.Struct({ type: Schema.Literal("set_thinking_level"), level: IdentifierSchema }),
  Schema.Struct({
    type: Schema.Literal("slash_command"),
    name: Schema.Literal("subagents"),
    arguments: Schema.optionalKey(BrowserSteerArgumentsSchema),
  }),
  Schema.Struct({
    type: Schema.Literal("slash_command"),
    name: Schema.Literal("workflows"),
    arguments: Schema.optionalKey(WorkflowRunIdSchema),
  }),
]);
export type PiConsoleRemoteIntentV1 = typeof PiConsoleRemoteIntentV1Schema.Type;

export type PiConsoleLocalIntentV1 = {
  readonly type: "fold";
  readonly targetId: string;
  readonly folded: boolean;
};

export const PiConsoleCommandV1Schema = Schema.Struct({
  version: Schema.Literal(PI_CONSOLE_PROTOCOL_VERSION),
  epoch: IdentifierSchema,
  commandId: CommandIdSchema,
  expectedSessionRevision: SessionRevisionSchema,
  intent: PiConsoleRemoteIntentV1Schema,
});
export type PiConsoleCommandV1 = typeof PiConsoleCommandV1Schema.Type;

export const PiConsoleCommandReceiptV1Schema = Schema.Struct({
  version: Schema.Literal(PI_CONSOLE_PROTOCOL_VERSION),
  epoch: IdentifierSchema,
  commandId: CommandIdSchema,
  commandDigest: DigestSchema,
  status: Schema.Literals(["accepted", "rejected", "delivered"]),
  response: Schema.Json,
});
export type PiConsoleCommandReceiptV1 = typeof PiConsoleCommandReceiptV1Schema.Type;

export const PiConsoleCommandErrorV1Schema = Schema.Struct({
  version: Schema.Literal(PI_CONSOLE_PROTOCOL_VERSION),
  status: Schema.Literal("error"),
  code: Schema.Literals([
    "command_id_conflict",
    "extension_ui_not_pending",
    "extension_ui_response_already_delivered",
    "invalid_command",
    "pi_quiescing",
    "scotty_epoch_changed",
  ]),
  retryable: Schema.Literal(false),
});
export type PiConsoleCommandErrorV1 = typeof PiConsoleCommandErrorV1Schema.Type;

export const PiConsoleStaleCommandV1Schema = Schema.Struct({
  version: Schema.Literal(PI_CONSOLE_PROTOCOL_VERSION),
  status: Schema.Literal("stale"),
  expectedSessionRevision: SessionRevisionSchema,
  sessionRevision: SessionRevisionSchema,
  retryable: Schema.Literal(false),
});
export type PiConsoleStaleCommandV1 = typeof PiConsoleStaleCommandV1Schema.Type;

export const PiConsoleUnavailableV1Schema = Schema.Struct({
  version: Schema.Literal(PI_CONSOLE_PROTOCOL_VERSION),
  status: Schema.Literal("unavailable"),
  reason: Schema.Literals([
    "provider_passive_relay_unavailable",
    "session_authority_unavailable",
    "session_not_warm",
    "session_operation_active",
    "provider_unsupported",
  ]),
  retryable: Schema.Boolean,
});
export type PiConsoleUnavailableV1 = typeof PiConsoleUnavailableV1Schema.Type;

export const decodePiConsoleRelaySnapshotV1 = Schema.decodeUnknownPromise(
  PiConsoleRelaySnapshotV1Schema,
);
export const decodePiConsoleSnapshotV1 = Schema.decodeUnknownEffect(PiConsoleSnapshotV1Schema);
export const decodePiConsoleCommandV1 = Schema.decodeUnknownEffect(PiConsoleCommandV1Schema, {
  onExcessProperty: "error",
});
export const decodePiConsoleCommandV1Promise = Schema.decodeUnknownPromise(
  PiConsoleCommandV1Schema,
  {
    onExcessProperty: "error",
  },
);
export const decodePiConsoleCommandReceiptV1 = Schema.decodeUnknownEffect(
  PiConsoleCommandReceiptV1Schema,
);
export const decodePiConsoleCommandErrorV1 = Schema.decodeUnknownEffect(
  PiConsoleCommandErrorV1Schema,
);
export const decodePiConsoleUnavailableV1 = Schema.decodeUnknownEffect(
  PiConsoleUnavailableV1Schema,
);
export const decodePiConsoleStaleCommandV1 = Schema.decodeUnknownEffect(
  PiConsoleStaleCommandV1Schema,
);
