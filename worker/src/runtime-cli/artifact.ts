import { Data, Effect } from "effect";
import type { RuntimeCliArtifactDescriptor } from "../../../protocol/runtime-cli-manifest";
import { runtimeCliCacheObjectKey } from "./cache";

export class RuntimeCliArtifactFailure extends Data.TaggedError("RuntimeCliArtifactFailure")<{
  readonly reason: "missing_artifact" | "artifact_integrity" | "storage";
}> {}

export type RuntimeCliArtifactBucket = {
  readonly get: (
    key: string,
  ) => Promise<Pick<
    R2ObjectBody,
    "body" | "size" | "checksums" | "httpMetadata" | "customMetadata"
  > | null>;
};

/** Exact immutable bytes only. No lookup/download/repair occurs on this read path. */
export const readRuntimeCliArtifact = Effect.fnUntraced(function* (
  bucket: RuntimeCliArtifactBucket,
  descriptor: RuntimeCliArtifactDescriptor,
) {
  const artifact = descriptor.artifact;
  const object = yield* Effect.tryPromise({
    try: () => bucket.get(runtimeCliCacheObjectKey(artifact.sha256)),
    catch: () => new RuntimeCliArtifactFailure({ reason: "storage" }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: "30 seconds",
      orElse: () => Effect.fail(new RuntimeCliArtifactFailure({ reason: "storage" })),
    }),
  );
  if (object === null) return yield* new RuntimeCliArtifactFailure({ reason: "missing_artifact" });
  const digest = object.checksums.sha256;
  const hex =
    digest === undefined
      ? ""
      : Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (
    object.size !== artifact.byteSize ||
    hex !== artifact.sha256 ||
    object.httpMetadata?.contentType !== "application/octet-stream" ||
    object.customMetadata?.["scotty-runtime-cache-schema"] !== "1" ||
    object.customMetadata?.["scotty-runtime-byte-sha256"] !== artifact.sha256 ||
    object.customMetadata?.["scotty-runtime-byte-size"] !== String(artifact.byteSize) ||
    object.customMetadata?.["scotty-runtime-artifact-name"] !== artifact.name
  ) {
    yield* Effect.tryPromise({
      try: () => object.body.cancel(),
      catch: () => new RuntimeCliArtifactFailure({ reason: "storage" }),
    }).pipe(Effect.ignore);
    return yield* new RuntimeCliArtifactFailure({ reason: "artifact_integrity" });
  }
  return object.body;
});
