import { Result, Schema } from "effect";

export const CODEX_VERSION = "0.153.4";
export const CODEX_MAX_MESSAGE_BYTES = 256 * 1024;
export const CODEX_MAX_TEXT_BYTES = 64 * 1024;

const utf8 = new TextEncoder();
const boundedText = (max: number) =>
  Schema.String.check(
    Schema.isMaxLength(max),
    Schema.makeFilter((text) => utf8.encode(text).byteLength <= max),
  );
const Identifier = boundedText(256).check(Schema.isMinLength(1));
const Text = boundedText(CODEX_MAX_TEXT_BYTES);
const Path = boundedText(4096).check(Schema.isPattern(/^\//u));
const SafeInteger = Schema.Int.check(
  Schema.isBetween({ minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER }),
);
const RequestId = Schema.Union([Identifier, SafeInteger]);
const Empty = Schema.Record(Schema.String, Schema.Never);
const TurnIdentity = Schema.Struct({ threadId: Identifier, turnId: Identifier });

export const CodexClientMessageSchema = Schema.Union([
  Schema.Struct({
    id: RequestId,
    method: Schema.Literal("initialize"),
    params: Schema.Struct({
      clientInfo: Schema.Struct({ name: Identifier, version: Identifier }),
      capabilities: Schema.Struct({ experimentalApi: Schema.Literal(false) }),
    }),
  }),
  Schema.Struct({ method: Schema.Literal("initialized") }),
  Schema.Struct({
    id: RequestId,
    method: Schema.Literal("thread/start"),
    params: Schema.Struct({
      model: Identifier,
      modelProvider: Identifier,
      cwd: Path,
      approvalPolicy: Schema.Literal("never"),
      sandbox: Schema.Literal("danger-full-access"),
      ephemeral: Schema.Literal(true),
    }),
  }),
  Schema.Struct({
    id: RequestId,
    method: Schema.Literal("turn/start"),
    params: Schema.Struct({
      threadId: Identifier,
      input: Schema.Tuple([
        Schema.Struct({ type: Schema.Literal("text"), text: Text.check(Schema.isMinLength(1)) }),
      ]),
      effort: Identifier,
    }),
  }),
  Schema.Struct({ id: RequestId, method: Schema.Literal("turn/interrupt"), params: TurnIdentity }),
]);
export type CodexClientMessage = typeof CodexClientMessageSchema.Type;

// Incoming payloads are projections, not full upstream objects. Never preserve excess fields.
const projection = { parseOptions: { onExcessProperty: "ignore" } } as const;
const AgentMessage = Schema.Struct({
  type: Schema.Literal("agentMessage"),
  id: Identifier,
  text: Text,
  phase: Schema.optionalKey(Schema.NullOr(Schema.Literals(["commentary", "final_answer"]))),
}).annotate(projection);
const TurnError = Schema.Struct({ message: boundedText(4096) }).annotate(projection);
const turnFields = {
  id: Identifier,
  items: Schema.Array(AgentMessage).check(Schema.isMaxLength(1)),
  error: Schema.optionalKey(Schema.NullOr(TurnError)),
};
const StartedTurn = Schema.Struct({
  ...turnFields,
  status: Schema.Literal("inProgress"),
  error: Schema.optionalKey(Schema.Null),
  items: Schema.Array(AgentMessage).check(Schema.isMaxLength(0)),
}).annotate(projection);
const TerminalTurn = Schema.Struct({
  ...turnFields,
  status: Schema.Literals(["completed", "interrupted", "failed"]),
})
  .check(
    Schema.makeFilter((turn) =>
      turn.status === "failed"
        ? turn.error !== undefined && turn.error !== null
        : turn.error == null,
    ),
  )
  .annotate(projection);

const InitializeResult = Schema.Struct({
  userAgent: boundedText(4096),
  codexHome: Path,
  platformFamily: Identifier,
  platformOs: Identifier,
}).annotate(projection);
const ThreadStartResult = Schema.Struct({
  thread: Schema.Struct({ id: Identifier }).annotate(projection),
  model: Identifier,
  modelProvider: Identifier,
  cwd: Path,
  approvalPolicy: Schema.Literal("never"),
  approvalsReviewer: Schema.Literal("user"),
  sandbox: Schema.Struct({ type: Schema.Literal("dangerFullAccess") }).annotate({
    parseOptions: { onExcessProperty: "error" },
  }),
  reasoningEffort: Schema.optionalKey(Schema.NullOr(Identifier)),
}).annotate(projection);
const TurnStartResult = Schema.Struct({ turn: StartedTurn }).annotate(projection);

const RpcError = Schema.Struct({
  id: RequestId,
  error: Schema.Struct({
    code: SafeInteger,
    message: boundedText(4096),
  }).annotate(projection),
});
const response = <S extends Schema.Constraint>(result: S) =>
  Schema.Union([Schema.Struct({ id: RequestId, result }), RpcError]);

const CommandItem = Schema.Struct({
  type: Schema.Literal("commandExecution"),
  id: Identifier,
  command: Text,
  status: Schema.Literals(["inProgress", "completed", "failed", "declined"]),
  aggregatedOutput: Schema.optionalKey(Schema.NullOr(Text)),
}).annotate(projection);
const OtherItem = Schema.Struct({
  type: Identifier.check(Schema.makeFilter((type) => type !== "commandExecution")),
}).annotate(projection);

const NotificationSchema = Schema.Union([
  Schema.Struct({
    emittedAtMs: Schema.optionalKey(SafeInteger),
    method: Schema.Literals(["item/started", "item/completed"]),
    params: Schema.Struct({
      threadId: Identifier,
      turnId: Identifier,
      item: Schema.Union([CommandItem, OtherItem]),
    }).annotate(projection),
  }),
  Schema.Struct({
    emittedAtMs: Schema.optionalKey(SafeInteger),
    method: Schema.Literal("item/commandExecution/outputDelta"),
    params: Schema.Struct({
      threadId: Identifier,
      turnId: Identifier,
      itemId: Identifier,
      delta: Text,
    }).annotate(projection),
  }),
  Schema.Struct({
    emittedAtMs: Schema.optionalKey(SafeInteger),
    method: Schema.Literal("item/agentMessage/delta"),
    params: Schema.Struct({
      threadId: Identifier,
      turnId: Identifier,
      itemId: Identifier,
      delta: Text,
    }).annotate(projection),
  }),
  Schema.Struct({
    emittedAtMs: Schema.optionalKey(SafeInteger),
    method: Schema.Literal("turn/started"),
    params: Schema.Struct({ threadId: Identifier, turn: StartedTurn }).annotate(projection),
  }),
  Schema.Struct({
    emittedAtMs: Schema.optionalKey(SafeInteger),
    method: Schema.Literal("turn/completed"),
    params: Schema.Struct({ threadId: Identifier, turn: TerminalTurn }).annotate(projection),
  }),
]);
export type CodexNotification = typeof NotificationSchema.Type;

const ServerRequest = Schema.Struct({
  id: RequestId,
  method: Identifier,
  params: Schema.optionalKey(Schema.Unknown),
  trace: Schema.optionalKey(Schema.Unknown),
});
const UnsupportedResponse = Schema.Struct({
  id: RequestId,
  error: Schema.Struct({
    code: Schema.Literal(-32601),
    message: Schema.Literal("Unsupported server request"),
  }),
});
export type CodexUnsupportedResponse = typeof UnsupportedResponse.Type;

const boundedJsonDecoder = <A>(
  decode: (input: unknown) => Result.Result<A, Schema.SchemaError>,
) => {
  return (line: string) => {
    if (
      line.length > CODEX_MAX_MESSAGE_BYTES ||
      utf8.encode(line).byteLength > CODEX_MAX_MESSAGE_BYTES
    )
      return Result.fail("message_too_large" as const);
    return Result.mapError(decode(line), () => "invalid_message" as const);
  };
};

const strict = { onExcessProperty: "error" } as const;
export const decodeCodexClientMessage = boundedJsonDecoder(
  Schema.decodeUnknownResult(Schema.fromJsonString(CodexClientMessageSchema), strict),
);
export const decodeCodexNotification = boundedJsonDecoder(
  Schema.decodeUnknownResult(Schema.fromJsonString(NotificationSchema), strict),
);
export const decodeCodexInitializeResponse = boundedJsonDecoder(
  Schema.decodeUnknownResult(Schema.fromJsonString(response(InitializeResult)), strict),
);
export const decodeCodexThreadStartResponse = boundedJsonDecoder(
  Schema.decodeUnknownResult(Schema.fromJsonString(response(ThreadStartResult)), strict),
);
export const decodeCodexTurnStartResponse = boundedJsonDecoder(
  Schema.decodeUnknownResult(Schema.fromJsonString(response(TurnStartResult)), strict),
);
export const decodeCodexInterruptResponse = boundedJsonDecoder(
  Schema.decodeUnknownResult(Schema.fromJsonString(response(Empty)), strict),
);
const decodeServerRequest = boundedJsonDecoder(
  Schema.decodeUnknownResult(Schema.fromJsonString(ServerRequest), strict),
);

export const rejectCodexServerRequest = (line: string) =>
  Result.map(
    decodeServerRequest(line),
    (request): CodexUnsupportedResponse => ({
      id: request.id,
      error: { code: -32601, message: "Unsupported server request" },
    }),
  );
