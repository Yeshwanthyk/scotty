import { Context, Effect, Layer, Option, Result } from "effect";
import {
  EVIDENCE_MAX_FRAME_BYTES,
  EVIDENCE_MAX_VIDEO_BYTES,
  EvidenceArtifactError,
  artifactExpiry,
  decodeEvidenceIdentifier,
  evidenceArtifactObjectKey,
  type EvidenceArtifactV2,
} from "./evidence-contracts";
import { sha256BytesHex } from "./digest";

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;
const WEBM_SIGNATURE = [0x1a, 0x45, 0xdf, 0xa3] as const;
type ArtifactMediaType = EvidenceArtifactV2["mediaType"];

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
      readonly contentType: ArtifactMediaType;
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

export interface PutEvidenceVideoInput {
  readonly sessionId: string;
  readonly jobId: string;
  readonly artifactId: "recording";
  readonly bytes: Uint8Array;
  readonly capturedAt: string;
  readonly offsetMillis: number;
}

export interface OpenEvidenceFrame {
  readonly body: ReadableStream<Uint8Array>;
  readonly bytes: number;
  readonly mediaType: ArtifactMediaType;
  readonly sha256: string;
}

export interface PreparedEvidenceFrame {
  readonly artifact: EvidenceArtifactV2;
  readonly bytes: Uint8Array;
}

interface ArtifactStoreShape {
  readonly prepareFrame: (
    input: PutEvidenceFrameInput,
  ) => Effect.Effect<PreparedEvidenceFrame, EvidenceArtifactError>;
  readonly writeFrame: (
    prepared: PreparedEvidenceFrame,
  ) => Effect.Effect<EvidenceArtifactV2, EvidenceArtifactError>;
  readonly prepareVideo: (
    input: PutEvidenceVideoInput,
  ) => Effect.Effect<PreparedEvidenceFrame, EvidenceArtifactError>;
  readonly writeArtifact: (
    prepared: PreparedEvidenceFrame,
  ) => Effect.Effect<EvidenceArtifactV2, EvidenceArtifactError>;
  readonly openFrame: (
    artifact: EvidenceArtifactV2,
  ) => Effect.Effect<OpenEvidenceFrame, EvidenceArtifactError>;
  readonly openArtifact: (
    artifact: EvidenceArtifactV2,
  ) => Effect.Effect<OpenEvidenceFrame, EvidenceArtifactError>;
  readonly deleteFrame: (
    artifact: EvidenceArtifactV2,
  ) => Effect.Effect<void, EvidenceArtifactError>;
  readonly deleteArtifact: (
    artifact: EvidenceArtifactV2,
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

const validWebm = (bytes: Uint8Array): boolean =>
  bytes.length >= WEBM_SIGNATURE.length &&
  WEBM_SIGNATURE.every((value, index) => bytes[index] === value);

const expectedMetadata = (
  input: Pick<EvidenceArtifactV2, "sessionId" | "jobId" | "frameId">,
  sha256: string,
): Readonly<Record<string, string>> => ({
  owner: input.sessionId,
  job: input.jobId,
  frame: input.frameId,
  sha256,
});

const canonicalArtifact = (artifact: EvidenceArtifactV2): boolean =>
  artifact.objectKey === evidenceArtifactObjectKey(artifact);

const validPublicationInput = (input: {
  readonly sessionId: string;
  readonly jobId: string;
  readonly frameId: string;
  readonly offsetMillis: number;
  readonly capturedAt: string;
}): boolean =>
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
    readonly mediaType: ArtifactMediaType;
  },
): boolean =>
  metadata !== undefined &&
  metadata.key === expected.key &&
  metadata.size === expected.bytes &&
  metadata.contentType === expected.mediaType &&
  metadata.customMetadata.owner === expected.sessionId &&
  metadata.customMetadata.job === expected.jobId &&
  metadata.customMetadata.frame === expected.frameId &&
  metadata.customMetadata.sha256 === expected.sha256;

const reportArtifactStorageFailure = (operation: "put" | "head", cause: unknown): void => {
  console.error("Evidence artifact storage failed", { operation, cause });
};

const reportArtifactVerificationFailure = (reason: "missing" | "metadata_mismatch"): void => {
  console.error("Evidence artifact verification failed", { operation: "head", reason });
};

export const artifactStoreLayer = (
  capabilities: ArtifactStoreCapabilities,
): Layer.Layer<ArtifactStore> => Layer.succeed(ArtifactStore)(makeArtifactStore(capabilities));

const makeArtifactStore = (capabilities: ArtifactStoreCapabilities): ArtifactStoreShape => {
  const prepare = Effect.fnUntraced(function* (
    input: PutEvidenceFrameInput,
    mediaType: ArtifactMediaType,
  ) {
    if (!validPublicationInput(input))
      return yield* new EvidenceArtifactError({ operation: "validate", reason: "invalid_state" });
    const bytes = Uint8Array.from(input.bytes);
    if (mediaType === "image/png" && !validPng(bytes))
      return yield* new EvidenceArtifactError({
        operation: "validate",
        reason: "invalid_png",
      });
    if (mediaType === "video/webm" && !validWebm(bytes))
      return yield* new EvidenceArtifactError({
        operation: "validate",
        reason: "invalid_webm",
      });
    const maxBytes =
      mediaType === "video/webm" ? EVIDENCE_MAX_VIDEO_BYTES : EVIDENCE_MAX_FRAME_BYTES;
    if (bytes.byteLength > maxBytes)
      return yield* new EvidenceArtifactError({
        operation: "validate",
        reason: "over_budget",
      });
    const sha256 = yield* Effect.tryPromise({
      try: () => sha256BytesHex(bytes),
      catch: (cause) => new EvidenceArtifactError({ operation: "hash", reason: "upstream", cause }),
    });
    const artifact: EvidenceArtifactV2 = {
      version: 2,
      sessionId: input.sessionId,
      jobId: input.jobId,
      frameId: input.frameId,
      objectKey: evidenceArtifactObjectKey({ ...input, mediaType }),
      mediaType,
      sha256,
      bytes: bytes.byteLength,
      capturedAt: input.capturedAt,
      offsetMillis: input.offsetMillis,
      expiresAt: artifactExpiry(Date.parse(input.capturedAt)),
      status: "delete_pending",
    };
    return { artifact, bytes };
  });
  const writeArtifact = Effect.fnUntraced(function* (prepared: PreparedEvidenceFrame) {
    const artifact = prepared.artifact;
    if (
      artifact.status !== "delete_pending" ||
      !canonicalArtifact(artifact) ||
      artifact.bytes !== prepared.bytes.byteLength
    )
      return yield* new EvidenceArtifactError({ operation: "validate", reason: "invalid_state" });
    const actualSha256 = yield* Effect.tryPromise({
      try: () => sha256BytesHex(prepared.bytes),
      catch: (cause) => new EvidenceArtifactError({ operation: "hash", reason: "upstream", cause }),
    });
    if (actualSha256 !== artifact.sha256)
      return yield* new EvidenceArtifactError({ operation: "validate", reason: "invalid_state" });
    const key = evidenceArtifactObjectKey(artifact);
    const customMetadata = expectedMetadata(artifact, artifact.sha256);
    const putResult = yield* Effect.result(
      Effect.tryPromise({
        try: () =>
          capabilities.put(key, prepared.bytes, {
            contentType: artifact.mediaType,
            customMetadata,
          }),
        catch: (cause) => {
          reportArtifactStorageFailure("put", cause);
          return new EvidenceArtifactError({ operation: "put", reason: "put_unknown", cause });
        },
      }),
    );
    const headResult = yield* Effect.result(
      Effect.tryPromise({
        try: () => capabilities.head(key),
        catch: (cause) => {
          reportArtifactStorageFailure("head", cause);
          return new EvidenceArtifactError({ operation: "head", reason: "upstream", cause });
        },
      }),
    );
    const expected = {
      key,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      sessionId: artifact.sessionId,
      jobId: artifact.jobId,
      frameId: artifact.frameId,
      mediaType: artifact.mediaType,
    };
    if (Result.isFailure(headResult))
      return yield* Result.isFailure(putResult)
        ? putResult.failure
        : new EvidenceArtifactError({
            operation: "head",
            reason: "put_unknown",
            cause: headResult.failure,
          });
    if (!metadataMatches(headResult.success, expected)) {
      reportArtifactVerificationFailure(
        headResult.success === undefined ? "missing" : "metadata_mismatch",
      );
      return yield* Result.isFailure(putResult)
        ? putResult.failure
        : new EvidenceArtifactError({
            operation: "head",
            reason: headResult.success === undefined ? "put_unknown" : "metadata_mismatch",
          });
    }
    return { ...artifact, status: "available" as const };
  });
  const openArtifact = Effect.fnUntraced(function* (artifact: EvidenceArtifactV2) {
    if (artifact.status !== "available" || !canonicalArtifact(artifact))
      return yield* new EvidenceArtifactError({ operation: "open", reason: "invalid_state" });
    const key = evidenceArtifactObjectKey(artifact);
    const body = yield* Effect.tryPromise({
      try: () => capabilities.get(key),
      catch: (cause) => new EvidenceArtifactError({ operation: "open", reason: "upstream", cause }),
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
        mediaType: artifact.mediaType,
      })
    )
      return yield* new EvidenceArtifactError({
        operation: "open",
        reason: "metadata_mismatch",
      });
    return {
      body: body.body,
      bytes: body.size,
      mediaType: artifact.mediaType,
      sha256: artifact.sha256,
    };
  });
  const deleteArtifact = Effect.fnUntraced(function* (artifact: EvidenceArtifactV2) {
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
      catch: (cause) => new EvidenceArtifactError({ operation: "head", reason: "upstream", cause }),
    });
    if (remaining !== undefined)
      return yield* new EvidenceArtifactError({ operation: "delete", reason: "upstream" });
  });
  return {
    prepareFrame: (input) => prepare(input, "image/png"),
    prepareVideo: (input) =>
      prepare(
        {
          sessionId: input.sessionId,
          jobId: input.jobId,
          frameId: input.artifactId,
          bytes: input.bytes,
          capturedAt: input.capturedAt,
          offsetMillis: input.offsetMillis,
        },
        "video/webm",
      ),
    writeFrame: writeArtifact,
    writeArtifact,
    openFrame: openArtifact,
    openArtifact,
    deleteFrame: deleteArtifact,
    deleteArtifact,
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
