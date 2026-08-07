import { Context, Effect, Layer, Option, Result } from "effect";
import {
  EVIDENCE_MAX_FRAME_BYTES,
  EvidenceArtifactError,
  artifactExpiry,
  decodeEvidenceIdentifier,
  evidenceArtifactObjectKey,
  type EvidenceArtifactV1,
} from "./evidence-contracts";
import { sha256BytesHex } from "./digest";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const ARTIFACT_MEDIA_TYPE = "image/png" as const;

export interface ArtifactObjectMetadata {
  readonly key: string;
  readonly size: number;
  readonly contentType: string | undefined;
  readonly customMetadata: Readonly<Record<string, string>>;
}

export interface ArtifactObjectBody extends ArtifactObjectMetadata {
  readonly body: ReadableStream<Uint8Array>;
}

export interface ArtifactStoreCapabilities {
  readonly put: (
    key: string,
    bytes: Uint8Array,
    metadata: {
      readonly contentType: typeof ARTIFACT_MEDIA_TYPE;
      readonly customMetadata: Readonly<Record<string, string>>;
    },
  ) => Promise<void>;
  readonly head: (key: string) => Promise<ArtifactObjectMetadata | undefined>;
  readonly get: (key: string) => Promise<ArtifactObjectBody | undefined>;
  readonly delete: (key: string) => Promise<void>;
}

export interface PutEvidenceFrameInput {
  readonly sessionId: string;
  readonly jobId: string;
  readonly frameId: string;
  readonly bytes: Uint8Array;
  readonly capturedAt: string;
  readonly offsetMillis: number;
}

export interface OpenEvidenceFrame {
  readonly body: ReadableStream<Uint8Array>;
  readonly bytes: number;
  readonly mediaType: typeof ARTIFACT_MEDIA_TYPE;
  readonly sha256: string;
}

interface PutEvidenceFrameAttempt {
  readonly artifact: EvidenceArtifactV1;
  readonly stored: Result.Result<void, EvidenceArtifactError>;
}

interface ArtifactStoreShape {
  readonly putFrame: (
    input: PutEvidenceFrameInput,
  ) => Effect.Effect<EvidenceArtifactV1, EvidenceArtifactError>;
  readonly putFrameAttempt: (
    input: PutEvidenceFrameInput,
  ) => Effect.Effect<PutEvidenceFrameAttempt, EvidenceArtifactError>;
  readonly openFrame: (
    artifact: EvidenceArtifactV1,
  ) => Effect.Effect<OpenEvidenceFrame, EvidenceArtifactError>;
  readonly deleteFrame: (
    artifact: EvidenceArtifactV1,
  ) => Effect.Effect<void, EvidenceArtifactError>;
}

export class ArtifactStore extends Context.Service<ArtifactStore, ArtifactStoreShape>()(
  "scotty/ArtifactStore",
) {}

const validPng = (bytes: Uint8Array): boolean =>
  bytes.length >= 24 &&
  PNG_SIGNATURE.every((value, index) => bytes[index] === value) &&
  bytes[12] === 73 &&
  bytes[13] === 72 &&
  bytes[14] === 68 &&
  bytes[15] === 82;

const expectedMetadata = (
  input: PutEvidenceFrameInput,
  sha256: string,
): Readonly<Record<string, string>> => ({
  owner: input.sessionId,
  job: input.jobId,
  frame: input.frameId,
  sha256,
});

const canonicalArtifact = (artifact: EvidenceArtifactV1): boolean =>
  artifact.objectKey === evidenceArtifactObjectKey(artifact);

const validPublicationInput = (input: PutEvidenceFrameInput): boolean =>
  Option.isSome(decodeEvidenceIdentifier(input.sessionId)) &&
  Option.isSome(decodeEvidenceIdentifier(input.jobId)) &&
  Option.isSome(decodeEvidenceIdentifier(input.frameId)) &&
  Number.isSafeInteger(input.offsetMillis) &&
  input.offsetMillis >= 0 &&
  Number.isFinite(Date.parse(input.capturedAt));

const metadataMatches = (
  metadata: ArtifactObjectMetadata | undefined,
  expected: {
    readonly key: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly sessionId: string;
    readonly jobId: string;
    readonly frameId: string;
  },
): boolean =>
  metadata !== undefined &&
  metadata.key === expected.key &&
  metadata.size === expected.bytes &&
  metadata.contentType === ARTIFACT_MEDIA_TYPE &&
  metadata.customMetadata.owner === expected.sessionId &&
  metadata.customMetadata.job === expected.jobId &&
  metadata.customMetadata.frame === expected.frameId &&
  metadata.customMetadata.sha256 === expected.sha256;

export const artifactStoreLayer = (
  capabilities: ArtifactStoreCapabilities,
): Layer.Layer<ArtifactStore> => Layer.succeed(ArtifactStore)(makeArtifactStore(capabilities));

const makeArtifactStore = (capabilities: ArtifactStoreCapabilities): ArtifactStoreShape => {
  const putFrameAttempt = Effect.fnUntraced(function* (input: PutEvidenceFrameInput) {
    if (!validPublicationInput(input))
      return yield* new EvidenceArtifactError({ operation: "validate", reason: "invalid_state" });
    if (!validPng(input.bytes))
      return yield* new EvidenceArtifactError({
        operation: "validate",
        reason: "invalid_png",
      });
    if (input.bytes.byteLength > EVIDENCE_MAX_FRAME_BYTES)
      return yield* new EvidenceArtifactError({
        operation: "validate",
        reason: "over_budget",
      });
    const sha256 = yield* Effect.tryPromise({
      try: () => sha256BytesHex(input.bytes),
      catch: (cause) => new EvidenceArtifactError({ operation: "hash", reason: "upstream", cause }),
    });
    const key = evidenceArtifactObjectKey(input);
    const customMetadata = expectedMetadata(input, sha256);
    const putResult = yield* Effect.result(
      Effect.tryPromise({
        try: () =>
          capabilities.put(key, input.bytes, {
            contentType: ARTIFACT_MEDIA_TYPE,
            customMetadata,
          }),
        catch: (cause) =>
          new EvidenceArtifactError({ operation: "put", reason: "put_unknown", cause }),
      }),
    );
    const headResult = yield* Effect.result(
      Effect.tryPromise({
        try: () => capabilities.head(key),
        catch: (cause) =>
          new EvidenceArtifactError({ operation: "head", reason: "upstream", cause }),
      }),
    );
    const artifact: EvidenceArtifactV1 = {
      version: 1,
      sessionId: input.sessionId,
      jobId: input.jobId,
      frameId: input.frameId,
      objectKey: key,
      mediaType: ARTIFACT_MEDIA_TYPE,
      sha256,
      bytes: input.bytes.byteLength,
      capturedAt: input.capturedAt,
      offsetMillis: input.offsetMillis,
      expiresAt: artifactExpiry(Date.parse(input.capturedAt)),
      status: "available",
    };
    const expected = {
      key,
      bytes: artifact.bytes,
      sha256,
      sessionId: input.sessionId,
      jobId: input.jobId,
      frameId: input.frameId,
    };
    if (Result.isFailure(headResult))
      return {
        artifact,
        stored: Result.fail(
          Result.isFailure(putResult)
            ? putResult.failure
            : new EvidenceArtifactError({
                operation: "head",
                reason: "put_unknown",
                cause: headResult.failure,
              }),
        ),
      };
    if (!metadataMatches(headResult.success, expected))
      return {
        artifact,
        stored: Result.fail(
          Result.isFailure(putResult)
            ? putResult.failure
            : new EvidenceArtifactError({
                operation: "head",
                reason: headResult.success === undefined ? "put_unknown" : "metadata_mismatch",
              }),
        ),
      };
    return { artifact, stored: Result.succeed(undefined) };
  });

  return {
    putFrame: Effect.fnUntraced(function* (input) {
      const attempt = yield* putFrameAttempt(input);
      if (Result.isFailure(attempt.stored)) return yield* attempt.stored.failure;
      return attempt.artifact;
    }),
    putFrameAttempt,
    openFrame: Effect.fnUntraced(function* (artifact) {
      if (artifact.status !== "available" || !canonicalArtifact(artifact))
        return yield* new EvidenceArtifactError({ operation: "open", reason: "invalid_state" });
      const key = evidenceArtifactObjectKey(artifact);
      const body = yield* Effect.tryPromise({
        try: () => capabilities.get(key),
        catch: (cause) =>
          new EvidenceArtifactError({ operation: "open", reason: "upstream", cause }),
      });
      if (body === undefined)
        return yield* new EvidenceArtifactError({ operation: "open", reason: "missing" });
      if (
        !metadataMatches(body, {
          key,
          bytes: artifact.bytes,
          sha256: artifact.sha256,
          sessionId: artifact.sessionId,
          jobId: artifact.jobId,
          frameId: artifact.frameId,
        })
      )
        return yield* new EvidenceArtifactError({
          operation: "open",
          reason: "metadata_mismatch",
        });
      return {
        body: body.body,
        bytes: body.size,
        mediaType: ARTIFACT_MEDIA_TYPE,
        sha256: artifact.sha256,
      };
    }),
    deleteFrame: Effect.fnUntraced(function* (artifact) {
      if (artifact.status !== "delete_pending" || !canonicalArtifact(artifact))
        return yield* new EvidenceArtifactError({ operation: "delete", reason: "invalid_state" });
      const key = evidenceArtifactObjectKey(artifact);
      yield* Effect.tryPromise({
        try: () => capabilities.delete(key),
        catch: (cause) =>
          new EvidenceArtifactError({ operation: "delete", reason: "upstream", cause }),
      });
      const remaining = yield* Effect.tryPromise({
        try: () => capabilities.head(key),
        catch: (cause) =>
          new EvidenceArtifactError({ operation: "head", reason: "upstream", cause }),
      });
      if (remaining !== undefined)
        return yield* new EvidenceArtifactError({ operation: "delete", reason: "upstream" });
    }),
  };
};

const r2Metadata = (object: R2Object): ArtifactObjectMetadata => ({
  key: object.key,
  size: object.size,
  contentType: object.httpMetadata?.contentType,
  customMetadata: object.customMetadata ?? {},
});

export const r2ArtifactStoreCapabilities = (bucket: R2Bucket): ArtifactStoreCapabilities => ({
  put: (key, bytes, metadata) =>
    bucket
      .put(key, bytes, {
        httpMetadata: { contentType: metadata.contentType },
        customMetadata: { ...metadata.customMetadata },
      })
      .then(() => undefined),
  head: (key) =>
    bucket.head(key).then((object) => (object === null ? undefined : r2Metadata(object))),
  get: (key) =>
    bucket.get(key).then((object) =>
      object === null
        ? undefined
        : {
            ...r2Metadata(object),
            body: object.body as ReadableStream<Uint8Array>,
          },
    ),
  delete: (key) => bucket.delete(key),
});
