import { assert, describe, it } from "@effect/vitest";
import type { ExecResult } from "@cloudflare/sandbox";
import { Data, Effect, Layer } from "effect";
import type { DeployedSnapshot } from "../../protocol/sandbox-config";
import { createDeterministicTarGz } from "../../cli/src/sandbox-archive";
import { encodeDeployedSnapshotJson, sha256Bytes, sha256Text } from "../../cli/src/sandbox-bundle";
import {
  sandboxBundleMaterializerLayer,
  sandboxBundleRoot,
  SandboxBundleMaterializer,
} from "../src/sandbox-bundle-materializer";
import {
  sandboxBundleStoreLayer,
  sandboxPluginBundleTarGzKey,
  sandboxSnapshotKey,
  type SandboxBundleCapabilities,
  type SandboxBundleObjectMetadata,
} from "../src/sandbox-bundle-store";
import { sandboxRuntimeLayer, type SandboxRuntimeCapabilities } from "../src/sandbox-runtime";

const SESSION_ID = "a0b1c2d3e4f5";
const encoder = new TextEncoder();

class MissingFile extends Data.TaggedError("MissingFile")<{ readonly path: string }> {}

const successResult = (command: string): ExecResult => ({
  success: true,
  exitCode: 0,
  stdout: "",
  stderr: "",
  command,
  duration: 1,
  timestamp: "2026-08-24T00:00:00.000Z",
});

const unquote = (value: string): string =>
  value.startsWith("'") && value.endsWith("'")
    ? value.slice(1, -1).replaceAll("'\\''", "'")
    : value;

class RuntimeFake {
  readonly files = new Map<string, Uint8Array>();
  writeCalls = 0;

  capabilities(): SandboxRuntimeCapabilities {
    return {
      exec: async (command) => {
        const promoted = /&& mv ('.*') ('.*')$/u.exec(command);
        if (promoted !== null) this.promote(unquote(promoted[1]), unquote(promoted[2]));
        return successResult(command);
      },
      mkdir: async () => undefined,
      readFileStream: async (path) => {
        const bytes = this.files.get(path);
        if (bytes === undefined) throw new MissingFile({ path });
        return new Blob([bytes]).stream();
      },
      writeFile: async (path, content) => {
        this.writeCalls += 1;
        if (typeof content === "string") this.files.set(path, encoder.encode(content));
        else if (content instanceof Uint8Array) this.files.set(path, Uint8Array.from(content));
        else this.files.set(path, new Uint8Array(await new Response(content).arrayBuffer()));
      },
      setEnvVars: async () => undefined,
    };
  }

  private promote(stagingRoot: string, finalRoot: string): void {
    for (const [path, bytes] of this.files.entries()) {
      if (!path.startsWith(`${stagingRoot}/`)) continue;
      this.files.delete(path);
      this.files.set(`${finalRoot}${path.slice(stagingRoot.length)}`, bytes);
    }
  }
}

interface StoredObject extends SandboxBundleObjectMetadata {
  readonly bytes: Uint8Array;
}

const memoryStore = (objects: Map<string, StoredObject>): SandboxBundleCapabilities => ({
  put: async () => null,
  get: async (key) => {
    const object = objects.get(key);
    return object === undefined
      ? undefined
      : { metadata: object, body: new Blob([object.bytes]).stream() };
  },
});

const snapshot = (revision: number, pluginBundleDigest: string): DeployedSnapshot => ({
  schemaVersion: 1,
  installationName: "home",
  revision,
  configDigest: sha256Text("config"),
  pluginBundleDigest,
  pi: {
    defaultProvider: "openai",
    defaultModel: "gpt-5.6-sol",
    defaultThinkingLevel: "medium",
  },
  plugins: [
    {
      id: "extension",
      type: "pi-extension",
      source: {
        kind: "builtin",
        name: "pi-subagents-extension",
        releaseDigest: sha256Text("extension"),
      },
      manifest: {
        identity: "pi-subagents",
        entrypoints: ["extensions/subagents/index.ts"],
        resourceDestinations: ["extensions/pi-subagents/subagents"],
      },
    },
    {
      id: "skill",
      type: "skill",
      source: { kind: "builtin", name: "pi-subagents-skill", releaseDigest: sha256Text("skill") },
      manifest: { name: "subagents", resourceDestinations: ["skills/subagents"] },
    },
  ],
  sandboxSetup: { piExtensions: ["extension"], skills: ["skill"], sandboxTools: [] },
});

const builtSnapshot = (revision: number) => {
  const archive = createDeterministicTarGz([
    {
      path: "manifest.json",
      type: "file" as const,
      modeClass: "regular" as const,
      bytes: encoder.encode('{"schemaVersion":1,"plugins":[]}\n'),
    },
  ]);
  const pluginBundleDigest = sha256Bytes(archive.archive);
  const value = snapshot(revision, pluginBundleDigest);
  const snapshotJson = encodeDeployedSnapshotJson(value);
  return {
    archive: archive.archive,
    pluginBundleDigest,
    snapshotJson,
    snapshotDigest: sha256Text(snapshotJson),
  };
};

const materializerLayer = (runtime: RuntimeFake, objects: Map<string, StoredObject>) =>
  sandboxBundleMaterializerLayer.pipe(
    Layer.provide(
      Layer.merge(
        sandboxRuntimeLayer(runtime.capabilities()),
        sandboxBundleStoreLayer(memoryStore(objects)),
      ),
    ),
  );

describe("SandboxBundleMaterializer", () => {
  it.effect("materializes the exact pinned snapshot revision and reuses its verified bytes", () =>
    Effect.gen(function* () {
      const built = builtSnapshot(5);
      const objects = new Map<string, StoredObject>();
      const bundleKey = sandboxPluginBundleTarGzKey(built.pluginBundleDigest);
      objects.set(bundleKey, {
        key: bundleKey,
        size: built.archive.byteLength,
        contentType: "application/gzip",
        customMetadata: { digest: built.pluginBundleDigest },
        bytes: built.archive,
      });
      const snapshotKey = sandboxSnapshotKey(built.snapshotDigest);
      const snapshotBytes = encoder.encode(built.snapshotJson);
      objects.set(snapshotKey, {
        key: snapshotKey,
        size: snapshotBytes.byteLength,
        contentType: "application/json",
        customMetadata: {
          digest: built.snapshotDigest,
          pluginBundleDigest: built.pluginBundleDigest,
        },
        bytes: snapshotBytes,
      });
      const runtime = new RuntimeFake();
      const layer = materializerLayer(runtime, objects);
      const run = Effect.flatMap(SandboxBundleMaterializer, (materializer) =>
        materializer.materialize({
          sessionId: SESSION_ID,
          revision: 5,
          digest: built.snapshotDigest,
        }),
      ).pipe(Effect.provide(layer));
      const first = yield* run;
      assert.strictEqual(first.revision, 5);
      assert.strictEqual(first.digest, built.snapshotDigest);
      assert.deepStrictEqual(first.skillPaths, [
        {
          name: "subagents",
          path: "/opt/scotty/pi-packages/sources/pi-subagents/skills/subagents",
        },
      ]);
      assert.ok(
        first.extensionPaths.some((path) => path.endsWith("extensions/subagents/index.ts")),
      );
      const writes = runtime.writeCalls;
      const second = yield* run;
      assert.deepStrictEqual(second, first);
      assert.strictEqual(runtime.writeCalls, writes);
      assert.ok(
        runtime.files.has(`${sandboxBundleRoot(SESSION_ID, built.snapshotDigest)}/.verified`),
      );
    }),
  );

  it.effect("rejects a Session revision that does not match immutable snapshot bytes", () =>
    Effect.gen(function* () {
      const built = builtSnapshot(3);
      const objects = new Map<string, StoredObject>();
      const snapshotKey = sandboxSnapshotKey(built.snapshotDigest);
      const snapshotBytes = encoder.encode(built.snapshotJson);
      objects.set(snapshotKey, {
        key: snapshotKey,
        size: snapshotBytes.byteLength,
        contentType: "application/json",
        customMetadata: {
          digest: built.snapshotDigest,
          pluginBundleDigest: built.pluginBundleDigest,
        },
        bytes: snapshotBytes,
      });
      const failure = yield* Effect.flatMap(SandboxBundleMaterializer, (materializer) =>
        materializer.materialize({
          sessionId: SESSION_ID,
          revision: 4,
          digest: built.snapshotDigest,
        }),
      ).pipe(Effect.provide(materializerLayer(new RuntimeFake(), objects)), Effect.flip);
      assert.strictEqual(failure.reason, "digest_mismatch");
    }),
  );
});
