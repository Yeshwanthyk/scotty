import { Context, Data, Effect, Layer, Result, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";
import { RUNTIME_CLI_ASSET_NAME } from "../../../protocol/runtime/runtime-cli-manifest";
import type { ResolvedRuntimeCliRelease } from "./release-resolver";

// The shared deployment typecheck also loads lib.dom, whose Crypto interface omits this
// native Workerd extension. This adapter executes only in the Cloudflare host.
declare global {
  interface Crypto {
    DigestStream: typeof DigestStream;
  }
}

const GITHUB_DOWNLOAD_ORIGIN = "https://github.com";
const RELEASE_ASSET_ORIGIN = "https://release-assets.githubusercontent.com";
const RELEASE_REPOSITORY = "Yeshwanthyk/scotty";
const CONTENT_TYPE = "application/octet-stream";
const MAX_REDIRECTS = 2;
// Cloudflare's single-put footnote and Miniflare R2 MAX_VALUE_SIZE.
const MAX_SINGLE_PUT_BYTES = 5 * 1024 * 1024 * 1024 - 5 * 1024 * 1024;
const REQUEST_TIMEOUT = "15 seconds";
const PUBLISH_TIMEOUT = "15 minutes";
const RECONCILIATION_HEADS = 3;

const CACHE_SCHEMA_METADATA = "scotty-runtime-cache-schema";
const CACHE_SHA256_METADATA = "scotty-runtime-byte-sha256";
const CACHE_SIZE_METADATA = "scotty-runtime-byte-size";
const CACHE_NAME_METADATA = "scotty-runtime-artifact-name";

export interface RuntimeCliCacheObject {
  readonly key: string;
  readonly size: number;
  readonly contentType?: string;
  readonly sha256?: Uint8Array;
  readonly customMetadata: Readonly<Record<string, string>>;
}

export class RuntimeCliCacheBucketFailure extends Data.TaggedError("RuntimeCliCacheBucketFailure")<{
  readonly operation: "head" | "put";
  /** ambiguous permits head reconciliation only after local length/digest verification.
   * incomplete means provider settlement is unknown without that proof: never reconcile. */
  readonly reason: "transport" | "source" | "length" | "integrity" | "ambiguous" | "incomplete";
  readonly actualLength?: number;
}> {}

interface RuntimeCliCacheBucketShape {
  readonly head: (
    key: string,
  ) => Effect.Effect<RuntimeCliCacheObject | undefined, RuntimeCliCacheBucketFailure>;
  readonly publish: (input: {
    readonly key: string;
    readonly source: ReadableStream<Uint8Array>;
    readonly byteSize: number;
    readonly sha256: string;
    readonly customMetadata: Readonly<Record<string, string>>;
  }) => Effect.Effect<RuntimeCliCacheObject | null, RuntimeCliCacheBucketFailure>;
}

/** Injected storage capability. Bucket selection and infrastructure remain outside this slice. */
export class RuntimeCliCacheBucket extends Context.Service<
  RuntimeCliCacheBucket,
  RuntimeCliCacheBucketShape
>()("scotty/RuntimeCliCacheBucket") {}

export type RuntimeCliCacheTransportStage = "download" | "storage_head" | "storage_put";

export class RuntimeCliCacheTransportError extends Data.TaggedError(
  "RuntimeCliCacheTransportError",
)<{
  readonly stage: RuntimeCliCacheTransportStage;
  readonly status?: number;
}> {}

export class RuntimeCliCacheLengthError extends Data.TaggedError("RuntimeCliCacheLengthError")<{
  readonly expected: number;
  readonly reason: "short" | "long";
}> {}

export class RuntimeCliCacheIntegrityError extends Data.TaggedError(
  "RuntimeCliCacheIntegrityError",
)<{
  readonly reason:
    | "digest_mismatch"
    | "unsafe_source"
    | "unsafe_redirect"
    | "encoded_response"
    | "missing_native_checksum";
}> {}

export class RuntimeCliCacheStorageAmbiguityError extends Data.TaggedError(
  "RuntimeCliCacheStorageAmbiguityError",
)<{}> {}

export class RuntimeCliCacheConflictError extends Data.TaggedError(
  "RuntimeCliCacheConflictError",
)<{}> {}

export class RuntimeCliCacheUnsupportedError extends Data.TaggedError(
  "RuntimeCliCacheUnsupportedError",
)<{
  readonly byteSize: number;
  readonly maximumByteSize: number;
}> {}

export type RuntimeCliCacheError =
  | RuntimeCliCacheTransportError
  | RuntimeCliCacheLengthError
  | RuntimeCliCacheIntegrityError
  | RuntimeCliCacheStorageAmbiguityError
  | RuntimeCliCacheConflictError
  | RuntimeCliCacheUnsupportedError;

export interface VerifiedRuntimeCliCacheHandle {
  readonly key: string;
  readonly byteSize: number;
  readonly sha256: string;
  /** Authenticated resolver output, borrowed without mutation. The handle freeze is shallow;
   * callers must not mutate this release or its nested descriptor during/after ensure. */
  readonly release: ResolvedRuntimeCliRelease;
}

interface RuntimeCliCacheShape {
  /** Accepts structurally trusted, authenticated resolver output, not arbitrary input.
   * Caller retains ownership and must not mutate it; this service does not deep-freeze it. */
  readonly ensure: (
    release: ResolvedRuntimeCliRelease,
  ) => Effect.Effect<VerifiedRuntimeCliCacheHandle, RuntimeCliCacheError>;
}

export class RuntimeCliCache extends Context.Service<RuntimeCliCache, RuntimeCliCacheShape>()(
  "scotty/RuntimeCliCache",
) {}

export const runtimeCliCacheObjectKey = (sha256: string): string =>
  `runtime-cli/sha256/${sha256}/${RUNTIME_CLI_ASSET_NAME}`;

const expectedDownloadUrl = (releaseTag: string): string =>
  `${GITHUB_DOWNLOAD_ORIGIN}/${RELEASE_REPOSITORY}/releases/download/${releaseTag}/${RUNTIME_CLI_ASSET_NAME}`;

const trustedRedirect = (location: string, currentUrl: string): string | undefined => {
  const parsed = URL.parse(location, currentUrl);
  if (
    parsed === null ||
    parsed.origin !== RELEASE_ASSET_ORIGIN ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== ""
  )
    return undefined;
  return parsed.href;
};

const customMetadata = (release: ResolvedRuntimeCliRelease): Readonly<Record<string, string>> => ({
  [CACHE_SCHEMA_METADATA]: "1",
  [CACHE_SHA256_METADATA]: release.descriptor.artifact.sha256,
  [CACHE_SIZE_METADATA]: String(release.descriptor.artifact.byteSize),
  [CACHE_NAME_METADATA]: release.descriptor.artifact.name,
});

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);

const decodeHex = (value: string): Uint8Array =>
  Uint8Array.from({ length: value.length / 2 }, (_, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );

const encodeHex = (value: ArrayBuffer): string =>
  Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");

const validObject = (
  object: RuntimeCliCacheObject,
  release: ResolvedRuntimeCliRelease,
): boolean => {
  const artifact = release.descriptor.artifact;
  const expectedMetadata = customMetadata(release);
  return (
    object.key === runtimeCliCacheObjectKey(artifact.sha256) &&
    object.size === artifact.byteSize &&
    object.contentType === CONTENT_TYPE &&
    object.sha256 !== undefined &&
    equalBytes(object.sha256, decodeHex(artifact.sha256)) &&
    Object.entries(expectedMetadata).every(([key, value]) => object.customMetadata[key] === value)
  );
};

const handle = (release: ResolvedRuntimeCliRelease): VerifiedRuntimeCliCacheHandle =>
  Object.freeze({
    key: runtimeCliCacheObjectKey(release.descriptor.artifact.sha256),
    byteSize: release.descriptor.artifact.byteSize,
    sha256: release.descriptor.artifact.sha256,
    release,
  });

const discardResponse = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const body = yield* Stream.toReadableStreamEffect(response.stream);
  // Cancel rather than drain: even rejected responses may be infinite or stalled.
  yield* Effect.promise(() => body.cancel()).pipe(
    Effect.timeoutOrElse({ duration: 0, orElse: () => Effect.void }),
    Effect.ignore,
  );
});

const execute = Effect.fnUntraced(function* (client: HttpClient.HttpClient, url: string) {
  return yield* client
    .execute(
      HttpClientRequest.get(url, {
        headers: {
          accept: CONTENT_TYPE,
          "accept-encoding": "identity",
          "user-agent": "scotty-runtime-cache",
        },
      }),
    )
    .pipe(
      Effect.mapError(() => new RuntimeCliCacheTransportError({ stage: "download" })),
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () => Effect.fail(new RuntimeCliCacheTransportError({ stage: "download" })),
      }),
    );
});

const download = Effect.fnUntraced(function* (
  client: HttpClient.HttpClient,
  release: ResolvedRuntimeCliRelease,
) {
  const canonical = expectedDownloadUrl(release.releaseTag);
  if (release.artifactDownloadUrl !== canonical)
    return yield* new RuntimeCliCacheIntegrityError({ reason: "unsafe_source" });
  let url = canonical;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = yield* execute(client, url);
    if (response.status === 200) {
      const encoding = response.headers["content-encoding"];
      if (encoding !== undefined && encoding !== "identity") {
        yield* discardResponse(response);
        return yield* new RuntimeCliCacheIntegrityError({ reason: "encoded_response" });
      }
      return yield* Stream.toReadableStreamEffect(
        response.stream.pipe(
          Stream.mapError(() => new RuntimeCliCacheTransportError({ stage: "download" })),
        ),
      );
    }
    yield* discardResponse(response);
    if (![301, 302, 303, 307, 308].includes(response.status))
      return yield* new RuntimeCliCacheTransportError({
        stage: "download",
        status: response.status,
      });
    const location = response.headers.location;
    const next = location === undefined ? undefined : trustedRedirect(location, url);
    if (next === undefined || redirects === MAX_REDIRECTS)
      return yield* new RuntimeCliCacheIntegrityError({ reason: "unsafe_redirect" });
    url = next;
  }
  return yield* new RuntimeCliCacheIntegrityError({ reason: "unsafe_redirect" });
});

const mapHeadFailure = (): RuntimeCliCacheTransportError =>
  new RuntimeCliCacheTransportError({ stage: "storage_head" });

const inspectExisting = Effect.fnUntraced(function* (
  bucket: RuntimeCliCacheBucketShape,
  release: ResolvedRuntimeCliRelease,
) {
  const object = yield* bucket
    .head(runtimeCliCacheObjectKey(release.descriptor.artifact.sha256))
    .pipe(
      Effect.mapError(mapHeadFailure),
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () => Effect.fail(mapHeadFailure()),
      }),
    );
  if (object === undefined) return undefined;
  if (!validObject(object, release)) {
    if (object.sha256 === undefined)
      return yield* new RuntimeCliCacheIntegrityError({ reason: "missing_native_checksum" });
    return yield* new RuntimeCliCacheConflictError();
  }
  return handle(release);
});

const reconcile = Effect.fnUntraced(function* (
  bucket: RuntimeCliCacheBucketShape,
  release: ResolvedRuntimeCliRelease,
) {
  for (let attempt = 0; attempt < RECONCILIATION_HEADS; attempt += 1) {
    const existing = yield* inspectExisting(bucket, release);
    if (existing !== undefined) return existing;
  }
  return yield* new RuntimeCliCacheStorageAmbiguityError();
});

const mapPublicationFailure = (
  error: RuntimeCliCacheBucketFailure,
  release: ResolvedRuntimeCliRelease,
): RuntimeCliCacheError => {
  if (error.reason === "source") return new RuntimeCliCacheTransportError({ stage: "download" });
  if (error.reason === "length")
    return new RuntimeCliCacheLengthError({
      expected: release.descriptor.artifact.byteSize,
      reason:
        error.actualLength !== undefined &&
        error.actualLength > release.descriptor.artifact.byteSize
          ? "long"
          : "short",
    });
  if (error.reason === "integrity")
    return new RuntimeCliCacheIntegrityError({ reason: "digest_mismatch" });
  if (error.reason === "transport")
    return new RuntimeCliCacheTransportError({ stage: "storage_put" });
  return new RuntimeCliCacheStorageAmbiguityError();
};

const makeRuntimeCliCache = (
  client: HttpClient.HttpClient,
  bucket: RuntimeCliCacheBucketShape,
): RuntimeCliCacheShape => ({
  ensure: (release) =>
    Effect.gen(function* () {
      const artifact = release.descriptor.artifact;
      if (artifact.byteSize > MAX_SINGLE_PUT_BYTES)
        return yield* new RuntimeCliCacheUnsupportedError({
          byteSize: artifact.byteSize,
          maximumByteSize: MAX_SINGLE_PUT_BYTES,
        });
      const existing = yield* inspectExisting(bucket, release);
      if (existing !== undefined) return existing;
      const source = yield* download(client, release);
      const publication = yield* Effect.result(
        bucket
          .publish({
            key: runtimeCliCacheObjectKey(artifact.sha256),
            source,
            byteSize: artifact.byteSize,
            sha256: artifact.sha256,
            customMetadata: customMetadata(release),
          })
          .pipe(
            Effect.timeoutOrElse({
              duration: "16 minutes",
              orElse: () =>
                Effect.fail(
                  new RuntimeCliCacheBucketFailure({ operation: "put", reason: "incomplete" }),
                ),
            }),
          ),
      );
      if (Result.isFailure(publication)) {
        if (publication.failure.reason === "ambiguous") return yield* reconcile(bucket, release);
        return yield* mapPublicationFailure(publication.failure, release);
      }
      if (publication.success === null) return yield* reconcile(bucket, release);
      if (!validObject(publication.success, release))
        return yield* new RuntimeCliCacheConflictError();
      return handle(release);
    }).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.timeoutOrElse({
        duration: "17 minutes",
        orElse: () => Effect.fail(new RuntimeCliCacheStorageAmbiguityError()),
      }),
    ),
});

export const runtimeCliCacheLayer: Layer.Layer<
  RuntimeCliCache,
  never,
  HttpClient.HttpClient | RuntimeCliCacheBucket
> = Layer.effect(
  RuntimeCliCache,
  Effect.gen(function* () {
    return makeRuntimeCliCache(yield* HttpClient.HttpClient, yield* RuntimeCliCacheBucket);
  }),
);

export const makeRuntimeCliCacheForServices = makeRuntimeCliCache;

type FixedLengthStreamFactory = (length: number) => {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<ArrayBuffer | ArrayBufferView>;
};

type DigestStreamLike = WritableStream<ArrayBuffer | ArrayBufferView> & {
  readonly digest: Promise<ArrayBuffer>;
};

type DigestStreamFactory = () => DigestStreamLike;

const r2Object = (object: R2Object): RuntimeCliCacheObject => ({
  key: object.key,
  size: object.size,
  contentType: object.httpMetadata?.contentType,
  sha256:
    object.checksums.sha256 === undefined
      ? undefined
      : new Uint8Array(object.checksums.sha256.slice(0)),
  customMetadata: { ...object.customMetadata },
});

/** Native Worker adapter. R2 owns atomic publication and verifies the supplied SHA-256. */
export const r2RuntimeCliCacheBucket = (
  bucket: {
    head: R2Bucket["head"];
    put: (
      key: string,
      value: ReadableStream<Uint8Array>,
      options: R2PutOptions & { onlyIf: R2Conditional },
    ) => Promise<R2Object | null>;
  },
  fixedLength: FixedLengthStreamFactory = (length) => new FixedLengthStream(length),
  digestStream: DigestStreamFactory = () => new crypto.DigestStream("SHA-256"),
): RuntimeCliCacheBucketShape => ({
  head: (key) =>
    Effect.tryPromise({
      try: () => bucket.head(key),
      catch: () => new RuntimeCliCacheBucketFailure({ operation: "head", reason: "transport" }),
    }).pipe(Effect.map((object) => (object === null ? undefined : r2Object(object)))),
  publish: (input) =>
    Effect.gen(function* () {
      const reader = input.source.getReader();
      const fixed = fixedLength(input.byteSize);
      const writer = fixed.writable.getWriter();
      const digest = digestStream();
      const hasher = digest.getWriter();
      let verified = false;
      let terminal: RuntimeCliCacheBucketFailure | undefined;
      const fail = (reason: "source" | "length" | "integrity", actualLength?: number) => {
        terminal ??= new RuntimeCliCacheBucketFailure({ operation: "put", reason, actualLength });
        return terminal;
      };
      const storageFailure = () =>
        terminal ??
        new RuntimeCliCacheBucketFailure({
          operation: "put",
          reason: verified ? "ambiguous" : "incomplete",
        });
      // Native put has no AbortSignal. Attach observers immediately, including to DigestStream
      // (abort rejects its digest promise). These observers also own late settlement after exit.
      const upload = Promise.resolve().then(() =>
        bucket.put(input.key, fixed.readable, {
          onlyIf: { etagDoesNotMatch: "*" },
          sha256: input.sha256,
          httpMetadata: { contentType: CONTENT_TYPE },
          customMetadata: { ...input.customMetadata },
        }),
      );
      void Promise.allSettled([upload, digest.digest, reader.closed, writer.closed, hasher.closed]);
      const uploaded = Effect.tryPromise({ try: () => upload, catch: storageFailure });
      const sourceFailure = Effect.tryPromise({
        try: () => reader.closed,
        catch: () => fail("source"),
      }).pipe(Effect.andThen(Effect.never));
      const digestFailure = Effect.tryPromise({
        try: () => digest.digest,
        catch: () => fail("source"),
      }).pipe(Effect.andThen(Effect.never));
      const pump = Effect.gen(function* () {
        let bytes = 0;
        for (;;) {
          const next = yield* Effect.tryPromise({
            try: () => reader.read(),
            catch: () => fail("source"),
          });
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > input.byteSize) return yield* fail("length", bytes);
          // No tee: one chunk in flight, and neither sink can outrun the other.
          yield* Effect.all(
            [
              Effect.tryPromise({ try: () => writer.write(next.value), catch: storageFailure }),
              Effect.tryPromise({
                try: () => hasher.write(next.value),
                catch: () => fail("source"),
              }),
            ],
            { concurrency: "unbounded" },
          );
        }
        if (bytes !== input.byteSize) return yield* fail("length", bytes);
        yield* Effect.tryPromise({ try: () => hasher.close(), catch: () => fail("source") });
        const hash = yield* Effect.tryPromise({
          try: () => digest.digest,
          catch: () => fail("source"),
        });
        if (encodeHex(hash) !== input.sha256) return yield* fail("integrity");
        verified = true;
        // Do not signal EOF to R2 until local verification has succeeded. R2 still applies its
        // own checksum gate atomically with the create-only condition.
        yield* Effect.tryPromise({ try: () => writer.close(), catch: storageFailure });
        return yield* uploaded;
      });
      // Early conditional null/rejection must not wait for an unconsumed fixed-length stream.
      // Only a *verified* ambiguous mutation can be reconciled; incomplete uploads cannot be
      // promoted to success by an unrelated winner. Already-observed source/integrity errors win.
      const earlySettlement = uploaded.pipe(
        Effect.flatMap((object) =>
          terminal !== undefined
            ? Effect.fail(terminal)
            : object === null
              ? Effect.succeed(null)
              : Effect.never,
        ),
      );
      return yield* pump.pipe(
        Effect.raceFirst(earlySettlement),
        Effect.raceFirst(sourceFailure),
        Effect.raceFirst(digestFailure),
        Effect.timeoutOrElse({
          duration: PUBLISH_TIMEOUT,
          orElse: () => Effect.fail(storageFailure()),
        }),
        Effect.map((object) => (object === null ? null : r2Object(object))),
        Effect.ensuring(
          Effect.sync(() => {
            // Initiate cancellation, but do not wait for uncancelable provider mutation or a
            // hostile source's cancel hook. All rejection/late-settlement paths are observed.
            // This is bounded cleanup, not a claim that R2 put has been canceled.
            void Promise.allSettled([
              reader.cancel(),
              writer.abort(),
              hasher.abort(),
              upload,
              digest.digest,
            ]);
            reader.releaseLock();
            writer.releaseLock();
            hasher.releaseLock();
          }),
        ),
      );
    }),
});
