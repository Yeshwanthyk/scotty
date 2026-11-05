import { Effect, Encoding, Schema, SchemaTransformation } from "effect";

// An egress token is 32 random bytes in base64url: it names nothing, and only its hash is kept.
const tokenPattern = /^Bearer ([A-Za-z0-9_-]{43})$/;
// `Authorization: Bearer <token>`, decoded to the token; Workers logs redact this header.
export const egressBearer = Schema.String.check(Schema.isPattern(tokenPattern)).pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transform({
      decode: (header) => header.replace(tokenPattern, "$1"),
      encode: (token) => `Bearer ${token}`,
    }),
  ),
);

export const newEgressToken = (): string =>
  Encoding.encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));

export const egressTokenHash = (token: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).pipe(
    Effect.map((digest) => Encoding.encodeHex(new Uint8Array(digest))),
  );
