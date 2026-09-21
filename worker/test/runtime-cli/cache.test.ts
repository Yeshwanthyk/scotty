import { assert, describe, it } from "@effect/vitest";
import { createHash } from "node:crypto";
import {
  RUNTIME_CLI_ASSET_NAME,
  type RuntimeCliArtifactDescriptor,
} from "../../../protocol/runtime/runtime-cli-manifest";
import { Effect, Fiber, Predicate, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import {
  makeRuntimeCliCacheForServices,
  r2RuntimeCliCacheBucket,
  runtimeCliCacheObjectKey,
  RuntimeCliCacheBucketFailure,
  type RuntimeCliCacheError,
  type RuntimeCliCacheIntegrityError,
  type RuntimeCliCacheObject,
  type RuntimeCliCacheLengthError,
} from "../../src/runtime-cli/cache";
import type { ResolvedRuntimeCliRelease } from "../../src/runtime-cli/release-resolver";

const bytes = new TextEncoder().encode("streamed runtime executable");
const digest = createHash("sha256").update(bytes).digest("hex");
const downloadUrl = `https://github.com/Yeshwanthyk/scotty/releases/download/v1.2.3/${RUNTIME_CLI_ASSET_NAME}`;

const descriptor = (
  patch: Partial<RuntimeCliArtifactDescriptor["artifact"]> = {},
): RuntimeCliArtifactDescriptor => ({
  schemaVersion: 1,
  releaseTag: "v1.2.3",
  artifact: {
    name: RUNTIME_CLI_ASSET_NAME,
    cliVersion: "1.2.3",
    revision: "a".repeat(40),
    target: "linux/amd64",
    byteSize: bytes.byteLength,
    sha256: digest,
    installMode: "0755",
    ...patch,
  },
  compatibility: {
    bunVersion: "1.3.13",
    compileTarget: "bun-linux-x64-baseline",
    cpu: "x86-64-baseline",
    libc: "glibc",
    cloudflareSandbox: {
      packageVersion: "0.12.9",
      image:
        "docker.io/cloudflare/sandbox:0.12.9@sha256:4a56a37a3cfd9b38d65bb4b5d0b341e6490a3a4c0226274ae4c1cca4948e85fe",
    },
  },
});

const release = (value = descriptor()): ResolvedRuntimeCliRelease => ({
  releaseId: 42,
  releaseTag: value.releaseTag,
  artifactDownloadUrl: downloadUrl,
  descriptor: value,
});

const metadata = (value = release()): RuntimeCliCacheObject => ({
  key: runtimeCliCacheObjectKey(value.descriptor.artifact.sha256),
  size: value.descriptor.artifact.byteSize,
  contentType: "application/octet-stream",
  sha256: Uint8Array.from(Buffer.from(value.descriptor.artifact.sha256, "hex")),
  customMetadata: {
    "scotty-runtime-cache-schema": "1",
    "scotty-runtime-byte-sha256": value.descriptor.artifact.sha256,
    "scotty-runtime-byte-size": String(value.descriptor.artifact.byteSize),
    "scotty-runtime-artifact-name": RUNTIME_CLI_ASSET_NAME,
  },
});

type Route = Response | "transport";

const client = (
  routes: ReadonlyMap<string, Route>,
  requests: HttpClientRequest.HttpClientRequest[],
) =>
  HttpClient.make((request) => {
    requests.push(request);
    const route = routes.get(request.url);
    if (route === undefined || route === "transport")
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, cause: "offline" }),
        }),
      );
    return Effect.succeed(HttpClientResponse.fromWeb(request, route));
  });

const failure = (result: Result.Result<unknown, RuntimeCliCacheError>): RuntimeCliCacheError =>
  Result.match(result, {
    onFailure: (error) => error,
    onSuccess: () => assert.fail("expected cache failure"),
  });

const lengthFailure = (result: Result.Result<unknown, RuntimeCliCacheError>) => {
  const error = failure(result);
  assert.isTrue(Predicate.isTagged("RuntimeCliCacheLengthError")(error));
  return error as RuntimeCliCacheLengthError;
};

const integrityFailure = (result: Result.Result<unknown, RuntimeCliCacheError>) => {
  const error = failure(result);
  assert.isTrue(Predicate.isTagged("RuntimeCliCacheIntegrityError")(error));
  return error as RuntimeCliCacheIntegrityError;
};

const noObject = { head: () => Effect.succeed(undefined) };

const fakeDigestStream = () => {
  const hash = createHash("sha256");
  let resolveDigest: (value: ArrayBuffer) => void = () => undefined;
  let rejectDigest: (reason: unknown) => void = () => undefined;
  const digest = new Promise<ArrayBuffer>((resolve, reject) => {
    resolveDigest = resolve;
    rejectDigest = reject;
  });
  const writable = new WritableStream<ArrayBuffer | ArrayBufferView>({
    write(chunk) {
      hash.update(
        chunk instanceof ArrayBuffer
          ? new Uint8Array(chunk)
          : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      );
    },
    abort(reason) {
      rejectDigest(reason);
    },
    close() {
      const value = Uint8Array.from(hash.digest());
      resolveDigest(value.buffer);
    },
  });
  Object.defineProperty(writable, "digest", { value: digest });
  return writable as WritableStream<ArrayBuffer | ArrayBufferView> & {
    readonly digest: Promise<ArrayBuffer>;
  };
};

const fixedLengthStream = (length: number) => {
  let received = 0;
  const stream = new TransformStream<ArrayBuffer | ArrayBufferView, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > length) throw new RangeError("fixed-length overflow");
      controller.enqueue(
        chunk instanceof ArrayBuffer
          ? new Uint8Array(chunk)
          : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      );
    },
    flush() {
      if (received !== length) throw new RangeError("fixed-length underflow");
    },
  });
  return stream;
};

const r2Object = (input: {
  readonly key: string;
  readonly body: Uint8Array;
  readonly sha256?: string;
  readonly contentType?: string;
  readonly customMetadata?: Record<string, string>;
}): R2Object => ({
  key: input.key,
  version: "version",
  size: input.body.byteLength,
  etag: "etag",
  httpEtag: '"etag"',
  checksums: {
    sha256:
      input.sha256 === undefined
        ? undefined
        : Uint8Array.from(Buffer.from(input.sha256, "hex")).buffer,
    toJSON: () => (input.sha256 === undefined ? {} : { sha256: input.sha256 }),
  },
  uploaded: new Date(0),
  httpMetadata: { contentType: input.contentType },
  customMetadata: input.customMetadata,
  storageClass: "Standard",
  writeHttpMetadata: () => undefined,
});

const nativeBucket = (options: {
  readonly existing?: R2Object;
  readonly seen: Array<{
    readonly key: string;
    readonly options?: R2PutOptions;
    readonly chunks: number;
  }>;
}): Parameters<typeof r2RuntimeCliCacheBucket>[0] => ({
  head: () => Effect.runPromise(Effect.succeed(options.existing ?? null)),
  put: async (key, value, putOptions) => {
    assert.instanceOf(value, ReadableStream);
    const stream = value as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    const body = Uint8Array.from(chunks.flatMap((chunk) => [...chunk]));
    options.seen.push({ key, options: putOptions, chunks: chunks.length });
    const actual = createHash("sha256").update(body).digest("hex");
    assert.strictEqual(actual, putOptions?.sha256);
    return r2Object({
      key,
      body,
      sha256: actual,
      contentType:
        putOptions?.httpMetadata instanceof Headers
          ? (putOptions.httpMetadata.get("content-type") ?? undefined)
          : putOptions?.httpMetadata?.contentType,
      customMetadata: putOptions?.customMetadata,
    });
  },
});

describe("RuntimeCliCache", () => {
  it.effect(
    "streams a verified publication and returns a shallow-frozen handle without a body",
    () =>
      Effect.gen(function* () {
        const requests: HttpClientRequest.HttpClientRequest[] = [];
        const seen: Array<{
          readonly key: string;
          readonly options?: R2PutOptions;
          readonly chunks: number;
        }> = [];
        let fixedLength = 0;
        const bucket = r2RuntimeCliCacheBucket(
          nativeBucket({ seen }),
          (length) => {
            fixedLength = length;
            return fixedLengthStream(length);
          },
          fakeDigestStream,
        );
        const response = new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.slice(0, 8));
              controller.enqueue(bytes.slice(8));
              controller.close();
            },
          }),
        );
        const cache = makeRuntimeCliCacheForServices(
          client(new Map([[downloadUrl, response]]), requests),
          bucket,
        );

        const result = yield* cache.ensure(release());

        assert.deepStrictEqual(result, {
          key: runtimeCliCacheObjectKey(digest),
          byteSize: bytes.byteLength,
          sha256: digest,
          release: release(),
        });
        assert.isTrue(Object.isFrozen(result));
        assert.notProperty(result, "body");
        assert.strictEqual(fixedLength, bytes.byteLength);
        assert.isAtLeast(seen[0]?.chunks ?? 0, 2);
        assert.deepStrictEqual(seen[0]?.options?.onlyIf, { etagDoesNotMatch: "*" });
        assert.strictEqual(seen[0]?.options?.sha256, digest);
        assert.deepStrictEqual(seen[0]?.options?.httpMetadata, {
          contentType: "application/octet-stream",
        });
        assert.deepStrictEqual(seen[0]?.options?.customMetadata, metadata().customMetadata);
        assert.strictEqual(requests[0]?.headers["accept-encoding"], "identity");
        assert.strictEqual(requests[0]?.headers.authorization, undefined);
      }),
  );

  for (const [label, body, reason] of [
    ["short", bytes.slice(0, -1), "short"],
    ["long", Uint8Array.from([...bytes, 0]), "long"],
  ] as const) {
    it.effect(`rejects a ${label} source`, () =>
      Effect.gen(function* () {
        const requests: HttpClientRequest.HttpClientRequest[] = [];
        const seen: Array<{
          readonly key: string;
          readonly options?: R2PutOptions;
          readonly chunks: number;
        }> = [];
        const cache = makeRuntimeCliCacheForServices(
          client(new Map([[downloadUrl, new Response(body)]]), requests),
          r2RuntimeCliCacheBucket(nativeBucket({ seen }), fixedLengthStream, fakeDigestStream),
        );

        const error = lengthFailure(yield* Effect.result(cache.ensure(release())));
        assert.strictEqual(error.reason, reason);
      }),
    );
  }

  it.effect("rejects a bad digest through streaming verification", () =>
    Effect.gen(function* () {
      const bad = release(descriptor({ sha256: "0".repeat(64) }));
      const requests: HttpClientRequest.HttpClientRequest[] = [];
      const seen: Array<{
        readonly key: string;
        readonly options?: R2PutOptions;
        readonly chunks: number;
      }> = [];
      const cache = makeRuntimeCliCacheForServices(
        client(new Map([[downloadUrl, new Response(bytes)]]), requests),
        r2RuntimeCliCacheBucket(nativeBucket({ seen }), fixedLengthStream, fakeDigestStream),
      );

      const error = integrityFailure(yield* Effect.result(cache.ensure(bad)));
      assert.strictEqual(error.reason, "digest_mismatch");
    }),
  );

  it.effect("rejects a cache hit without a native SHA-256 and never publishes", () =>
    Effect.gen(function* () {
      let publications = 0;
      const object = { ...metadata(), sha256: undefined };
      const cache = makeRuntimeCliCacheForServices(client(new Map(), []), {
        head: () => Effect.succeed(object),
        publish: () => {
          publications += 1;
          return Effect.succeed(null);
        },
      });
      const error = failure(yield* Effect.result(cache.ensure(release())));
      assert.isTrue(Predicate.isTagged("RuntimeCliCacheIntegrityError")(error));
      assert.strictEqual(publications, 0);
    }),
  );

  it.effect("accepts a concurrent conditional loser after a verified head", () =>
    Effect.gen(function* () {
      let heads = 0;
      const cache = makeRuntimeCliCacheForServices(
        client(new Map([[downloadUrl, new Response(bytes)]]), []),
        {
          head: () => Effect.succeed(heads++ === 0 ? undefined : metadata()),
          publish: () => Effect.succeed(null),
        },
      );
      assert.strictEqual((yield* cache.ensure(release())).sha256, digest);
      assert.strictEqual(heads, 2);
    }),
  );

  it.effect("reports storage ambiguity when a rejected put has no observable winner", () =>
    Effect.gen(function* () {
      let heads = 0;
      const cache = makeRuntimeCliCacheForServices(
        client(new Map([[downloadUrl, new Response(bytes)]]), []),
        {
          head: () => {
            heads += 1;
            return Effect.succeed(undefined);
          },
          publish: () =>
            Effect.fail(
              new RuntimeCliCacheBucketFailure({
                operation: "put",
                reason: "ambiguous",
              }),
            ),
        },
      );
      const error = failure(yield* Effect.result(cache.ensure(release())));
      assert.isTrue(Predicate.isTagged("RuntimeCliCacheStorageAmbiguityError")(error));
      assert.strictEqual(heads, 4);
    }),
  );

  it.effect("reconciles a rejected ambiguous put with a verified winner", () =>
    Effect.gen(function* () {
      let heads = 0;
      const cache = makeRuntimeCliCacheForServices(
        client(new Map([[downloadUrl, new Response(bytes)]]), []),
        {
          head: () => Effect.succeed(heads++ === 0 ? undefined : metadata()),
          publish: () =>
            Effect.fail(
              new RuntimeCliCacheBucketFailure({
                operation: "put",
                reason: "ambiguous",
              }),
            ),
        },
      );
      assert.strictEqual((yield* cache.ensure(release())).key, runtimeCliCacheObjectKey(digest));
    }),
  );

  it.effect("preserves a conflicting object without publishing or deleting it", () =>
    Effect.gen(function* () {
      let publications = 0;
      const cache = makeRuntimeCliCacheForServices(client(new Map(), []), {
        head: () => Effect.succeed({ ...metadata(), size: bytes.byteLength + 1 }),
        publish: () => {
          publications += 1;
          return Effect.succeed(null);
        },
      });
      const error = failure(yield* Effect.result(cache.ensure(release())));
      assert.isTrue(Predicate.isTagged("RuntimeCliCacheConflictError")(error));
      assert.strictEqual(publications, 0);
    }),
  );

  it.effect("keeps release provenance on the handle while sharing byte identity", () =>
    Effect.gen(function* () {
      const otherDescriptor = {
        ...descriptor(),
        releaseTag: "v1.2.4",
        artifact: {
          ...descriptor().artifact,
          cliVersion: "1.2.4",
          revision: "b".repeat(40),
        },
      } satisfies RuntimeCliArtifactDescriptor;
      const other: ResolvedRuntimeCliRelease = {
        ...release(otherDescriptor),
        releaseTag: "v1.2.4",
        artifactDownloadUrl: `https://github.com/Yeshwanthyk/scotty/releases/download/v1.2.4/${RUNTIME_CLI_ASSET_NAME}`,
      };
      const cache = makeRuntimeCliCacheForServices(client(new Map(), []), {
        ...noObject,
        head: () => Effect.succeed(metadata(other)),
        publish: () => Effect.succeed(null),
      });
      const result = yield* cache.ensure(other);
      assert.strictEqual(result.release.descriptor.artifact.revision, "b".repeat(40));
      assert.strictEqual(result.sha256, digest);
    }),
  );

  it.effect(
    "follows only release-assets redirects and requires status 200 with identity encoding",
    () =>
      Effect.gen(function* () {
        const redirected =
          "https://release-assets.githubusercontent.com/github-production-release-asset/42/runtime?sig=x";
        const requests: HttpClientRequest.HttpClientRequest[] = [];
        const cache = makeRuntimeCliCacheForServices(
          client(
            new Map([
              [downloadUrl, new Response(null, { status: 302, headers: { location: redirected } })],
              [redirected, new Response(bytes)],
            ]),
            requests,
          ),
          {
            ...noObject,
            publish: () => Effect.succeed(metadata()),
          },
        );
        yield* cache.ensure(release());
        assert.deepStrictEqual(
          requests.map((request) => request.url),
          [downloadUrl, redirected],
        );

        const hostile = makeRuntimeCliCacheForServices(
          client(
            new Map([
              [
                downloadUrl,
                new Response(null, {
                  status: 302,
                  headers: { location: "https://attacker.example/runtime" },
                }),
              ],
            ]),
            [],
          ),
          { ...noObject, publish: () => Effect.succeed(metadata()) },
        );
        const error = failure(yield* Effect.result(hostile.ensure(release())));
        assert.isTrue(Predicate.isTagged("RuntimeCliCacheIntegrityError")(error));
      }),
  );

  it.effect("cancels the source when publication is interrupted", () =>
    Effect.gen(function* () {
      let cancellations = 0;
      let markUploadStarted: () => void = () => undefined;
      const uploadStarted = new Promise<void>((resolve) => {
        markUploadStarted = resolve;
      });
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(Uint8Array.of(1));
        },
        cancel() {
          cancellations += 1;
        },
      });
      const seen: Array<{
        readonly key: string;
        readonly options?: R2PutOptions;
        readonly chunks: number;
      }> = [];
      const bucket = nativeBucket({ seen });
      bucket.put = async (_key, value) => {
        assert.instanceOf(value, ReadableStream);
        const stream = value as ReadableStream<Uint8Array>;
        await stream.getReader().read();
        markUploadStarted();
        return await new Promise<R2Object>(() => undefined);
      };
      const adapter = r2RuntimeCliCacheBucket(bucket, fixedLengthStream, fakeDigestStream);
      const fiber = yield* adapter
        .publish({
          key: runtimeCliCacheObjectKey(digest),
          source,
          byteSize: bytes.byteLength,
          sha256: digest,
          customMetadata: metadata().customMetadata,
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => uploadStarted);
      yield* Fiber.interrupt(fiber);
      yield* Effect.promise(() => new Promise<void>((resolve) => queueMicrotask(resolve)));
      assert.strictEqual(cancellations, 1);
    }),
  );
});

const pending = <A>() => {
  let resolve: (value: A) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

// Flush native stream promise jobs, without advancing the Effect timeout clock.
const flushJobs = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

const publicationInput = (source: ReadableStream<Uint8Array>) => ({
  key: runtimeCliCacheObjectKey(digest),
  source,
  byteSize: bytes.byteLength,
  sha256: digest,
  customMetadata: metadata().customMetadata,
});

describe("cache streaming lifecycle", () => {
  it.effect("bounds read-ahead when R2 stalls and observes late rejection after interruption", () =>
    Effect.gen(function* () {
      let pulls = 0;
      let cancellations = 0;
      const late = pending<R2Object | null>();
      const bucket = nativeBucket({ seen: [] });
      bucket.put = () => late.promise;
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(Uint8Array.of(1));
        },
        cancel() {
          cancellations += 1;
          return new Promise<void>(() => undefined);
        },
      });
      const fiber = yield* r2RuntimeCliCacheBucket(bucket, fixedLengthStream, fakeDigestStream)
        .publish(publicationInput(source))
        .pipe(Effect.forkChild);
      yield* flushJobs;
      // One in-flight chunk plus the source's own default one-chunk queue, not the whole body.
      assert.isAtMost(pulls, 2);
      yield* Fiber.interrupt(fiber);
      assert.strictEqual(cancellations, 1);
      late.reject(new Error("late provider rejection"));
      yield* flushJobs;
    }),
  );

  it.effect("advances only with the slow consumer, then publishes", () =>
    Effect.gen(function* () {
      let pulls = 0;
      const started = pending<ReadableStreamDefaultReader<Uint8Array>>();
      const late = pending<R2Object | null>();
      const bucket = nativeBucket({ seen: [] });
      bucket.put = (_key, value) => {
        assert.instanceOf(value, ReadableStream);
        started.resolve((value as ReadableStream<Uint8Array>).getReader());
        return late.promise;
      };
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls === bytes.length) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.slice(pulls, ++pulls));
        },
      });
      const fiber = yield* r2RuntimeCliCacheBucket(bucket, fixedLengthStream, fakeDigestStream)
        .publish(publicationInput(source))
        .pipe(Effect.forkChild);
      const reader = yield* Effect.promise(() => started.promise);
      for (let consumed = 0; consumed < bytes.length; consumed += 1) {
        yield* flushJobs;
        assert.isAtMost(pulls, consumed + 2);
        const next = yield* Effect.promise(() => reader.read());
        assert.deepStrictEqual(next.value, bytes.slice(consumed, consumed + 1));
      }
      assert.isTrue((yield* Effect.promise(() => reader.read())).done);
      late.resolve(
        r2Object({ key: runtimeCliCacheObjectKey(digest), body: bytes, sha256: digest }),
      );
      assert.isNotNull(yield* Fiber.join(fiber));
    }),
  );

  for (const kind of ["digest", "short", "long", "source"] as const) {
    it.effect(`keeps ${kind} failure terminal with a hung put and a valid head winner`, () =>
      Effect.gen(function* () {
        let heads = 0;
        const late = pending<R2Object | null>();
        const bucket = nativeBucket({ seen: [] });
        bucket.head = async () =>
          heads++ === 0
            ? null
            : r2Object({
                key: metadata().key,
                body: bytes,
                sha256: digest,
                contentType: "application/octet-stream",
                customMetadata: { ...metadata().customMetadata },
              });
        bucket.put = (_key, value) => {
          assert.instanceOf(value, ReadableStream);
          const reader = (value as ReadableStream<Uint8Array>).getReader();
          // Consume but never settle put, including when local verification aborts the stream.
          const consume = async () => {
            while (!(await reader.read()).done) {
              /* drain */
            }
          };
          void consume().catch(() => undefined);
          return late.promise;
        };
        const body =
          kind === "short"
            ? bytes.slice(1)
            : kind === "long"
              ? new Uint8Array(bytes.length + 1)
              : bytes;
        const source =
          kind === "source"
            ? new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.error(new Error("source failed"));
                },
              })
            : body;
        const value =
          kind === "digest" ? release(descriptor({ sha256: "0".repeat(64) })) : release();
        const cache = makeRuntimeCliCacheForServices(
          client(new Map([[downloadUrl, new Response(source)]]), []),
          r2RuntimeCliCacheBucket(bucket, fixedLengthStream, fakeDigestStream),
        );
        const fiber = yield* Effect.result(cache.ensure(value)).pipe(Effect.forkChild);
        yield* flushJobs;
        // Completion must precede publication timeout, not merely survive reconciliation.
        assert.isDefined(fiber.pollUnsafe());
        yield* TestClock.adjust("17 minutes");
        const error = failure(yield* Fiber.join(fiber));
        assert.isTrue(
          Predicate.isTagged(
            kind === "digest"
              ? "RuntimeCliCacheIntegrityError"
              : kind === "source"
                ? "RuntimeCliCacheTransportError"
                : "RuntimeCliCacheLengthError",
          )(error),
        );
        assert.strictEqual(heads, 1);
        late.reject(new Error("late rejection"));
        yield* flushJobs;
      }),
    );
  }

  for (const outcome of ["null", "reject"] as const) {
    it.effect(`handles early put ${outcome} without waiting for a consumer`, () =>
      Effect.gen(function* () {
        let canceled = 0;
        const bucket = nativeBucket({ seen: [] });
        bucket.put = () =>
          outcome === "null" ? Promise.resolve(null) : Promise.reject(new Error("offline"));
        const source = new ReadableStream<Uint8Array>({
          cancel() {
            canceled += 1;
          },
        });
        const result = yield* Effect.result(
          r2RuntimeCliCacheBucket(bucket, fixedLengthStream, fakeDigestStream).publish(
            publicationInput(source),
          ),
        );
        assert.strictEqual(canceled, 1);
        assert.deepStrictEqual(
          Result.match(result, {
            onSuccess: (value) => (value === null ? "null" : "object"),
            onFailure: (error) => error.reason,
          }),
          outcome === "null" ? "null" : "incomplete",
        );
      }),
    );
  }

  it.effect("does not let early conditional null erase an already failed source", () =>
    Effect.gen(function* () {
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error("source aborted"));
        },
      });
      const bucket = nativeBucket({ seen: [] });
      bucket.put = async () => null;
      const result = yield* Effect.result(
        r2RuntimeCliCacheBucket(bucket, fixedLengthStream, fakeDigestStream).publish(
          publicationInput(source),
        ),
      );
      assert.strictEqual(
        Result.match(result, { onFailure: (e) => e.reason, onSuccess: () => "unexpected" }),
        "source",
      );
    }),
  );

  it.effect("observes a source error even while the fixed-length writer is stalled", () =>
    Effect.gen(function* () {
      let control: ReadableStreamDefaultController<Uint8Array> | undefined;
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          control = controller;
          controller.enqueue(bytes);
        },
      });
      const bucket = nativeBucket({ seen: [] });
      bucket.put = () => new Promise<R2Object | null>(() => undefined);
      const fiber = yield* Effect.result(
        r2RuntimeCliCacheBucket(bucket, fixedLengthStream, fakeDigestStream).publish(
          publicationInput(source),
        ),
      ).pipe(Effect.forkChild);
      yield* flushJobs;
      assert.isDefined(control);
      control?.error(new Error("upstream abort"));
      const result = yield* Fiber.join(fiber);
      assert.isTrue(Result.isFailure(result));
      assert.strictEqual(
        Result.match(result, { onFailure: (e) => e.reason, onSuccess: () => "unexpected" }),
        "source",
      );
    }),
  );

  for (const verified of [false, true]) {
    it.effect(
      `times out a ${verified ? "verified" : "incomplete"} upload without hiding late success`,
      () =>
        Effect.gen(function* () {
          const late = pending<R2Object | null>();
          const eof = pending<void>();
          let heads = 0;
          const bucket = nativeBucket({ seen: [] });
          bucket.head = async () =>
            heads++ === 0
              ? null
              : r2Object({
                  key: metadata().key,
                  body: bytes,
                  sha256: digest,
                  contentType: "application/octet-stream",
                  customMetadata: { ...metadata().customMetadata },
                });
          bucket.put = (_key, value) => {
            if (verified) {
              const consume = async () => {
                const reader = (value as ReadableStream<Uint8Array>).getReader();
                while (!(await reader.read()).done) {
                  /* drain */
                }
                eof.resolve();
              };
              void consume().catch(eof.reject);
            }
            return late.promise;
          };
          const cache = makeRuntimeCliCacheForServices(
            client(new Map([[downloadUrl, new Response(bytes)]]), []),
            r2RuntimeCliCacheBucket(bucket, fixedLengthStream, fakeDigestStream),
          );
          const fiber = yield* Effect.result(cache.ensure(release())).pipe(Effect.forkChild);
          if (verified) yield* Effect.promise(() => eof.promise);
          else yield* flushJobs;
          yield* TestClock.adjust("15 minutes");
          const result = yield* Fiber.join(fiber);
          assert.strictEqual(heads, verified ? 2 : 1);
          assert.strictEqual(Result.isSuccess(result), verified);
          assert.isTrue(
            Result.match(result, {
              onSuccess: (value) => value.sha256 === digest,
              onFailure: Predicate.isTagged("RuntimeCliCacheStorageAmbiguityError"),
            }),
          );
          late.resolve(r2Object({ key: metadata().key, body: bytes, sha256: digest }));
          yield* flushJobs;
        }),
    );
  }

  for (const stage of ["initial", "reconciliation"] as const) {
    it.effect(`bounds ${stage} head`, () =>
      Effect.gen(function* () {
        let heads = 0;
        const cache = makeRuntimeCliCacheForServices(
          client(new Map([[downloadUrl, new Response(bytes)]]), []),
          {
            head: () =>
              stage === "reconciliation" && heads++ === 0
                ? Effect.succeed(undefined)
                : Effect.never,
            publish: () => Effect.succeed(null),
          },
        );
        const fiber = yield* Effect.result(cache.ensure(release())).pipe(Effect.forkChild);
        yield* flushJobs;
        yield* TestClock.adjust("15 seconds");
        assert.isTrue(
          Predicate.isTagged("RuntimeCliCacheTransportError")(failure(yield* Fiber.join(fiber))),
        );
      }),
    );
  }

  for (const status of [201, 206, 300, 304, 305, 306, 400, 500, 200]) {
    it.effect(`rejects final status/encoding ${status} without draining a stalled body`, () =>
      Effect.gen(function* () {
        let pulls = 0;
        let canceled = 0;
        const body = new ReadableStream<Uint8Array>({
          pull() {
            pulls += 1;
            return new Promise<void>(() => undefined);
          },
          cancel() {
            canceled += 1;
            return new Promise<void>(() => undefined);
          },
        });
        const headers = {
          location: "https://release-assets.githubusercontent.com/file",
          "content-encoding": status === 200 ? "gzip" : "identity",
        };
        const response = new Response(status === 304 ? null : body, { status, headers });
        const requests: HttpClientRequest.HttpClientRequest[] = [];
        const cache = makeRuntimeCliCacheForServices(
          client(new Map([[downloadUrl, response]]), requests),
          {
            ...noObject,
            publish: () => Effect.succeed(metadata()),
          },
        );
        const result = yield* Effect.result(cache.ensure(release()));
        assert.isTrue(
          Predicate.isTagged(
            status === 200 ? "RuntimeCliCacheIntegrityError" : "RuntimeCliCacheTransportError",
          )(failure(result)),
        );
        assert.strictEqual(requests.length, 1);
        assert.isAtMost(pulls, 1);
        assert.strictEqual(canceled, status === 304 ? 0 : 1);
      }),
    );
  }

  for (const status of [301, 302, 303, 307, 308]) {
    it.effect(`cancels a stalled ${status} redirect body before following`, () =>
      Effect.gen(function* () {
        let canceled = 0;
        const target = "https://release-assets.githubusercontent.com/file";
        const body = new ReadableStream<Uint8Array>({
          cancel() {
            canceled += 1;
            return new Promise<void>(() => undefined);
          },
        });
        const requests: HttpClientRequest.HttpClientRequest[] = [];
        const cache = makeRuntimeCliCacheForServices(
          client(
            new Map([
              [downloadUrl, new Response(body, { status, headers: { location: target } })],
              [target, new Response(bytes, { headers: { "content-encoding": "identity" } })],
            ]),
            requests,
          ),
          { ...noObject, publish: () => Effect.succeed(metadata()) },
        );
        assert.strictEqual((yield* cache.ensure(release())).sha256, digest);
        assert.strictEqual(canceled, 1);
        assert.deepStrictEqual(
          requests.map((request) => request.url),
          [downloadUrl, target],
        );
      }),
    );
  }

  it.effect("observes DigestStream abort rejection even while upload is stalled", () =>
    Effect.gen(function* () {
      const digestStream = fakeDigestStream();
      const aborted = pending<void>();
      // Reject the digest independently of write/close, as native abort does.
      const failedDigest = pending<ArrayBuffer>();
      const hashing = new WritableStream<ArrayBuffer | ArrayBufferView>({
        write() {
          failedDigest.reject(new Error("digest aborted"));
          aborted.resolve();
        },
      });
      Object.defineProperty(hashing, "digest", { value: failedDigest.promise });
      // Also prove our normal fake rejects its digest on abort instead of leaving it pending.
      const fakeRejection = Effect.tryPromise({
        try: () => digestStream.digest,
        catch: () => "aborted",
      });
      const fakeFiber = yield* Effect.result(fakeRejection).pipe(Effect.forkChild);
      yield* flushJobs;
      yield* Effect.promise(() => digestStream.abort(new Error("abort")));
      assert.deepStrictEqual(yield* Fiber.join(fakeFiber), Result.fail("aborted"));
      const bucket = nativeBucket({ seen: [] });
      bucket.put = () => new Promise<R2Object | null>(() => undefined);
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
        },
      });
      const fiber = yield* Effect.result(
        r2RuntimeCliCacheBucket(
          bucket,
          fixedLengthStream,
          () => hashing as ReturnType<typeof fakeDigestStream>,
        ).publish(publicationInput(source)),
      ).pipe(Effect.forkChild);
      yield* Effect.promise(() => aborted.promise);
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(
        Result.match(result, { onFailure: (e) => e.reason, onSuccess: () => "unexpected" }),
        "source",
      );
    }),
  );

  it.effect("bounds a stalled initial HTTP request", () =>
    Effect.gen(function* () {
      const cache = makeRuntimeCliCacheForServices(
        HttpClient.make(() => Effect.never),
        {
          ...noObject,
          publish: () => Effect.die("must not publish"),
        },
      );
      const fiber = yield* Effect.result(cache.ensure(release())).pipe(Effect.forkChild);
      yield* flushJobs;
      yield* TestClock.adjust("15 seconds");
      assert.isTrue(
        Predicate.isTagged("RuntimeCliCacheTransportError")(failure(yield* Fiber.join(fiber))),
      );
    }),
  );

  for (const size of [5363466239, 5363466240, 5363466241]) {
    it.effect(`enforces the exact single-put boundary at ${size}`, () =>
      Effect.gen(function* () {
        let heads = 0;
        const value = release(descriptor({ byteSize: size }));
        const cache = makeRuntimeCliCacheForServices(client(new Map(), []), {
          head: () => {
            heads += 1;
            return Effect.succeed(metadata(value));
          },
          publish: () => Effect.die("must not publish"),
        });
        const result = yield* Effect.result(cache.ensure(value));
        assert.strictEqual(Result.isSuccess(result), size <= 5363466240);
        assert.strictEqual(heads, size <= 5363466240 ? 1 : 0);
        assert.strictEqual(
          Result.match(result, {
            onSuccess: () => undefined,
            onFailure: (error) =>
              Predicate.isTagged("RuntimeCliCacheUnsupportedError")(error)
                ? error.maximumByteSize
                : 0,
          }),
          size > 5363466240 ? 5363466240 : undefined,
        );
      }),
    );
  }
});
