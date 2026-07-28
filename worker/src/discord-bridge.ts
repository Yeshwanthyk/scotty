import { Result, Schema } from "effect";

const PicanSessionSchema = Schema.Struct({
  ID: Schema.NonEmptyString,
  nativeId: Schema.NonEmptyString,
});

const PicanSessionsSchema = Schema.Struct({
  sessions: Schema.Array(PicanSessionSchema),
});

const PicanMessageContentSchema = Schema.Union([
  Schema.String,
  Schema.Array(
    Schema.Struct({
      type: Schema.String,
      text: Schema.optionalKey(Schema.String),
    }),
  ),
]);

const PicanEntrySchema = Schema.Struct({
  id: Schema.NonEmptyString,
  type: Schema.String,
  message: Schema.optionalKey(
    Schema.Struct({
      role: Schema.String,
      content: PicanMessageContentSchema,
    }),
  ),
});

const PicanSnapshotSchema = Schema.Struct({
  entries: Schema.Array(PicanEntrySchema),
});

const PicanWorkerStatusSchema = Schema.Struct({
  state: Schema.Literals(["running", "idle", "error"]),
});

const decodePicanSessions = Schema.decodeUnknownResult(Schema.fromJsonString(PicanSessionsSchema));
const decodePicanSnapshot = Schema.decodeUnknownResult(Schema.fromJsonString(PicanSnapshotSchema));
const decodePicanWorkerStatus = Schema.decodeUnknownResult(
  Schema.fromJsonString(PicanWorkerStatusSchema),
);

export interface DiscordTranscriptMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
}

export function resolvePicanSessionId(json: string, nativeId: string): string | undefined {
  const decoded = decodePicanSessions(json);
  if (Result.isFailure(decoded)) return undefined;
  return decoded.success.sessions.find((session) => session.nativeId === nativeId)?.ID;
}

export function decodeDiscordTranscript(
  json: string,
): ReadonlyArray<DiscordTranscriptMessage> | undefined {
  const decoded = decodePicanSnapshot(json);
  if (Result.isFailure(decoded)) return undefined;
  return decoded.success.entries.flatMap((entry) => {
    const message = entry.message;
    if (
      entry.type !== "message" ||
      !message ||
      (message.role !== "user" && message.role !== "assistant")
    )
      return [];
    const role = message.role;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content
            .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
            .join("\n");
    return text.trim() ? [{ id: entry.id, role, text }] : [];
  });
}

export function decodePicanRunning(json: string): boolean | undefined {
  const decoded = decodePicanWorkerStatus(json);
  return Result.isSuccess(decoded) ? decoded.success.state === "running" : undefined;
}
