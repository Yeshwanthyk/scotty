import { Schema } from "effect";

export const CONVERSATION_WIRE_VERSION = 1 as const;
export const CONVERSATION_MAX_TURNS = 100;
export const CONVERSATION_MAX_TOOLS_PER_TURN = 32;
export const CONVERSATION_MAX_ID_BYTES = 256;
export const CONVERSATION_MAX_TEXT_BYTES = 16 * 1024;
export const CONVERSATION_MAX_TOOL_VALUE_BYTES = 1_200;
export const CONVERSATION_MAX_ELAPSED_SECONDS = 7 * 24 * 60 * 60;

const utf8Encoder = new TextEncoder();
const BoundedConversationStringSchema = Schema.String.check(
  Schema.makeFilter(
    (value) => utf8Encoder.encode(value).byteLength <= CONVERSATION_MAX_TEXT_BYTES,
    { expected: `a string of at most ${CONVERSATION_MAX_TEXT_BYTES} UTF-8 bytes` },
  ),
);
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
});
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
  state: Schema.Literals(["completed", "streaming"]),
  user: BoundedConversationStringSchema,
  assistant: BoundedConversationStringSchema,
  activitySummary: Schema.optionalKey(BoundedConversationStringSchema),
  tools: Schema.Array(CanonicalConversationToolSchema).check(
    Schema.isMaxLength(CONVERSATION_MAX_TOOLS_PER_TURN),
  ),
  elapsedSeconds: Schema.optionalKey(ElapsedSecondsSchema),
});
export type CanonicalConversationTurn = typeof CanonicalConversationTurnSchema.Type;

export const CanonicalConversationTruncationSchema = Schema.Struct({
  turns: Schema.Boolean,
  values: Schema.Boolean,
});
export type CanonicalConversationTruncation = typeof CanonicalConversationTruncationSchema.Type;

export const CanonicalConversationSnapshotSchema = Schema.Struct({
  version: Schema.Literal(CONVERSATION_WIRE_VERSION),
  transport: CanonicalConversationTransportSchema,
  turns: Schema.Array(CanonicalConversationTurnSchema).check(
    Schema.isMaxLength(CONVERSATION_MAX_TURNS),
  ),
  truncated: CanonicalConversationTruncationSchema,
});
export type CanonicalConversationSnapshot = typeof CanonicalConversationSnapshotSchema.Type;

export const decodeCanonicalConversationSnapshot = Schema.decodeUnknownEffect(
  CanonicalConversationSnapshotSchema,
  { onExcessProperty: "error" },
);
