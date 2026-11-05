import { Effect, Encoding, Schema } from "effect";

// An egress token is 32 random bytes in base64url: it names nothing, and only its hash is kept.
export const EgressToken = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/));

export const newEgressToken = (): string =>
  Encoding.encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));

export const egressTokenHash = (token: string) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).pipe(
    Effect.map((digest) => Encoding.encodeHex(new Uint8Array(digest))),
  );
