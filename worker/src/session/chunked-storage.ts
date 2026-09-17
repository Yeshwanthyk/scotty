import { Data, Result, Schema } from "effect";

const CHUNK_CHARACTERS = 24_000;
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_CHUNKS = Math.ceil(MAX_BYTES / CHUNK_CHARACTERS);
const manifestTag = "ScottyChunkedJsonV1";
const ManifestTag = Schema.Struct({ _tag: Schema.Literal(manifestTag) });
const Manifest = Schema.Struct({
  _tag: Schema.Literal(manifestTag),
  chunks: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_CHUNKS })),
  characters: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_BYTES })),
});
const decodeTag = Schema.decodeUnknownResult(ManifestTag);
const decodeManifest = Schema.decodeUnknownResult(Manifest);
const decodeString = Schema.decodeUnknownResult(Schema.String);
const decodeJson = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Unknown));

export class ChunkedStorageFailure extends Data.TaggedError("ChunkedStorageFailure")<{
  readonly reason: "invalid" | "too-large";
}> {}

interface ChunkStorage {
  readonly get: (key: string) => Promise<unknown>;
  readonly put: (key: string, value: unknown) => Promise<void>;
  readonly delete: (key: string) => Promise<unknown>;
}

const chunkKey = (key: string, index: number): string => `${key}:chunk:${index}`;
const failure = (reason: "invalid" | "too-large"): Promise<never> =>
  // oxlint-disable-next-line scotty/no-promise-reject -- boundary: the native storage transaction must abort on invalid or oversized persisted data
  Promise.reject(new ChunkedStorageFailure({ reason }));

const manifestFor = (value: unknown) => {
  if (Result.isFailure(decodeTag(value))) return undefined;
  return decodeManifest(value);
};

export const readChunkedJson = async (storage: ChunkStorage, key: string): Promise<unknown> => {
  const value = await storage.get(key);
  const manifest = manifestFor(value);
  if (manifest === undefined) return value;
  if (Result.isFailure(manifest)) return failure("invalid");
  const parts: string[] = [];
  for (let index = 0; index < manifest.success.chunks; index++) {
    const part = decodeString(await storage.get(chunkKey(key, index)));
    if (Result.isFailure(part) || part.success.length > CHUNK_CHARACTERS) return failure("invalid");
    parts.push(part.success);
  }
  const json = parts.join("");
  if (
    json.length !== manifest.success.characters ||
    new TextEncoder().encode(json).length > MAX_BYTES
  )
    return failure("invalid");
  const decoded = decodeJson(json);
  return Result.isFailure(decoded) ? failure("invalid") : decoded.success;
};

// All mutations and reads must share the caller's native storage transaction.
export const deleteChunkedJson = async (storage: ChunkStorage, key: string): Promise<void> => {
  const manifest = manifestFor(await storage.get(key));
  if (manifest !== undefined) {
    if (Result.isFailure(manifest)) return failure("invalid");
    for (let index = 0; index < manifest.success.chunks; index++)
      await storage.delete(chunkKey(key, index));
  }
  await storage.delete(key);
};

export const writeChunkedJson = async (
  storage: ChunkStorage,
  key: string,
  value: unknown,
): Promise<void> => {
  const encoded = encodeJson(value);
  if (Result.isFailure(encoded)) return failure("invalid");
  const json = encoded.success;
  if (new TextEncoder().encode(json).length > MAX_BYTES) return failure("too-large");
  await deleteChunkedJson(storage, key);
  if (json.length <= CHUNK_CHARACTERS) {
    await storage.put(key, value);
    return;
  }
  const chunks = Math.ceil(json.length / CHUNK_CHARACTERS);
  for (let index = 0; index < chunks; index++)
    await storage.put(
      chunkKey(key, index),
      json.slice(index * CHUNK_CHARACTERS, (index + 1) * CHUNK_CHARACTERS),
    );
  await storage.put(key, { _tag: manifestTag, chunks, characters: json.length });
};
