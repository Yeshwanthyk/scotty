import { createHmac, timingSafeEqual } from "node:crypto";
import { Effect, FileSystem, Option, Schema } from "effect";
import { takeEnv } from "./runtime.js";

// A place outside Cloudflare gives the container k on its first boot; it is kept on the disk, so
// a supervisor started again (docker start) checks the next gen's dial with what it already has.
// On Cloudflare there is no k, and the supervisor is reachable only from its Session DO.
const keyFile = "/var/lib/scotty/key";
const hexKey = /^[0-9a-f]{64}$/;

export class KeyError extends Schema.TaggedError<KeyError>()("KeyError", {
  message: Schema.String,
}) {}

export const loadKey = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const given = takeEnv("SCOTTY_SUPERVISOR_KEY");
  const stored = yield* fs.readFileString(keyFile).pipe(Effect.option);
  const key = Option.isSome(stored) ? stored.value.trim() : given;
  if (key === "") return Option.none<Uint8Array>();
  if (!hexKey.test(key)) return yield* new KeyError({ message: "invalid supervisor key" });
  if (Option.isNone(stored))
    yield* fs
      .writeFileString(keyFile, key, { mode: 0o600 })
      .pipe(Effect.mapError(() => new KeyError({ message: "could not store supervisor key" })));
  return Option.some(Uint8Array.from(Buffer.from(key, "hex")));
});

// The caller proves it knows k for this gen: hex HMAC-SHA256(k, String(gen)).
export const authorized = (key: Uint8Array, gen: number, header: string | null): boolean => {
  if (header === null || !hexKey.test(header)) return false;
  const expected = createHmac("sha256", key).update(String(gen)).digest();
  return timingSafeEqual(expected, Buffer.from(header, "hex"));
};
