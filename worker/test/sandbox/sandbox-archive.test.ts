import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import {
  createDeterministicTarGz,
  encodeUstarArchive,
  gzipDeterministic,
  type TarMember,
} from "../../../cli/src/sandbox-archive";
import {
  parseSandboxTar,
  SANDBOX_MAX_FILE_BYTES,
  SANDBOX_MAX_UNCOMPRESSED_BYTES,
  validateSandboxArchive,
} from "../../src/sandbox/archive";
import { sha256BytesHex } from "../../src/shared/digest";
import { itemContentDigest, sha256Bytes } from "../../../cli/src/sandbox-bundle";

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

const directoryMember = (path: string): TarMember => ({
  path,
  type: "directory",
  modeClass: "regular",
  bytes: new Uint8Array(),
});

const fileItem = (filePath = "hello") => {
  const bytes = encoder.encode("hello\n");
  const file = {
    path: filePath,
    size: bytes.byteLength,
    modeClass: "regular" as const,
    digest: sha256Bytes(bytes),
  };
  return {
    kind: "tool" as const,
    name: "hello",
    shape: "file" as const,
    digest: itemContentDigest([file]),
    files: [file],
  };
};

const itemArchive = (items: ReadonlyArray<unknown>, members: ReadonlyArray<TarMember>) =>
  createDeterministicTarGz([
    fileMember("manifest.json", `${JSON.stringify({ items })}\n`),
    ...members,
  ]);
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
  it("accepts the shared prepared-package file limit and rejects larger files", () => {
    const atLimit = parseSandboxTar(
      encodeUstarArchive([
        fileMember("manifest.json", "{}"),
        {
          path: "pi-packages/example/large.bin",
          type: "file",
          modeClass: "regular",
          bytes: new Uint8Array(SANDBOX_MAX_FILE_BYTES),
        },
      ]),
    );
    assert.ok(Result.isSuccess(atLimit));

    const overLimit = parseSandboxTar(
      encodeUstarArchive([
        fileMember("manifest.json", "{}"),
        {
          path: "pi-packages/example/large.bin",
          type: "file",
          modeClass: "regular",
          bytes: new Uint8Array(SANDBOX_MAX_FILE_BYTES + 1),
        },
      ]),
    );
    assert.ok(Result.isFailure(overLimit));
  });

  it.effect("accepts a deterministic round-trip archive", () =>
    Effect.gen(function* () {
      const built = createDeterministicTarGz([fileMember("manifest.json", '{"items":[]}\n')]);
      const validated = yield* validateSandboxArchive(built.archive, built.digest);
      assert.strictEqual(validated.digest, built.digest);
    }),
  );

  it.effect("validates item identity, paths, digests, and shapes", () =>
    Effect.gen(function* () {
      const item = fileItem();
      const valid = itemArchive([item], [fileMember("tools/hello", "hello\n")]);
      const validated = yield* validateSandboxArchive(valid.archive, valid.digest);
      assert.deepEqual(validated.manifest.items, [item]);

      const duplicateItem = itemArchive([item, item], [fileMember("tools/hello", "hello\n")]);
      const duplicateResult = yield* Effect.result(
        validateSandboxArchive(duplicateItem.archive, duplicateItem.digest),
      );
      assert.ok(Result.isFailure(duplicateResult));
      assert.match(duplicateResult.failure.message, /duplicate bundle/u);

      const record = item.files[0]!;
      const duplicatePathItem = {
        ...item,
        shape: "directory" as const,
        files: [record, record],
        digest: itemContentDigest([record, record]),
      };
      const duplicatePath = itemArchive(
        [duplicatePathItem],
        [directoryMember("tools/hello"), fileMember("tools/hello/hello", "hello\n")],
      );
      const duplicatePathResult = yield* Effect.result(
        validateSandboxArchive(duplicatePath.archive, duplicatePath.digest),
      );
      assert.ok(Result.isFailure(duplicatePathResult));
      assert.match(duplicatePathResult.failure.message, /duplicate file/u);

      const wrongDigest = itemArchive(
        [{ ...item, digest: "0".repeat(64) }],
        [fileMember("tools/hello", "hello\n")],
      );
      const wrongDigestResult = yield* Effect.result(
        validateSandboxArchive(wrongDigest.archive, wrongDigest.digest),
      );
      assert.ok(Result.isFailure(wrongDigestResult));
      assert.match(wrongDigestResult.failure.message, /item digest/u);

      const wrongShape = fileItem("other");
      const incoherent = itemArchive([wrongShape], [fileMember("tools/other", "hello\n")]);
      const incoherentResult = yield* Effect.result(
        validateSandboxArchive(incoherent.archive, incoherent.digest),
      );
      assert.ok(Result.isFailure(incoherentResult));
      assert.match(incoherentResult.failure.message, /does not match/u);
    }),
  );

  it.effect("rejects digest mismatch and invalid gzip", () =>
    Effect.gen(function* () {
      const built = createDeterministicTarGz([fileMember("manifest.json", '{"items":[]}\n')]);
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
        encodeUstarArchive([fileMember("manifest.json", '{"items":[]}\n')]),
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
