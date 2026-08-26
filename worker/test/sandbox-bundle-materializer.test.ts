import { assert, describe, it } from "@effect/vitest";
import type { ExecResult } from "@cloudflare/sandbox";
import { Effect, Layer, Result, Data } from "effect";
import {
  createDeterministicTarGz,
  encodeUstarArchive,
  gunzipSandboxArchive,
  gzipDeterministic,
  parseSandboxTar,
  type TarMember,
} from "../../cli/src/sandbox-archive";
import { itemContentDigest, sha256Bytes } from "../../cli/src/sandbox-bundle";
import {
  sandboxBundleMaterializerLayer,
  sandboxBundleRoot,
  SandboxBundleMaterializer,
  SandboxBundleMaterializationFailure,
  type MaterializedSandboxBundle,
} from "../src/sandbox-bundle-materializer";
import {
  sandboxBundleStoreLayer,
  sandboxBundleTarGzKey,
  type SandboxBundleCapabilities,
  type SandboxBundleObjectMetadata,
} from "../src/sandbox-bundle-store";
import { sandboxRuntimeLayer, type SandboxRuntimeCapabilities } from "../src/sandbox-runtime";
import { sha256BytesHex } from "../src/digest";

const SESSION_ID = "a0b1c2d3e4f5";
const encoder = new TextEncoder();

class MaterializerMissingFile extends Data.TaggedError("MaterializerMissingFile")<{
  readonly path: string;
}> {}

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

const resultSuccess = <A, E>(result: Result.Result<A, E>): A => {
  assert.ok(Result.isSuccess(result));
  return result.success;
};

const required = <A>(value: A | undefined): A => {
  assert.ok(value !== undefined);
  return value;
};

const assertSame = <A>(left: A, right: A): void => assert.strictEqual(left, right);

const successResult = (command: string): ExecResult => ({
  success: true,
  exitCode: 0,
  stdout: "",
  stderr: "",
  command,
  duration: 1,
  timestamp: "2026-07-22T00:00:00.000Z",
});

const unquoteShellArg = (quoted: string): string =>
  quoted.startsWith("'") && quoted.endsWith("'")
    ? quoted.slice(1, -1).replaceAll("'\\''", "'")
    : quoted;

const readStreamBytes = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

class MaterializerFilesystemFake {
  readonly files = new Map<string, Uint8Array>();
  writeFileCalls = 0;
  readonly execCommands: string[] = [];

  capabilities(): SandboxRuntimeCapabilities {
    return {
      exec: async (command) => {
        this.execCommands.push(command);
        await this.applyExec(command);
        return successResult(command);
      },
      mkdir: async () => undefined,
      readFileStream: async (path) => {
        const bytes = this.files.get(path);
        if (bytes === undefined) return Promise.reject(new MaterializerMissingFile({ path }));
        return new Blob([bytes]).stream();
      },
      writeFile: async (path, content) => {
        this.writeFileCalls += 1;
        if (typeof content === "string") {
          this.files.set(path, encoder.encode(content));
          return;
        }
        if (content instanceof Uint8Array) {
          this.files.set(path, content);
          return;
        }
        this.files.set(path, await readStreamBytes(content));
      },
      setEnvVars: async () => undefined,
    };
  }

  private async applyExec(command: string): Promise<void> {
    const extract = /^tar -xzf (.+) -C (.+) && rm -f (.+)$/u.exec(command);
    if (extract !== null) {
      const archivePath = unquoteShellArg(extract[1]);
      const stagingRoot = unquoteShellArg(extract[2]);
      assertSame(archivePath, unquoteShellArg(extract[3]));
      const archive = required(this.files.get(archivePath));
      const tar = resultSuccess(gunzipSandboxArchive(archive));
      const members = resultSuccess(parseSandboxTar(tar));
      for (const member of members) {
        if (member.type === "file") this.files.set(`${stagingRoot}/${member.path}`, member.bytes);
      }
      this.files.delete(archivePath);
      return;
    }
    const promote = /^rm -rf (.+) && mv (.+) (.+)$/u.exec(command);
    if (promote === null) return;
    const finalRoot = unquoteShellArg(promote[1]);
    const stagingRoot = unquoteShellArg(promote[2]);
    const promotedFinalRoot = unquoteShellArg(promote[3]);
    assert.strictEqual(finalRoot, promotedFinalRoot);
    const staged = [...this.files.entries()].filter(
      ([key]) => key === stagingRoot || key.startsWith(`${stagingRoot}/`),
    );
    for (const key of this.files.keys()) {
      if (key === finalRoot || key.startsWith(`${finalRoot}/`)) this.files.delete(key);
    }
    for (const [key, value] of staged) {
      this.files.delete(key);
      const suffix = key === stagingRoot ? "" : key.slice(stagingRoot.length);
      this.files.set(`${finalRoot}${suffix}`, value);
    }
  }

  pathsUnder(prefix: string): ReadonlyArray<string> {
    return [...this.files.keys()].filter(
      (path) => path === prefix || path.startsWith(`${prefix}/`),
    );
  }
}

interface StoredBundleObject extends SandboxBundleObjectMetadata {
  readonly bytes: Uint8Array;
}

const makeMemoryBundleCapabilities = (objects = new Map<string, StoredBundleObject>()) => {
  let getCalls = 0;
  const capabilities: SandboxBundleCapabilities = {
    put: async () => null,
    head: async (key) => objects.get(key),
    get: async (key) => {
      getCalls += 1;
      const object = objects.get(key);
      if (object === undefined) return undefined;
      return { metadata: object, body: new Blob([object.bytes]).stream() };
    },
  };
  return { capabilities, objects, getCalls: () => getCalls };
};

const seedBundle = (
  objects: Map<string, StoredBundleObject>,
  built: ReturnType<typeof createDeterministicTarGz>,
): void => {
  objects.set(sandboxBundleTarGzKey(built.digest), {
    key: sandboxBundleTarGzKey(built.digest),
    size: built.archive.byteLength,
    contentType: "application/gzip",
    customMetadata: { digest: built.digest },
    bytes: built.archive,
  });
};

const materialize = (
  filesystem: MaterializerFilesystemFake,
  bundle: ReturnType<typeof makeMemoryBundleCapabilities>,
  input: { readonly sessionId: string; readonly digest: string | null },
) =>
  Effect.flatMap(SandboxBundleMaterializer, (materializer) => materializer.materialize(input)).pipe(
    Effect.provide(
      sandboxBundleMaterializerLayer.pipe(
        Layer.provide(
          Layer.merge(
            sandboxRuntimeLayer(filesystem.capabilities()),
            sandboxBundleStoreLayer(bundle.capabilities),
          ),
        ),
      ),
    ),
  );

const materializationFailure = (
  result: Result.Result<MaterializedSandboxBundle, SandboxBundleMaterializationFailure>,
): SandboxBundleMaterializationFailure => {
  assert.ok(Result.isFailure(result));
  return result.failure;
};

const emptyBundle = () =>
  createDeterministicTarGz([
    fileMember("manifest.json", '{"schemaVersion":1,"skills":[],"piPackages":[]}\n'),
  ]);

const skillBundle = (content = "# Release Notes\n") => {
  // v1 fixture retained to prove legacy archive compatibility.
  const skillBytes = encoder.encode(content);
  const fileRecord = {
    path: "SKILL.md",
    size: skillBytes.byteLength,
    modeClass: "regular" as const,
    digest: sha256Bytes(skillBytes),
  };
  const manifest = {
    schemaVersion: 1 as const,
    skills: [
      {
        name: "release-notes",
        digest: itemContentDigest([fileRecord]),
        hasExecutableContent: false,
        files: [fileRecord],
      },
    ],
    piPackages: [],
  };
  return createDeterministicTarGz([
    fileMember("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`),
    {
      path: "skills/release-notes/SKILL.md",
      type: "file",
      modeClass: "regular",
      bytes: skillBytes,
    },
  ]);
};

const itemBundle = () => {
  const contents = [
    {
      kind: "skill" as const,
      name: "release-notes",
      shape: "directory" as const,
      path: "SKILL.md",
      content: "# Release Notes\n",
    },
    {
      kind: "tool" as const,
      name: "hello",
      shape: "file" as const,
      path: "hello",
      content: "#!/bin/sh\necho hello\n",
    },
    {
      kind: "extension" as const,
      name: "review",
      shape: "directory" as const,
      path: "index.ts",
      content: "export default () => {}\n",
    },
    {
      kind: "package" as const,
      name: "@scope/ready-package",
      shape: "directory" as const,
      path: "package.json",
      content: '{"name":"@scope/ready-package","pi":{"extensions":["index.ts"]}}\n',
    },
  ];
  const items = contents.map((item) => {
    const bytes = encoder.encode(item.content);
    const file = {
      path: item.path,
      size: bytes.byteLength,
      modeClass: item.kind === "tool" ? ("executable" as const) : ("regular" as const),
      digest: sha256Bytes(bytes),
    };
    return {
      kind: item.kind,
      name: item.name,
      shape: item.shape,
      digest: itemContentDigest([file]),
      files: [file],
    };
  });
  const manifest = { schemaVersion: 2 as const, items };
  return createDeterministicTarGz([
    fileMember("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`),
    fileMember("skills/release-notes/SKILL.md", contents[0]!.content),
    fileMember("tools/hello", contents[1]!.content, "executable"),
    fileMember("extensions/review/index.ts", contents[2]!.content),
    fileMember("pi-packages/@scope/ready-package/package.json", contents[3]!.content),
  ]);
};

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

describe("SandboxBundleMaterializer", () => {
  it.effect("materializes manifest.json and .verified and removes staging", () =>
    Effect.gen(function* () {
      const filesystem = new MaterializerFilesystemFake();
      const bundle = makeMemoryBundleCapabilities();
      const built = emptyBundle();
      seedBundle(bundle.objects, built);

      yield* materialize(filesystem, bundle, { sessionId: SESSION_ID, digest: built.digest });

      const root = sandboxBundleRoot(SESSION_ID, built.digest);
      assert.ok(filesystem.files.has(`${root}/manifest.json`));
      assert.ok(filesystem.files.has(`${root}/.verified`));
      assert.strictEqual(
        [...filesystem.files.keys()].some((path) => path.includes(".staging-")),
        false,
      );
      assert.match(filesystem.execCommands.at(-1) ?? "", /^rm -rf/u);
    }),
  );

  it.effect("writes skill files under the digest directory without path escape", () =>
    Effect.gen(function* () {
      const filesystem = new MaterializerFilesystemFake();
      const bundle = makeMemoryBundleCapabilities();
      const built = skillBundle();
      seedBundle(bundle.objects, built);

      yield* materialize(filesystem, bundle, { sessionId: SESSION_ID, digest: built.digest });

      const skillPath = `${sandboxBundleRoot(SESSION_ID, built.digest)}/skills/release-notes/SKILL.md`;
      assert.strictEqual(
        new TextDecoder().decode(filesystem.files.get(skillPath)),
        "# Release Notes\n",
      );
      assert.strictEqual(
        filesystem
          .pathsUnder(sandboxBundleRoot(SESSION_ID, built.digest))
          .some((path) => path.includes("..")),
        false,
      );
    }),
  );

  it.effect("materializes the v2 item list and preserves each item shape", () =>
    Effect.gen(function* () {
      const filesystem = new MaterializerFilesystemFake();
      const bundle = makeMemoryBundleCapabilities();
      const built = itemBundle();
      seedBundle(bundle.objects, built);

      const materialized = yield* materialize(filesystem, bundle, {
        sessionId: SESSION_ID,
        digest: built.digest,
      });

      const root = sandboxBundleRoot(SESSION_ID, built.digest);
      assert.ok(filesystem.files.has(`${root}/skills/release-notes/SKILL.md`));
      assert.ok(filesystem.files.has(`${root}/tools/hello`));
      assert.ok(filesystem.execCommands.some((command) => command.startsWith("tar -xzf ")));
      assert.strictEqual(filesystem.writeFileCalls, 2);
      assert.ok(filesystem.files.has(`${root}/extensions/review/index.ts`));
      assert.ok(filesystem.files.has(`${root}/pi-packages/@scope/ready-package/package.json`));
      assert.deepStrictEqual(materialized.items, [
        { kind: "skill", name: "release-notes" },
        { kind: "tool", name: "hello" },
        { kind: "extension", name: "review" },
        { kind: "package", name: "@scope/ready-package" },
      ]);
    }),
  );

  it.effect("skips rewrite when .verified already matches and still returns extras", () =>
    Effect.gen(function* () {
      const filesystem = new MaterializerFilesystemFake();
      const bundle = makeMemoryBundleCapabilities();
      const built = skillBundle();
      seedBundle(bundle.objects, built);

      yield* materialize(filesystem, bundle, { sessionId: SESSION_ID, digest: built.digest });
      const firstWrites = filesystem.writeFileCalls;

      const skipped = yield* materialize(filesystem, bundle, {
        sessionId: SESSION_ID,
        digest: built.digest,
      });

      assert.strictEqual(filesystem.writeFileCalls, firstWrites);
      assert.deepStrictEqual(skipped.items, [{ kind: "skill", name: "release-notes" }]);
      assert.strictEqual(skipped.bundleRoot, sandboxBundleRoot(SESSION_ID, built.digest));
    }),
  );

  it.effect("fails missing bundles without writing the final tree", () =>
    Effect.gen(function* () {
      const filesystem = new MaterializerFilesystemFake();
      const bundle = makeMemoryBundleCapabilities();
      const digest = "1".repeat(64);
      const result = yield* Effect.result(
        materialize(filesystem, bundle, { sessionId: SESSION_ID, digest }),
      );

      assert.deepInclude(materializationFailure(result), { reason: "missing" });
      assert.strictEqual(filesystem.pathsUnder(sandboxBundleRoot(SESSION_ID, digest)).length, 0);
      assert.strictEqual(filesystem.writeFileCalls, 0);
    }),
  );

  it.effect("fails closed on digest mismatch and hostile symlink archives", () =>
    Effect.gen(function* () {
      const filesystem = new MaterializerFilesystemFake();
      const bundleStore = makeMemoryBundleCapabilities();
      const built = emptyBundle();
      const wrongDigest = "2".repeat(64);
      bundleStore.objects.set(sandboxBundleTarGzKey(wrongDigest), {
        key: sandboxBundleTarGzKey(wrongDigest),
        size: built.archive.byteLength,
        contentType: "application/gzip",
        customMetadata: { digest: wrongDigest },
        bytes: built.archive,
      });
      const mismatch = yield* Effect.result(
        materialize(filesystem, bundleStore, { sessionId: SESSION_ID, digest: wrongDigest }),
      );
      assert.deepInclude(materializationFailure(mismatch), { reason: "digest_mismatch" });
      assert.strictEqual(
        filesystem.pathsUnder(sandboxBundleRoot(SESSION_ID, wrongDigest)).length,
        0,
      );

      const tar = patchHeader(
        encodeUstarArchive([
          fileMember("manifest.json", '{"schemaVersion":1,"skills":[],"piPackages":[]}\n'),
        ]),
        (header) => {
          header[156] = 50;
        },
      );
      const hostile = gzipDeterministic(tar);
      const hostileDigest = yield* Effect.tryPromise({
        try: () => sha256BytesHex(tar),
        catch: () => new Error("hash failed"),
      });
      const hostileBundle = makeMemoryBundleCapabilities();
      seedBundle(hostileBundle.objects, {
        tar,
        archive: hostile,
        digest: hostileDigest,
      });
      const hostileFilesystem = new MaterializerFilesystemFake();
      const invalid = yield* Effect.result(
        materialize(hostileFilesystem, hostileBundle, {
          sessionId: SESSION_ID,
          digest: hostileDigest,
        }),
      );
      assert.deepInclude(materializationFailure(invalid), { reason: "invalid_archive" });
      assert.strictEqual(
        hostileFilesystem.pathsUnder(sandboxBundleRoot(SESSION_ID, hostileDigest)).length,
        0,
      );
    }),
  );

  it.effect("treats digest null as a no-op", () =>
    Effect.gen(function* () {
      const filesystem = new MaterializerFilesystemFake();
      const bundle = makeMemoryBundleCapabilities();

      const materialized = yield* materialize(filesystem, bundle, {
        sessionId: SESSION_ID,
        digest: null,
      });

      assert.deepStrictEqual(materialized, {
        digest: null,
        items: [],
        bundleRoot: undefined,
      });
      assert.strictEqual(bundle.getCalls(), 0);
      assert.strictEqual(filesystem.writeFileCalls, 0);
    }),
  );
});
