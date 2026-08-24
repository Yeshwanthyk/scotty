import { Context, Data, Effect, Layer, Predicate } from "effect";
import { sha256BytesHex } from "./digest";

export const SANDBOX_BUNDLE_MAX_GZIP_BYTES = 48 * 1024 * 1024;
export const SANDBOX_SNAPSHOT_MAX_BYTES = 512 * 1024;

const digestHex = (digest: string): string =>
  digest.startsWith("sha256:") ? digest.slice(7) : digest;

export const sandboxPluginBundleTarGzKey = (digest: string): string =>
  `plugin-bundles/sha256/${digestHex(digest)}/bundle.tar.gz`;

export const sandboxSnapshotKey = (digest: string): string =>
  `sandbox-snapshots/sha256/${digestHex(digest)}/snapshot.json`;

export interface SandboxBundleObjectMetadata {
  readonly key: string;
  readonly size: number;
  readonly contentType: string | undefined;
  readonly customMetadata: Readonly<Record<string, string>>;
}

export interface SandboxBundlePutMetadata {
  readonly contentType: string;
  readonly customMetadata: Readonly<Record<string, string>>;
}

export interface SandboxBundleCapabilities {
  readonly put: (
    key: string,
    bytes: Uint8Array,
    metadata: SandboxBundlePutMetadata,
    onlyIf: R2Conditional,
  ) => Promise<SandboxBundleObjectMetadata | null>;
  readonly get: (
    key: string,
  ) => Promise<
    | { readonly metadata: SandboxBundleObjectMetadata; readonly body: ReadableStream<Uint8Array> }
    | undefined
  >;
}

export type SandboxBundleFailureReason = "metadata_mismatch" | "missing" | "too_large" | "upstream";

export class SandboxBundleFailure extends Data.TaggedError("SandboxBundleFailure")<{
  readonly reason: SandboxBundleFailureReason;
  readonly message: string;
}> {}

interface SandboxBundleStoreShape {
  readonly putPluginBundle: (
    digest: string,
    gzipBytes: Uint8Array,
  ) => Effect.Effect<void, SandboxBundleFailure>;
  readonly putSnapshot: (input: {
    readonly snapshotDigest: string;
    readonly snapshotJson: string;
    readonly pluginBundleDigest: string;
  }) => Effect.Effect<void, SandboxBundleFailure>;
  readonly getPluginBundle: (
    digest: string,
  ) => Effect.Effect<{ readonly gzipBytes: Uint8Array }, SandboxBundleFailure>;
  readonly getSnapshot: (
    digest: string,
  ) => Effect.Effect<
    { readonly snapshotJson: string; readonly pluginBundleDigest: string },
    SandboxBundleFailure
  >;
}

export class SandboxBundleStore extends Context.Service<
  SandboxBundleStore,
  SandboxBundleStoreShape
>()("scotty/SandboxBundleStore") {}

const metadataMatches = (
  metadata: SandboxBundleObjectMetadata | undefined,
  expected: SandboxBundleObjectMetadata,
): boolean =>
  metadata !== undefined &&
  metadata.key === expected.key &&
  metadata.size === expected.size &&
  metadata.contentType === expected.contentType &&
  Object.keys(metadata.customMetadata).length === Object.keys(expected.customMetadata).length &&
  Object.entries(expected.customMetadata).every(
    ([name, value]) => metadata.customMetadata[name] === value,
  );

const reportStorageFailure = (operation: "put" | "get", cause: unknown): void => {
  // oxlint-disable scotty/no-unknown-error-message -- boundary: native R2 rejection telemetry is redacted and never drives domain behavior
  const message = Predicate.isError(cause)
    ? cause.message.replaceAll(/[A-Za-z0-9_=-]{40,}/gu, "[redacted]").slice(0, 300)
    : undefined;
  // oxlint-enable scotty/no-unknown-error-message
  console.error("Sandbox immutable storage failed", {
    operation,
    error: Predicate.isError(cause) ? cause.name : typeof cause,
    ...(message === undefined || message.length === 0 ? {} : { message }),
  });
};

const readBoundedStream = async (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array | undefined> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(next.value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

export const sandboxBundleStoreLayer = (
  capabilities: SandboxBundleCapabilities,
): Layer.Layer<SandboxBundleStore> =>
  Layer.succeed(SandboxBundleStore)(makeSandboxBundleStore(capabilities));

const makeSandboxBundleStore = (
  capabilities: SandboxBundleCapabilities,
): SandboxBundleStoreShape => {
  const createOnlyObject = Effect.fnUntraced(function* (
    key: string,
    bytes: Uint8Array,
    contentType: string,
    customMetadata: Readonly<Record<string, string>>,
  ) {
    const expected: SandboxBundleObjectMetadata = {
      key,
      size: bytes.byteLength,
      contentType,
      customMetadata,
    };
    const computedDigest = yield* Effect.tryPromise({
      try: () => sha256BytesHex(bytes),
      catch: () =>
        new SandboxBundleFailure({
          reason: "upstream",
          message: "Immutable content digest failed",
        }),
    });
    if (`sha256:${computedDigest}` !== customMetadata.digest)
      return yield* new SandboxBundleFailure({
        reason: "metadata_mismatch",
        message: "Immutable content digest mismatch",
      });
    const putResult = yield* Effect.tryPromise({
      try: () =>
        capabilities.put(key, bytes, { contentType, customMetadata }, { etagDoesNotMatch: "*" }),
      catch: (cause) => {
        reportStorageFailure("put", cause);
        return new SandboxBundleFailure({
          reason: "upstream",
          message: "Immutable storage failed",
        });
      },
    });
    if (putResult !== null) {
      if (metadataMatches(putResult, expected)) return;
      return yield* new SandboxBundleFailure({
        reason: "metadata_mismatch",
        message: "Immutable storage metadata mismatch",
      });
    }
    const existing = yield* getObject(key, bytes.byteLength);
    if (!metadataMatches(existing.metadata, expected))
      return yield* new SandboxBundleFailure({
        reason: "metadata_mismatch",
        message: "Immutable storage metadata mismatch",
      });
    const existingDigest = yield* Effect.tryPromise({
      try: () => sha256BytesHex(existing.bytes),
      catch: () =>
        new SandboxBundleFailure({
          reason: "upstream",
          message: "Immutable content digest failed",
        }),
    });
    if (`sha256:${existingDigest}` !== customMetadata.digest)
      return yield* new SandboxBundleFailure({
        reason: "metadata_mismatch",
        message: "Immutable content digest mismatch",
      });
  });

  function getObject(key: string, maxBytes: number) {
    return Effect.gen(function* () {
      const object = yield* Effect.tryPromise({
        try: () => capabilities.get(key),
        catch: (cause) => {
          reportStorageFailure("get", cause);
          return new SandboxBundleFailure({
            reason: "upstream",
            message: "Immutable storage failed",
          });
        },
      });
      if (object === undefined)
        return yield* new SandboxBundleFailure({
          reason: "missing",
          message: "Immutable input is missing",
        });
      const bytes = yield* Effect.tryPromise({
        try: () => readBoundedStream(object.body, maxBytes),
        catch: (cause) => {
          reportStorageFailure("get", cause);
          return new SandboxBundleFailure({
            reason: "upstream",
            message: "Immutable storage failed",
          });
        },
      });
      if (bytes === undefined)
        return yield* new SandboxBundleFailure({
          reason: "too_large",
          message: "Immutable input exceeds the size limit",
        });
      if (object.metadata.key !== key || object.metadata.size !== bytes.byteLength)
        return yield* new SandboxBundleFailure({
          reason: "metadata_mismatch",
          message: "Immutable storage metadata mismatch",
        });
      return { metadata: object.metadata, bytes };
    });
  }

  const verifyContentDigest = Effect.fnUntraced(function* (bytes: Uint8Array, digest: string) {
    const computed = yield* Effect.tryPromise({
      try: () => sha256BytesHex(bytes),
      catch: () =>
        new SandboxBundleFailure({
          reason: "upstream",
          message: "Immutable content digest failed",
        }),
    });
    if (`sha256:${computed}` !== digest)
      return yield* new SandboxBundleFailure({
        reason: "metadata_mismatch",
        message: "Immutable content digest mismatch",
      });
  });

  return SandboxBundleStore.of({
    putPluginBundle: (digest, gzipBytes) =>
      createOnlyObject(sandboxPluginBundleTarGzKey(digest), gzipBytes, "application/gzip", {
        digest,
      }),
    putSnapshot: ({ snapshotDigest, snapshotJson, pluginBundleDigest }) =>
      createOnlyObject(
        sandboxSnapshotKey(snapshotDigest),
        new TextEncoder().encode(snapshotJson),
        "application/json",
        { digest: snapshotDigest, pluginBundleDigest },
      ),
    getPluginBundle: Effect.fnUntraced(function* (digest: string) {
      const key = sandboxPluginBundleTarGzKey(digest);
      const object = yield* getObject(key, SANDBOX_BUNDLE_MAX_GZIP_BYTES);
      if (
        !metadataMatches(object.metadata, {
          key,
          size: object.bytes.byteLength,
          contentType: "application/gzip",
          customMetadata: { digest },
        })
      )
        return yield* new SandboxBundleFailure({
          reason: "metadata_mismatch",
          message: "Plugin bundle metadata mismatch",
        });
      yield* verifyContentDigest(object.bytes, digest);
      return { gzipBytes: object.bytes };
    }),
    getSnapshot: Effect.fnUntraced(function* (digest: string) {
      const key = sandboxSnapshotKey(digest);
      const object = yield* getObject(key, SANDBOX_SNAPSHOT_MAX_BYTES);
      const pluginBundleDigest = object.metadata.customMetadata.pluginBundleDigest;
      if (
        pluginBundleDigest === undefined ||
        !metadataMatches(object.metadata, {
          key,
          size: object.bytes.byteLength,
          contentType: "application/json",
          customMetadata: { digest, pluginBundleDigest },
        })
      )
        return yield* new SandboxBundleFailure({
          reason: "metadata_mismatch",
          message: "Snapshot metadata mismatch",
        });
      yield* verifyContentDigest(object.bytes, digest);
      return { snapshotJson: new TextDecoder().decode(object.bytes), pluginBundleDigest };
    }),
  });
};

const r2Metadata = (object: R2Object): SandboxBundleObjectMetadata => ({
  key: object.key,
  size: object.size,
  contentType: object.httpMetadata?.contentType,
  customMetadata: { ...object.customMetadata },
});

export const r2SandboxBundleCapabilities = (bucket: R2Bucket): SandboxBundleCapabilities => ({
  put: (key, bytes, metadata, onlyIf) =>
    bucket
      .put(key, bytes, {
        onlyIf,
        httpMetadata: { contentType: metadata.contentType },
        customMetadata: { ...metadata.customMetadata },
      })
      .then((object) => (object === null ? null : r2Metadata(object))),
  get: (key) =>
    bucket
      .get(key)
      .then((object) =>
        object === null ? undefined : { metadata: r2Metadata(object), body: object.body },
      ),
});
