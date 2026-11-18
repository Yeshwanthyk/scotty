import { Effect, Schema, SchemaTransformation } from "effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";

const tokenPattern = /^Bearer ([A-Za-z0-9_-]{43})$/;
export const egressBearer = Schema.String.check(Schema.isPattern(tokenPattern)).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (header) => header.replace(tokenPattern, "$1"),
      encode: (token) => `Bearer ${token}`,
    }),
  ),
);

export const newEgressToken: () => string = () =>
  Base64Url.encode(crypto.getRandomValues(new Uint8Array(32)));

export const egressTokenHash = (token: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).pipe(
    Effect.map((digest) => Hex.encode(new Uint8Array(digest))),
  );
