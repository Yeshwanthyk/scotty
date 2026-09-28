import { Option, Schema } from "effect";

const Turn = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["completed", "streaming", "failed", "aborted"]),
  user: Schema.String,
  assistant: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      type: Schema.String,
      size: Schema.Number,
      caption: Schema.optionalKey(Schema.String),
    }),
  ),
});

const CanonicalConversationSnapshotSchema = Schema.Struct({
  version: Schema.Literal(1),
  currentTurn: Schema.String,
  turns: Schema.Array(Turn),
});
export type CanonicalConversationSnapshot = typeof CanonicalConversationSnapshotSchema.Type;

const decode = Schema.decodeUnknownOption(CanonicalConversationSnapshotSchema);
export const decodeCanonicalConversationSnapshotSync = (
  value: unknown,
): CanonicalConversationSnapshot | undefined => Option.getOrUndefined(decode(value));
