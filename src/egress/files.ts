import type * as Cloudflare from "alchemy/Cloudflare";
import { Effect, Exit, Option, Schema, SchemaTransformation } from "effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import type SessionObject from "../session/object.js";

// scotty-attach uploads: one of these types, at most 25 MB, name and caption URI-encoded.
const FileType = Schema.Literals([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "video/webm",
  "video/mp4",
]);
const FileSize = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: 25 * 1024 * 1024 }),
);
const encoded = (max: number) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max)),
      SchemaTransformation.stringFromUriComponent,
    ),
  );
const FileLabel = Schema.Struct({
  "x-scotty-name": encoded(255),
  "x-scotty-caption": Schema.optionalKey(encoded(2000)),
});

/**
 * `PUT files.internal`: one file for the session. The bytes reach R2 before the Session DO
 * records the file, so no event names missing bytes.
 */
export const attach = (
  request: HttpServerRequest.HttpServerRequest,
  session: string,
  sessions: Cloudflare.DurableObject<SessionObject>,
  bucket: Cloudflare.R2.ReadWriteBucketClient,
) =>
  Effect.gen(function* () {
    const reply = (status: number, text: string) =>
      HttpServerResponse.text(`${text}\n`, { status });
    if (request.method !== "PUT") return reply(405, "Use PUT");
    const type = Schema.decodeUnknownOption(FileType)(request.headers["content-type"]);
    if (Option.isNone(type)) return reply(415, "Type must be png, jpeg, webp, gif, webm or mp4");
    const size = Schema.decodeUnknownOption(FileSize)(request.headers["content-length"]);
    if (Option.isNone(size)) return reply(413, "File must be 1 byte to 25 MB");
    const label = Schema.decodeUnknownOption(FileLabel)(request.headers);
    if (Option.isNone(label)) return reply(400, "Bad file name or caption");
    const file = crypto.randomUUID().replaceAll("-", "");
    const body = (yield* HttpServerRequest.toWeb(request)).body;
    const stored = yield* Effect.exit(
      bucket.put(`files/${session}/${file}`, body, {
        httpMetadata: { contentType: type.value },
      }),
    );
    if (Exit.isFailure(stored)) return reply(502, "Could not store the file");
    const name = label.value["x-scotty-name"];
    const caption = label.value["x-scotty-caption"];
    const recorded = yield* Effect.exit(
      sessions.getByName(session).attach({
        file,
        name,
        type: type.value,
        size: size.value,
        ...(caption === undefined ? {} : { caption }),
      }),
    );
    if (Exit.isFailure(recorded)) return reply(502, "Could not record the file");
    return reply(200, `Attached: ${name}`);
  });
