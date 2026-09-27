import { Option, Schema } from "effect";

export const CONVERSATION_WIRE_VERSION = 1 as const;
export const CONVERSATION_MAX_ID_BYTES = 256;
export const CONVERSATION_MAX_ELAPSED_SECONDS = 7 * 24 * 60 * 60;
export const CONVERSATION_MAX_QUEUE_ITEMS = 100;

const utf8Encoder = new TextEncoder();
// Producers such as Pi may cap their display values. The public snapshot decoder
// must not reject full Codex content merely because a producer uses a display budget.
const BoundedConversationStringSchema = Schema.String;
const ConversationIdSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter((value) => utf8Encoder.encode(value).byteLength <= CONVERSATION_MAX_ID_BYTES, {
    expected: `a non-empty identifier of at most ${CONVERSATION_MAX_ID_BYTES} UTF-8 bytes`,
  }),
);
const SequenceSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const ElapsedSecondsSchema = Schema.Finite.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(CONVERSATION_MAX_ELAPSED_SECONDS),
);

export const CanonicalConversationTransportSchema = Schema.Struct({
  epoch: ConversationIdSchema,
  baseSequence: SequenceSchema,
  sequence: SequenceSchema,
  sessionRevision: SequenceSchema,
}).check(
  Schema.makeFilter(({ baseSequence, sequence }) => baseSequence <= sequence, {
    expected: "a transport with baseSequence no greater than sequence",
  }),
);
export type CanonicalConversationTransport = typeof CanonicalConversationTransportSchema.Type;

export const CanonicalConversationToolSchema = Schema.Struct({
  id: ConversationIdSchema,
  state: Schema.Literals(["completed", "running", "failed", "cancelled"]),
  label: BoundedConversationStringSchema,
  invocation: BoundedConversationStringSchema,
  output: Schema.optionalKey(BoundedConversationStringSchema),
});
export type CanonicalConversationTool = typeof CanonicalConversationToolSchema.Type;

export const CanonicalConversationTurnSchema = Schema.Struct({
  id: ConversationIdSchema,
  state: Schema.Literals(["completed", "streaming", "failed", "aborted"]),
  user: BoundedConversationStringSchema,
  assistant: BoundedConversationStringSchema,
  activitySummary: Schema.optionalKey(BoundedConversationStringSchema),
  tools: Schema.Array(CanonicalConversationToolSchema),
  elapsedSeconds: Schema.optionalKey(ElapsedSecondsSchema),
});
export type CanonicalConversationTurn = typeof CanonicalConversationTurnSchema.Type;

export const CanonicalConversationQueueItemSchema = Schema.Struct({
  id: ConversationIdSchema,
  text: BoundedConversationStringSchema,
});
export type CanonicalConversationQueueItem = typeof CanonicalConversationQueueItemSchema.Type;

export const CanonicalConversationQueueSchema = Schema.Struct({
  steer: Schema.Array(CanonicalConversationQueueItemSchema).check(
    Schema.isMaxLength(CONVERSATION_MAX_QUEUE_ITEMS),
  ),
  followUp: Schema.Array(CanonicalConversationQueueItemSchema).check(
    Schema.isMaxLength(CONVERSATION_MAX_QUEUE_ITEMS),
  ),
});
export type CanonicalConversationQueue = typeof CanonicalConversationQueueSchema.Type;

export const CanonicalConversationTruncationSchema = Schema.Struct({
  turns: Schema.Boolean,
  values: Schema.Boolean,
});
export type CanonicalConversationTruncation = typeof CanonicalConversationTruncationSchema.Type;

export const CanonicalConversationSnapshotSchema = Schema.Struct({
  runtimeStopped: Schema.optionalKey(Schema.Boolean),
  runtimeFailure: Schema.optionalKey(
    Schema.Struct({
      code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
      diagnostic: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
    }),
  ),
  followUpAvailable: Schema.optionalKey(Schema.Boolean),
  followUpBlocked: Schema.optionalKey(Schema.Boolean),
  // Actor admission may pause while a warm runtime remains readable.
  messageAdmissionAvailable: Schema.optionalKey(Schema.Boolean),
  version: Schema.Literal(CONVERSATION_WIRE_VERSION),
  transport: CanonicalConversationTransportSchema,
  turns: Schema.Array(CanonicalConversationTurnSchema),
  queue: CanonicalConversationQueueSchema,
  truncated: CanonicalConversationTruncationSchema,
});
export type CanonicalConversationSnapshot = typeof CanonicalConversationSnapshotSchema.Type;

export const decodeCanonicalConversationSnapshot = Schema.decodeUnknownEffect(
  CanonicalConversationSnapshotSchema,
  { onExcessProperty: "error" },
);

const decodeCanonicalConversationSnapshotOption = Schema.decodeUnknownOption(
  CanonicalConversationSnapshotSchema,
  { onExcessProperty: "error" },
);

export const decodeCanonicalConversationSnapshotSync = (
  value: unknown,
): CanonicalConversationSnapshot | undefined =>
  Option.getOrUndefined(decodeCanonicalConversationSnapshotOption(value));
