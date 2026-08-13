import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import {
  createDeterministicTarGz,
  encodeUstarArchive,
  gzipDeterministic,
  type TarMember,
} from "../../cli/src/sandbox-archive";
import { validateSandboxArchive, SANDBOX_MAX_UNCOMPRESSED_BYTES } from "../src/sandbox-archive";
import { sha256BytesHex } from "../src/digest";

const encoder = new TextEncoder();

const fileMember = (
  path: string,
  content: string,
  modeClass: TarMember["modeClass"] = "regular",
): TarMember => ({
  path,
  type: "file",
  modeClass,
  bytes: encoder.encode(content),
});

const recomputeChecksum = (header: Uint8Array): void => {
  for (let index = 148; index < 156; index++) header[index] = 32;
  let sum = 0;
  for (const byte of header) sum += byte;
  const text = sum.toString(8).padStart(6, "0");
  for (let index = 0; index < 6; index++) header[148 + index] = text.charCodeAt(index);
  header[154] = 0;
  header[155] = 32;
};

const patchHeader = (tar: Uint8Array, patch: (header: Uint8Array) => void): Uint8Array => {
  const copy = tar.slice();
  const header = copy.subarray(0, 512);
  patch(header);
  recomputeChecksum(header);
  return copy;
};

describe("worker sandbox archive validation", () => {
  it.effect("accepts a deterministic round-trip archive", () =>
    Effect.gen(function* () {
      const built = createDeterministicTarGz([
        fileMember("manifest.json", '{"schemaVersion":1,"skills":[],"piPackages":[]}\n'),
      ]);
      const validated = yield* validateSandboxArchive(built.archive, built.digest);
      assert.strictEqual(validated.digest, built.digest);
    }),
  );

  it.effect("rejects digest mismatch and invalid gzip", () =>
    Effect.gen(function* () {
      const built = createDeterministicTarGz([
        fileMember("manifest.json", '{"schemaVersion":1,"skills":[],"piPackages":[]}\n'),
      ]);
      const mismatch = yield* Effect.result(validateSandboxArchive(built.archive, "b".repeat(64)));
      assert.ok(Result.isFailure(mismatch));
      const invalid = yield* Effect.result(
        validateSandboxArchive(Uint8Array.from([1, 2, 3]), "a".repeat(64)),
      );
      assert.ok(Result.isFailure(invalid));
    }),
  );

  it.effect("rejects unsupported tar member types", () =>
    Effect.gen(function* () {
      const tar = patchHeader(
        encodeUstarArchive([
          fileMember("manifest.json", '{"schemaVersion":1,"skills":[],"piPackages":[]}\n'),
        ]),
        (header) => {
          header[156] = 50;
        },
      );
      const badArchive = gzipDeterministic(tar);
      const badDigest = yield* Effect.tryPromise({
        try: () => sha256BytesHex(tar),
        catch: () => new Error("hash failed"),
      });
      const result = yield* Effect.result(validateSandboxArchive(badArchive, badDigest));
      assert.ok(Result.isFailure(result));
      assert.match(result.failure.message, /unsupported member type/u);
    }),
  );

  it.effect("rejects gzip that expands past the uncompressed size limit", () =>
    Effect.gen(function* () {
      const tar = new Uint8Array(SANDBOX_MAX_UNCOMPRESSED_BYTES + 1);
      const bomb = gzipDeterministic(tar);
      const digest = yield* Effect.tryPromise({
        try: () => sha256BytesHex(tar),
        catch: () => new Error("hash failed"),
      });
      const result = yield* Effect.result(validateSandboxArchive(bomb, digest));
      assert.ok(Result.isFailure(result));
      assert.match(result.failure.message, /uncompressed size limit/u);
    }),
  );
});
