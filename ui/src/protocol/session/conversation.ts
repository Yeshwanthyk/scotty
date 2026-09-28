import { Option, Schema } from "effect";

const Change = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["add", "delete", "update"]),
  diff: Schema.String,
});

const Item = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("text"),
    id: Schema.String,
    text: Schema.String,
    final: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("thinking"), id: Schema.String, text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("tool"),
    id: Schema.String,
    name: Schema.String,
    category: Schema.Literals(["inspect", "change", "check", "research", "agent", "run", "other"]),
    summary: Schema.String,
    status: Schema.Literals(["running", "done", "failed", "declined"]),
    input: Schema.String,
    output: Schema.String,
    exitCode: Schema.NullOr(Schema.Number),
    durationMs: Schema.NullOr(Schema.Number),
    changes: Schema.Array(Change),
  }),
  Schema.Struct({
    kind: Schema.Literal("plan"),
    id: Schema.String,
    steps: Schema.Array(Schema.Struct({ step: Schema.String, status: Schema.String })),
  }),
  Schema.Struct({
    kind: Schema.Literal("notice"),
    id: Schema.String,
    text: Schema.String,
    tone: Schema.Literals(["info", "error"]),
  }),
]);

const Turn = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(["completed", "streaming", "failed", "aborted"]),
  user: Schema.String,
  assistant: Schema.String,
  items: Schema.Array(Item),
  diff: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  endedAt: Schema.NullOr(Schema.String),
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
export type Turn = typeof Turn.Type;
export type Item = typeof Item.Type;
export type Tool = Extract<Item, { kind: "tool" }>;
export type Change = typeof Change.Type;

const decode = Schema.decodeUnknownOption(CanonicalConversationSnapshotSchema);
export const decodeCanonicalConversationSnapshotSync = (
  value: unknown,
): CanonicalConversationSnapshot | undefined => Option.getOrUndefined(decode(value));
