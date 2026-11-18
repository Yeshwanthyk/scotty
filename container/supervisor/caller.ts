import { createHmac, timingSafeEqual } from "node:crypto";
import { Effect, FileSystem, Option, Schema } from "effect";
import { keepsDisk } from "./place.js";
import { takeEnv } from "./runtime.js";

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
  if (key === "" && keepsDisk())
    return yield* new KeyError({ message: "no supervisor key for a session that keeps its disk" });
  if (key === "") return Option.none<Uint8Array>();
  if (!hexKey.test(key)) return yield* new KeyError({ message: "invalid supervisor key" });
  if (Option.isNone(stored))
    yield* fs
      .writeFileString(keyFile, key, { mode: 0o600 })
      .pipe(Effect.mapError(() => new KeyError({ message: "could not store supervisor key" })));
  return Option.some(Uint8Array.from(Buffer.from(key, "hex")));
});

export const authorized: (key: Uint8Array, gen: number, header: string | null) => boolean = (
  key,
  gen,
  header,
) => {
  if (header === null || !hexKey.test(header)) return false;
  const expected = createHmac("sha256", key).update(String(gen)).digest();
  return timingSafeEqual(expected, Buffer.from(header, "hex"));
};
