import { Context, Data, Effect, Layer, Predicate } from "effect";

export const SANDBOX_BUNDLE_MAX_GZIP_BYTES = 48 * 1024 * 1024;

export const sandboxBundleTarGzKey = (digest: string): string =>
  `sandbox-bundles/sha256/${digest}/bundle.tar.gz`;

export const sandboxBundleManifestKey = (digest: string): string =>
  `sandbox-bundles/sha256/${digest}/manifest.json`;

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
  readonly head: (key: string) => Promise<SandboxBundleObjectMetadata | undefined>;
  readonly get: (
    key: string,
  ) => Promise<
    | { readonly metadata: SandboxBundleObjectMetadata; readonly body: ReadableStream<Uint8Array> }
    | undefined
  >;
}

export interface SandboxBundlePutInput {
  readonly digest: string;
  readonly gzipBytes: Uint8Array;
  readonly manifestJson: string;
}

export type SandboxBundleFailureReason = "metadata_mismatch" | "missing" | "too_large" | "upstream";

export class SandboxBundleFailure extends Data.TaggedError("SandboxBundleFailure")<{
  readonly reason: SandboxBundleFailureReason;
  readonly message: string;
}> {}

export interface SandboxBundleGetResult {
  readonly gzipStream: ReadableStream<Uint8Array>;
}

interface SandboxBundleStoreShape {
  readonly putBundle: (input: SandboxBundlePutInput) => Effect.Effect<void, SandboxBundleFailure>;
  readonly getBundle: (
    digest: string,
  ) => Effect.Effect<SandboxBundleGetResult, SandboxBundleFailure>;
}

export class SandboxBundleStore extends Context.Service<
  SandboxBundleStore,
  SandboxBundleStoreShape
>()("scotty/SandboxBundleStore") {}

const metadataMatches = (
  metadata: SandboxBundleObjectMetadata | undefined,
  expected: {
    readonly key: string;
    readonly size: number;
    readonly contentType: string;
    readonly digest: string;
  },
): boolean =>
  metadata !== undefined &&
  metadata.key === expected.key &&
  metadata.size === expected.size &&
  metadata.contentType === expected.contentType &&
  metadata.customMetadata.digest === expected.digest;

const reportSandboxBundleStorageFailure = (
  operation: "put" | "head" | "get",
  cause: unknown,
): void => {
  // oxlint-disable scotty/no-unknown-error-message -- boundary: native R2 rejection telemetry is redacted and never drives domain behavior
  const message = Predicate.isError(cause)
    ? cause.message.replaceAll(/[A-Za-z0-9_=-]{40,}/gu, "[redacted]").slice(0, 300)
    : undefined;
  // oxlint-enable scotty/no-unknown-error-message
  console.error("Sandbox bundle storage failed", {
    operation,
    error: Predicate.isError(cause) ? cause.name : typeof cause,
    ...(message === undefined || message.length === 0 ? {} : { message }),
  });
};

const reportSandboxBundleVerificationFailure = (
  operation: "put" | "head" | "get",
  reason: "missing" | "metadata_mismatch" | "too_large",
): void => {
  console.error("Sandbox bundle verification failed", { operation, reason });
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
    digest: string,
  ) {
    const customMetadata = { digest };
    const expected = { key, size: bytes.byteLength, contentType, digest };
    const put = Effect.tryPromise({
      try: () =>
        capabilities.put(key, bytes, { contentType, customMetadata }, { etagDoesNotMatch: "*" }),
      catch: (cause) => {
        reportSandboxBundleStorageFailure("put", cause);
        return new SandboxBundleFailure({
          reason: "upstream",
          message: "Sandbox bundle storage failed",
        });
      },
    });
    const head = Effect.tryPromise({
      try: () => capabilities.head(key),
      catch: (cause) => {
        reportSandboxBundleStorageFailure("head", cause);
        return new SandboxBundleFailure({
          reason: "upstream",
          message: "Sandbox bundle storage failed",
        });
      },
    });
    const putResult = yield* put;
    if (putResult !== null) {
      if (metadataMatches(putResult, expected)) return;
      reportSandboxBundleVerificationFailure("put", "metadata_mismatch");
      return yield* new SandboxBundleFailure({
        reason: "metadata_mismatch",
        message: "Sandbox bundle storage metadata mismatch",
      });
    }
    const headResult = yield* head;
    if (metadataMatches(headResult, expected)) return;
    if (headResult !== undefined) {
      reportSandboxBundleVerificationFailure("head", "metadata_mismatch");
      return yield* new SandboxBundleFailure({
        reason: "metadata_mismatch",
        message: "Sandbox bundle storage metadata mismatch",
      });
    }
    reportSandboxBundleVerificationFailure("head", "missing");
    return yield* new SandboxBundleFailure({
      reason: "upstream",
      message: "Sandbox bundle storage failed",
    });
  });

  return SandboxBundleStore.of({
    putBundle: Effect.fnUntraced(function* (input: SandboxBundlePutInput) {
      const manifestBytes = new TextEncoder().encode(input.manifestJson);
      yield* createOnlyObject(
        sandboxBundleTarGzKey(input.digest),
        input.gzipBytes,
        "application/gzip",
        input.digest,
      );
      yield* createOnlyObject(
        sandboxBundleManifestKey(input.digest),
        manifestBytes,
        "application/json",
        input.digest,
      );
    }),
    getBundle: Effect.fnUntraced(function* (digest: string) {
      const key = sandboxBundleTarGzKey(digest);
      const object = yield* Effect.tryPromise({
        try: () => capabilities.get(key),
        catch: (cause) => {
          reportSandboxBundleStorageFailure("get", cause);
          return new SandboxBundleFailure({
            reason: "upstream",
            message: "Sandbox bundle storage failed",
          });
        },
      });
      if (object === undefined) {
        reportSandboxBundleVerificationFailure("get", "missing");
        return yield* new SandboxBundleFailure({
          reason: "missing",
          message: "Sandbox bundle is missing",
        });
      }
      const metadataDigest = object.metadata.customMetadata.digest;
      if (metadataDigest !== undefined && metadataDigest !== digest) {
        reportSandboxBundleVerificationFailure("get", "metadata_mismatch");
        return yield* new SandboxBundleFailure({
          reason: "metadata_mismatch",
          message: "Sandbox bundle storage metadata mismatch",
        });
      }
      if (object.metadata.size > SANDBOX_BUNDLE_MAX_GZIP_BYTES) {
        yield* Effect.promise(() => object.body.cancel()).pipe(Effect.ignore);
        reportSandboxBundleVerificationFailure("get", "too_large");
        return yield* new SandboxBundleFailure({
          reason: "too_large",
          message: "Sandbox bundle exceeds the size limit",
        });
      }
      return { gzipStream: object.body };
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
  head: (key) =>
    bucket.head(key).then((object) => (object === null ? undefined : r2Metadata(object))),
  get: (key) =>
    bucket
      .get(key)
      .then((object) =>
        object === null ? undefined : { metadata: r2Metadata(object), body: object.body },
      ),
});
