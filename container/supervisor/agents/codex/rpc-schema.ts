import { Effect, Schema } from "effect";

const Envelope = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});
export const RpcFailure = Schema.Struct({ code: Schema.Number, message: Schema.String });

export const TurnNotice = Schema.Struct({
  threadId: Schema.String,
  turn: Schema.Struct({
    id: Schema.String,
    status: Schema.Union([
      Schema.Literal("inProgress"),
      Schema.Literal("completed"),
      Schema.Literal("interrupted"),
      Schema.Literal("failed"),
    ]),
  }),
});

// Keep the raw notification separate from the fields used for routing.
export const decodeRpcLine = (line: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(line).pipe(
    Effect.flatMap((raw) =>
      Schema.decodeUnknownEffect(Envelope)(raw).pipe(Effect.map((message) => ({ raw, message }))),
    ),
  );
