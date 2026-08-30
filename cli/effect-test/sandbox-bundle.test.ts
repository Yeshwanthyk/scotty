import { link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { CliError } from "../src/core.ts";
import {
  createDeterministicTarGz,
  encodeUstarArchive,
  gzipDeterministic,
  validateSandboxArchive,
  type TarMember,
} from "../src/sandbox-archive.ts";
import { itemContentDigest, sha256Bytes } from "../src/sandbox-bundle.ts";
import { walkSandboxTree, type SandboxWalkOptions } from "../src/sandbox-walk.ts";
const encoder = new TextEncoder();

const failed = <A>(result: Result.Result<A, CliError>): CliError => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

const succeeded = <A, E>(result: Result.Result<A, E>): A => {
  assert.ok(Result.isSuccess(result));
  return result.success;
};

const tinyWalk: SandboxWalkOptions = {
  maxFileBytes: 64,
  maxTotalBytes: 128,
  maxFiles: 4,
  includeNodeModules: false,
  skipNodeModulesBin: false,
  executableScripts: true,
};

const withTempDir = <A, E, R>(
  use: (root: string) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.scoped(
    Effect.acquireUseRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "scotty-sandbox-bundle-test-"))),
      use,
      (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
    ),
  );

const writeSkill = (root: string, name: string, body = "# Skill\n"): Promise<void> =>
  writeFile(join(root, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n\n${body}`);

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

describe("sandbox archive validation", () => {
  it("accepts a deterministic round-trip archive", () => {
    const built = createDeterministicTarGz([fileMember("manifest.json", '{"items":[]}\n')]);
    const validated = succeeded(validateSandboxArchive(built.archive));
    assert.strictEqual(validated.digest, built.digest);
  });

  it("validates item identity, paths, digests, and shapes", () => {
    const item = fileItem();
    const valid = itemArchive([item], [fileMember("tools/hello", "hello\n")]);
    assert.deepEqual(succeeded(validateSandboxArchive(valid.archive)).manifest.items, [item]);

    const duplicateItem = itemArchive([item, item], [fileMember("tools/hello", "hello\n")]);
    assert.include(
      failed(validateSandboxArchive(duplicateItem.archive)).message,
      "duplicate bundle",
    );

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
    assert.include(failed(validateSandboxArchive(duplicatePath.archive)).message, "duplicate file");

    const wrongDigest = itemArchive(
      [{ ...item, digest: "0".repeat(64) }],
      [fileMember("tools/hello", "hello\n")],
    );
    assert.include(failed(validateSandboxArchive(wrongDigest.archive)).message, "item digest");

    const wrongShape = fileItem("other");
    const incoherent = itemArchive([wrongShape], [fileMember("tools/other", "hello\n")]);
    assert.include(failed(validateSandboxArchive(incoherent.archive)).message, "does not match");
  });

  it("rejects path escape, absolute paths, duplicates, and type changes", () => {
    assert.strictEqual(
      failed(
        validateSandboxArchive(
          gzipDeterministic(encodeUstarArchive([fileMember("../secret", "x")])),
        ),
      ).code,
      "sandbox_archive_invalid",
    );
    assert.strictEqual(
      failed(
        validateSandboxArchive(
          gzipDeterministic(encodeUstarArchive([fileMember("/etc/passwd", "x")])),
        ),
      ).code,
      "sandbox_archive_invalid",
    );
    assert.strictEqual(
      failed(
        validateSandboxArchive(
          gzipDeterministic(
            encodeUstarArchive([
              fileMember("manifest.json", "{}"),
              fileMember("manifest.json", "{}\n"),
            ]),
          ),
        ),
      ).code,
      "sandbox_archive_invalid",
    );
    assert.strictEqual(
      failed(
        validateSandboxArchive(
          gzipDeterministic(
            encodeUstarArchive([
              fileMember("skills", "not-a-dir"),
              { path: "skills", type: "directory", modeClass: "regular", bytes: new Uint8Array() },
            ]),
          ),
        ),
      ).code,
      "sandbox_archive_invalid",
    );
  });

  it("rejects symlinks, hard links, oversized expansions, and truncated archives", () => {
    const base = encodeUstarArchive([fileMember("manifest.json", "{}")]);
    assert.strictEqual(
      failed(
        validateSandboxArchive(
          gzipDeterministic(
            patchHeader(base, (header) => {
              header[156] = 50;
            }),
          ),
        ),
      ).code,
      "sandbox_archive_invalid",
    );
    assert.strictEqual(
      failed(
        validateSandboxArchive(
          gzipDeterministic(
            patchHeader(base, (header) => {
              header[156] = 49;
            }),
          ),
        ),
      ).code,
      "sandbox_archive_invalid",
    );
    assert.strictEqual(
      failed(
        validateSandboxArchive(
          gzipDeterministic(
            patchHeader(base, (header) => {
              const size = "77777777777";
              for (let index = 0; index < size.length; index++)
                header[124 + index] = size.charCodeAt(index);
            }),
          ),
        ),
      ).code,
      "sandbox_archive_invalid",
    );
    assert.strictEqual(
      failed(validateSandboxArchive(gzipDeterministic(base.subarray(0, 520)))).code,
      "sandbox_archive_invalid",
    );
  });

  it("rejects manifest disagreement and digest disagreement", () => {
    assert.strictEqual(
      failed(
        validateSandboxArchive(
          gzipDeterministic(
            encodeUstarArchive([
              fileMember("manifest.json", '{"items":"invalid"}\n'),
              fileMember("skills/extra/SKILL.md", "stowaway"),
            ]),
          ),
        ),
      ).code,
      "sandbox_archive_invalid",
    );
    assert.strictEqual(
      failed(
        validateSandboxArchive(
          gzipDeterministic(
            encodeUstarArchive([
              fileMember(
                "manifest.json",
                `${JSON.stringify(
                  {
                    items: [
                      {
                        kind: "skill",
                        name: "release-notes",
                        shape: "directory",
                        digest: "0".repeat(64),
                        files: [
                          {
                            path: "SKILL.md",
                            size: 4,
                            modeClass: "regular",
                            digest: "0".repeat(64),
                          },
                        ],
                      },
                    ],
                  },
                  null,
                  2,
                )}\n`,
              ),
              fileMember("skills/release-notes/SKILL.md", "body"),
            ]),
          ),
        ),
      ).code,
      "sandbox_archive_invalid",
    );
  });
});

describe("sandbox source walk", () => {
  it.effect("rejects symlinks, hard links, and oversized files", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeSkill(root, "release-notes"));
        yield* Effect.promise(() => symlink(join(root, "SKILL.md"), join(root, "link.md")));
        const linked = yield* Effect.result(walkSandboxTree(root, tinyWalk));
        assert.strictEqual(failed(linked).code, "sandbox_source_invalid");

        yield* Effect.promise(() => rm(join(root, "link.md")));
        yield* Effect.promise(() => writeFile(join(root, "copy.md"), "same"));
        yield* Effect.promise(() => link(join(root, "copy.md"), join(root, "hard.md")));
        const hard = yield* Effect.result(walkSandboxTree(root, tinyWalk));
        assert.strictEqual(failed(hard).code, "sandbox_source_invalid");

        yield* Effect.promise(() => rm(join(root, "hard.md")));
        yield* Effect.promise(() => rm(join(root, "copy.md")));
        yield* Effect.promise(() => writeFile(join(root, "huge.bin"), "x".repeat(65)));
        const huge = yield* Effect.result(walkSandboxTree(root, tinyWalk));
        assert.strictEqual(failed(huge).code, "sandbox_bundle_too_large");
      }),
    ),
  );
});
