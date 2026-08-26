import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import { CliError } from "../src/core.ts";
import {
  createDeterministicTarGz,
  encodeUstarArchive,
  gzipDeterministic,
  validateSandboxArchive,
  type TarMember,
} from "../src/sandbox-archive.ts";
import { emptySandboxConfig } from "../src/sandbox-config.ts";
import { itemContentDigest, sha256Bytes } from "../src/sandbox-bundle.ts";
import { buildSandboxBundle } from "../src/sandbox-prepare.ts";
import { walkSandboxTree, type SandboxWalkOptions } from "../src/sandbox-walk.ts";
import { ProcessRunner } from "../src/services.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
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

const v2FileItem = (filePath = "hello") => {
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

const v2Archive = (items: ReadonlyArray<unknown>, members: ReadonlyArray<TarMember>) =>
  createDeterministicTarGz([
    fileMember("manifest.json", `${JSON.stringify({ schemaVersion: 2, items })}\n`),
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
    const built = createDeterministicTarGz([
      fileMember("manifest.json", '{"schemaVersion":1,"skills":[],"piPackages":[]}\n'),
    ]);
    const validated = succeeded(validateSandboxArchive(built.archive));
    assert.strictEqual(validated.digest, built.digest);
  });

  it("validates v2 item identity, paths, digests, and shapes", () => {
    const item = v2FileItem();
    const valid = v2Archive([item], [fileMember("tools/hello", "hello\n")]);
    assert.strictEqual(succeeded(validateSandboxArchive(valid.archive)).manifest.schemaVersion, 2);

    const duplicateItem = v2Archive([item, item], [fileMember("tools/hello", "hello\n")]);
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
    const duplicatePath = v2Archive(
      [duplicatePathItem],
      [directoryMember("tools/hello"), fileMember("tools/hello/hello", "hello\n")],
    );
    assert.include(failed(validateSandboxArchive(duplicatePath.archive)).message, "duplicate file");

    const wrongDigest = v2Archive(
      [{ ...item, digest: "0".repeat(64) }],
      [fileMember("tools/hello", "hello\n")],
    );
    assert.include(failed(validateSandboxArchive(wrongDigest.archive)).message, "item digest");

    const wrongShape = v2FileItem("other");
    const incoherent = v2Archive([wrongShape], [fileMember("tools/other", "hello\n")]);
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
              fileMember("manifest.json", '{"schemaVersion":1,"skills":[],"piPackages":[]}\n'),
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
                    schemaVersion: 1,
                    skills: [
                      {
                        name: "release-notes",
                        digest: "0".repeat(64),
                        hasExecutableContent: false,
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
                    piPackages: [],
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

describe("sandbox bundle preparation", () => {
  it.effect("produces a stable digest for the empty configuration", () =>
    Effect.gen(function* () {
      const left = yield* buildSandboxBundle(emptySandboxConfig());
      const right = yield* buildSandboxBundle(emptySandboxConfig());
      assert.strictEqual(left.digest, right.digest);
      assert.strictEqual(left.fileCount, 0);
      assert.strictEqual(succeeded(validateSandboxArchive(left.archive)).digest, left.digest);
    }),
  );

  it.effect(
    "produces identical digests for identical Skill contents and changes when mutated",
    () =>
      withTempDir((root) =>
        Effect.gen(function* () {
          const first = join(root, "one");
          const second = join(root, "two");
          yield* Effect.promise(() => mkdir(first));
          yield* Effect.promise(() => mkdir(second));
          yield* Effect.promise(() => writeSkill(first, "release-notes", "# Same\n"));
          yield* Effect.promise(() => writeSkill(second, "release-notes", "# Same\n"));
          yield* Effect.promise(() => writeFile(join(first, ".DS_Store"), "junk"));
          const left = yield* buildSandboxBundle({
            ...emptySandboxConfig(),
            skills: [{ name: "release-notes", path: first }],
          });
          const right = yield* buildSandboxBundle({
            ...emptySandboxConfig(),
            skills: [{ name: "release-notes", path: second }],
          });
          assert.strictEqual(left.digest, right.digest);
          assert.strictEqual(left.fileCount, 1);
          assert.strictEqual(succeeded(validateSandboxArchive(left.archive)).digest, left.digest);

          yield* Effect.promise(() => writeSkill(second, "release-notes", "# Different\n"));
          const mutated = yield* buildSandboxBundle({
            ...emptySandboxConfig(),
            skills: [{ name: "release-notes", path: second }],
          });
          assert.notStrictEqual(mutated.digest, left.digest);
        }),
      ),
  );

  it.effect("does not modify the Skill source directory", () =>
    withTempDir((root) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => writeSkill(root, "release-notes", "# Original\n"));
        const skillMd = join(root, "SKILL.md");
        const before = yield* Effect.promise(() => readFile(skillMd, "utf8"));
        const stamped = new Date("2024-01-01T00:00:00Z");
        yield* Effect.promise(() => utimes(skillMd, stamped, stamped));
        const beforeStat = yield* Effect.promise(() => stat(skillMd));
        yield* buildSandboxBundle({
          ...emptySandboxConfig(),
          skills: [{ name: "release-notes", path: root }],
        });
        const after = yield* Effect.promise(() => readFile(skillMd, "utf8"));
        const afterStat = yield* Effect.promise(() => stat(skillMd));
        assert.strictEqual(after, before);
        assert.strictEqual(afterStat.mtimeMs, beforeStat.mtimeMs);
      }),
    ),
  );

  it.effect("checks out a Pi package without credentials in argv or the manifest", () => {
    const captured: Array<{
      readonly command: ReadonlyArray<string>;
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string | undefined>>;
    }> = [];
    const layer = Layer.succeed(ProcessRunner)({
      run: (command, options) =>
        Effect.gen(function* () {
          captured.push({ command: [...command], cwd: options?.cwd, env: options?.env });
          if (command[0] === "git" && command[1] === "checkout" && options?.cwd !== undefined) {
            yield* Effect.promise(async () => {
              await writeFile(
                join(options.cwd, "package.json"),
                JSON.stringify({
                  name: "pi-review-tools",
                  pi: { extensions: ["./index.ts"] },
                }),
              );
              await writeFile(join(options.cwd, "index.ts"), "export {}\n");
            });
          }
          if (command[0] === "git" && command[1] === "rev-parse")
            return { exitCode: 0, stdout: `${COMMIT}\n`, stderr: "" };
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
    });
    return Effect.gen(function* () {
      const built = yield* buildSandboxBundle({
        ...emptySandboxConfig(),
        piPackages: [
          {
            name: "pi-review-tools",
            repository: "https://github.com/acme/pi-review-tools.git",
            commit: COMMIT,
            requestedRef: "v1.2.0",
          },
        ],
      });
      const argv = captured.map((entry) => entry.command.join(" ")).join("\n");
      const env = JSON.stringify(captured.map((entry) => entry.env));
      assert.notInclude(argv, "token");
      assert.notInclude(argv, "user:pass");
      assert.notInclude(env, "token");
      assert.include(
        argv,
        "git fetch --quiet --depth 1 --no-tags https://github.com/acme/pi-review-tools.git",
      );
      assert.notInclude(argv, "npm ci");
      assert.strictEqual(built.manifest.piPackages.length, 1);
      assert.strictEqual(
        built.manifest.piPackages[0].repository,
        "https://github.com/acme/pi-review-tools.git",
      );
      assert.strictEqual(built.manifest.piPackages[0].commit, COMMIT);
      assert.strictEqual(succeeded(validateSandboxArchive(built.archive)).digest, built.digest);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "requires a lockfile and npm ci without scripts when runtime dependencies exist",
    () => {
      const captured: string[] = [];
      const layer = Layer.succeed(ProcessRunner)({
        run: (command, options) =>
          Effect.gen(function* () {
            captured.push(command.join(" "));
            if (command[0] === "git" && command[1] === "checkout" && options?.cwd !== undefined) {
              yield* Effect.promise(async () => {
                await writeFile(
                  join(options.cwd, "package.json"),
                  JSON.stringify({
                    name: "pi-review-tools",
                    dependencies: { leftpad: "1.0.0" },
                    pi: { extensions: ["./index.ts"] },
                  }),
                );
                await writeFile(join(options.cwd, "index.ts"), "export {}\n");
              });
            }
            if (command[0] === "git" && command[1] === "rev-parse")
              return { exitCode: 0, stdout: `${COMMIT}\n`, stderr: "" };
            return { exitCode: 0, stdout: "", stderr: "" };
          }),
      });
      return Effect.gen(function* () {
        const missingLock = yield* Effect.result(
          buildSandboxBundle({
            ...emptySandboxConfig(),
            piPackages: [
              {
                name: "pi-review-tools",
                repository: "https://github.com/acme/pi-review-tools.git",
                commit: COMMIT,
                requestedRef: "v1.2.0",
              },
            ],
          }).pipe(Effect.provide(layer)),
        );
        assert.strictEqual(failed(missingLock).code, "sandbox_package_unsupported");
        assert.notInclude(captured.join("\n"), "npm ci");
      });
    },
  );
});
