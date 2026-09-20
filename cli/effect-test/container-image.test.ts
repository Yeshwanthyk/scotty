import { assert, describe, it } from "@effect/vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Option, Result } from "effect";
import {
  ContainerImageError,
  decodeReleasedContainerImage,
  fetchReleasedContainerImage,
  installCrane,
  parseContainerImageSource,
  runCraneProcess,
  selectCraneAsset,
  transferContainerImage,
  type CraneAsset,
  type RunCrane,
} from "../src/container-image.ts";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const sourceReference = `index.docker.io/example/scotty@${digest("a")}`;
const configDigest = digest("b");
const layerDigest = digest("c");
const manifest = JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  config: {
    mediaType: "application/vnd.oci.image.config.v1+json",
    size: 10,
    digest: configDigest,
  },
  layers: [
    {
      mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
      size: 20,
      digest: layerDigest,
    },
  ],
});
const configuration = JSON.stringify({ os: "linux", architecture: "amd64" });

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const value = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Buffer.from(value).toString("hex");
};

const withTemporaryDirectory = <A, E>(use: (root: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "scotty-container-image-test-"))),
    use,
    (root) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  );

describe("container image selection", () => {
  it("accepts only fully qualified digest-pinned references", () => {
    assert.deepStrictEqual(parseContainerImageSource(sourceReference), {
      reference: sourceReference,
      digest: digest("a"),
    });
    assert.throws(() => parseContainerImageSource("example/scotty:latest"));
    assert.throws(() => parseContainerImageSource(`example/scotty@${digest("a")}`));
  });

  it("validates the released image identity and platform", () => {
    const source = decodeReleasedContainerImage(
      JSON.stringify({
        version: 1,
        releaseTag: "v1.2.3",
        image: {
          repository: "index.docker.io/example/scotty",
          digest: digest("a"),
          reference: sourceReference,
          platform: "linux/amd64",
          configDigest,
          revision: "d".repeat(40),
        },
      }),
      "v1.2.3",
    );
    assert.strictEqual(source.expectedConfigDigest, configDigest);
    assert.throws(() =>
      decodeReleasedContainerImage(
        JSON.stringify({
          version: 1,
          releaseTag: "v1.2.3",
          image: {
            repository: "index.docker.io/example/scotty",
            digest: digest("a"),
            reference: sourceReference,
            platform: "linux/arm64",
            configDigest,
            revision: "d".repeat(40),
          },
        }),
        "v1.2.3",
      ),
    );
    assert.throws(() =>
      decodeReleasedContainerImage(
        JSON.stringify({
          version: 1,
          releaseTag: "v1.2.3",
          image: {
            repository: "index.docker.io/example/other",
            digest: digest("f"),
            reference: sourceReference,
            platform: "linux/amd64",
            configDigest,
            revision: "d".repeat(40),
          },
        }),
        "v1.2.3",
      ),
    );
  });

  it.effect("reports malformed release metadata as a typed failure", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        fetchReleasedContainerImage("1.2.3", async () => Response.json({})),
      );
      assert.instanceOf(Option.getOrUndefined(Result.getFailure(result)), ContainerImageError);
    }),
  );

  it("has pinned helpers for every released CLI host target", () => {
    for (const [platform, architecture] of [
      ["darwin", "arm64"],
      ["darwin", "x64"],
      ["linux", "arm64"],
      ["linux", "x64"],
    ] as const) {
      const asset = selectCraneAsset(platform, architecture);
      assert.match(asset.archiveSha256, /^[0-9a-f]{64}$/u);
      assert.match(asset.executableSha256, /^[0-9a-f]{64}$/u);
      assert.isAbove(asset.executableBytes, 1_000_000);
    }
    assert.throws(() => selectCraneAsset("win32", "x64"));
  });
});

describe("pinned Crane helper", () => {
  it.effect("installs atomically, enforces mode, and reuses only the verified cache", () =>
    withTemporaryDirectory((root) =>
      Effect.gen(function* () {
        const executable = new TextEncoder().encode("verified-crane-fixture");
        const archive = new TextEncoder().encode("verified-archive-fixture");
        const asset: CraneAsset = {
          archiveName: "fixture.tar.gz",
          archiveSha256: yield* Effect.promise(() => sha256(archive)),
          executableSha256: yield* Effect.promise(() => sha256(executable)),
          executableBytes: executable.byteLength,
        };
        let downloads = 0;
        const fetchFixture = async (): Promise<Response> => {
          downloads += 1;
          return new Response(archive);
        };
        const options = {
          asset,
          cacheRoot: join(root, "cache"),
          fetch: fetchFixture,
          platform: "linux" as const,
          architecture: "x64",
          extract: (_archive: Uint8Array, staging: string) =>
            writeFile(join(staging, "crane"), executable, { mode: 0o700 }),
        };
        const installed = yield* installCrane(options);
        assert.strictEqual((yield* Effect.promise(() => stat(installed))).mode & 0o777, 0o700);
        assert.strictEqual(downloads, 1);
        assert.strictEqual(yield* installCrane(options), installed);
        assert.strictEqual(downloads, 1);
        yield* Effect.promise(() => chmod(installed, 0o755));
        assert.strictEqual(yield* installCrane(options), installed);
        assert.strictEqual(downloads, 2);
      }),
    ),
  );
  it.effect("rejects symlinked cache ancestry before deletion or publication", () =>
    withTemporaryDirectory((root) =>
      Effect.gen(function* () {
        const outside = join(root, "outside");
        const cache = join(root, "cache-link");
        yield* Effect.promise(() => mkdir(outside));
        yield* Effect.promise(() => symlink(outside, cache));
        const result = yield* Effect.result(
          installCrane({ cacheRoot: cache, platform: "linux", architecture: "x64" }),
        );
        assert.isTrue(Result.isFailure(result));
        assert.isFalse(
          yield* Effect.promise(() =>
            access(join(outside, `crane-v0.20.3`)).then(
              () => true,
              () => false,
            ),
          ),
        );
      }),
    ),
  );

  it.effect("preserves an unrelated crane behind a symlinked platform directory", () =>
    withTemporaryDirectory((root) =>
      Effect.gen(function* () {
        const cache = join(root, "cache");
        const version = join(cache, `crane-v0.20.3`);
        const outside = join(root, "outside");
        const unrelated = join(outside, "crane");
        const contents = "unrelated-native-crane";
        yield* Effect.promise(() => mkdir(version, { recursive: true }));
        yield* Effect.promise(() => mkdir(outside));
        yield* Effect.promise(() => writeFile(unrelated, contents, { mode: 0o700 }));
        yield* Effect.promise(() => symlink(outside, join(version, "linux-x64")));
        let downloads = 0;

        const result = yield* Effect.result(
          installCrane({
            cacheRoot: cache,
            platform: "linux",
            architecture: "x64",
            fetch: async () => {
              downloads += 1;
              return new Response("must not download");
            },
          }),
        );

        assert.isTrue(Result.isFailure(result));
        assert.strictEqual(downloads, 0);
        assert.strictEqual(yield* Effect.promise(() => readFile(unrelated, "utf8")), contents);
        assert.strictEqual((yield* Effect.promise(() => stat(unrelated))).mode & 0o777, 0o700);
      }),
    ),
  );

  it.effect("bounds dishonest and stalled helper downloads", () =>
    withTemporaryDirectory((root) =>
      Effect.gen(function* () {
        const oversized = new Uint8Array(20 * 1024 * 1024 + 1);
        const dishonest = yield* Effect.result(
          installCrane({
            cacheRoot: join(root, "dishonest"),
            platform: "linux",
            architecture: "x64",
            fetch: async () => new Response(oversized, { headers: { "content-length": "1" } }),
          }),
        );
        assert.isTrue(Result.isFailure(dishonest));

        const stalled = yield* Effect.result(
          installCrane({
            cacheRoot: join(root, "stalled"),
            platform: "linux",
            architecture: "x64",
            downloadTimeoutMs: 20,
            fetch: async () =>
              new Response(
                new ReadableStream<Uint8Array>({
                  start: () => undefined,
                }),
              ),
          }),
        );
        assert.isTrue(Result.isFailure(stalled));
      }),
    ),
  );
});

describe("Docker-free OCI transfer", () => {
  it.effect("copies idempotently, retries, verifies identity, and isolates credentials", () =>
    withTemporaryDirectory((root) =>
      Effect.gen(function* () {
        let copyAttempts = 0;
        let authRoot: string | undefined;
        const commands: ReadonlyArray<string>[] = [];
        const run: RunCrane = (_executable, command) =>
          Effect.gen(function* () {
            commands.push(command.args);
            authRoot = command.environment.DOCKER_CONFIG;
            const authText = yield* Effect.promise(() =>
              readFile(join(command.environment.DOCKER_CONFIG, "config.json"), "utf8"),
            );
            assert.notInclude(command.args.join(" "), "registry-password");
            assert.notInclude(JSON.stringify(command.environment), "registry-password");
            assert.include(
              authText,
              Buffer.from("registry-user:registry-password").toString("base64"),
            );
            if (command.args[0] === "copy") {
              copyAttempts += 1;
              if (copyAttempts < 3)
                return yield* new ContainerImageError({
                  reason: "copy_failed",
                  message: "copy failed",
                });
              return "";
            }
            if (command.args[0] === "digest") return digest("a");
            if (command.args[0] === "manifest") return manifest;
            return configuration;
          });
        const target = yield* transferContainerImage(
          {
            source: parseContainerImageSource(sourceReference, configDigest),
            accountId: "e".repeat(32),
            repository: "scotty-test-container",
            username: "registry-user",
            password: "registry-password",
            helper: join(root, "crane"),
            retryBaseDelay: 0,
          },
          run,
        ).pipe(Effect.scoped);
        assert.strictEqual(
          target,
          `registry.cloudflare.com/${"e".repeat(32)}/scotty-test-container@${digest("a")}`,
        );
        assert.strictEqual(copyAttempts, 3);
        assert.isTrue(commands.every((args) => args.includes("--platform")));
        assert.isDefined(authRoot);
        const cleanedAuthRoot = authRoot;
        assert.ok(cleanedAuthRoot);
        const authStillExists = yield* Effect.promise(() =>
          access(join(cleanedAuthRoot, "config.json")).then(
            () => true,
            () => false,
          ),
        );
        assert.isFalse(authStillExists);
      }),
    ),
  );

  it.effect("fails after bounded copy retries without inspecting or publishing the target", () =>
    Effect.gen(function* () {
      let copyAttempts = 0;
      let targetInspections = 0;
      const run: RunCrane = (_executable, command) => {
        const reference = command.args.at(-1) ?? "";
        if (command.args[0] === "copy")
          return Effect.sync(() => {
            copyAttempts += 1;
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new ContainerImageError({ reason: "copy_failed", message: "copy failed" }),
              ),
            ),
          );
        if (reference.startsWith("registry.cloudflare.com/")) targetInspections += 1;
        if (command.args[0] === "digest") return Effect.succeed(digest("a"));
        if (command.args[0] === "manifest") return Effect.succeed(manifest);
        return Effect.succeed(configuration);
      };
      const result = yield* Effect.result(
        transferContainerImage(
          {
            source: parseContainerImageSource(sourceReference),
            accountId: "e".repeat(32),
            repository: "scotty-test-container",
            username: "registry-user",
            password: "registry-password",
            helper: "/fixture/crane",
            retryBaseDelay: 0,
          },
          run,
        ).pipe(Effect.scoped),
      );
      assert.isTrue(Result.isFailure(result));
      assert.strictEqual(copyAttempts, 3);
      assert.strictEqual(targetInspections, 0);
    }),
  );

  it.effect("rejects a wrong platform before copy", () =>
    Effect.gen(function* () {
      let copied = false;
      const run: RunCrane = (_executable, command) => {
        if (command.args[0] === "copy") copied = true;
        if (command.args[0] === "digest") return Effect.succeed(digest("a"));
        if (command.args[0] === "manifest") return Effect.succeed(manifest);
        return Effect.succeed(JSON.stringify({ os: "linux", architecture: "arm64" }));
      };
      const result = yield* Effect.result(
        transferContainerImage(
          {
            source: parseContainerImageSource(sourceReference),
            accountId: "e".repeat(32),
            repository: "scotty-test-container",
            username: "registry-user",
            password: "registry-password",
            helper: "/fixture/crane",
          },
          run,
        ).pipe(Effect.scoped),
      );
      assert.isTrue(Result.isFailure(result));
      assert.isFalse(copied);
    }),
  );
});

describe("Crane process bounds", () => {
  it.effect("terminates and reaps a helper when streamed output exceeds the cap", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(
        runCraneProcess(process.execPath, {
          args: ["-e", 'process.stdout.write("x".repeat(9 * 1024 * 1024))'],
          environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        }),
      );
      assert.isTrue(Result.isFailure(result));
    }),
  );
});

describe("Crane host cancellation", () => {
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    it(`reaps a stubborn helper before removing synthetic registry credentials on ${signal}`, async () => {
      const root = await mkdtemp(join(tmpdir(), "scotty-crane-signal-test-"));
      try {
        const helper = join(root, "stubborn-crane");
        const authRoot = join(root, "auth");
        const readyPath = join(root, "helper.pid");
        await writeFile(
          helper,
          '#!/bin/sh\ntrap "" TERM\nprintf "%s" "$$" > "$READY_PATH"\nwhile :; do sleep 1; done\n',
          { mode: 0o700 },
        );
        const child = spawn(
          "bun",
          [
            new URL("./fixtures/crane-signal-child.ts", import.meta.url).pathname,
            helper,
            authRoot,
            readyPath,
            signal,
          ],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (
            await access(readyPath).then(
              () => true,
              () => false,
            )
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const helperPid = Number(await readFile(readyPath, "utf8"));
        child.kill(signal);
        const [exitCode] = await once(child, "exit");
        assert.strictEqual(exitCode, signal === "SIGINT" ? 130 : 143);
        assert.isFalse(
          await access(join(authRoot, "config.json")).then(
            () => true,
            () => false,
          ),
        );
        assert.throws(() => process.kill(helperPid, 0));
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
