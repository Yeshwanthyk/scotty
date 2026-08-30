import { assert, describe, it } from "@effect/vitest";
import { Option, Result } from "effect";
import {
  EVIDENCE_PREVIEW_AGGREGATE_BYTES,
  EVIDENCE_PREVIEW_REQUEST_DURATION_MILLIS,
  EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES,
  decodeBrowserEvidenceJob,
  decodeBrowserEvidenceToolResult,
  decodeEvidenceStateResult,
  emptyEvidencePreviewAccounting,
  emptyEvidenceState,
  evidenceShowcaseProjection,
  publicEvidenceSummaryProjection,
  type EvidenceJobSummary,
} from "../../src/evidence/contracts";

const step = {
  name: "Open the app",
  action: { kind: "goto", path: "/" },
  expect: [{ kind: "urlPath", expected: "/" }],
} as const;

const unversionedJob = {
  port: 4_173,
  viewport: { width: 1_280, height: 720 },
  capture: { screenshots: "after-each-step", video: false },
  steps: [step],
} as const;

const evidenceJob = { version: 2, ...unversionedJob } as const;

const diagnostic = {
  operation: "screenshot",
  reason: "ambiguous",
  step: 0,
} as const;

const internalSummary: EvidenceJobSummary = {
  sequence: 0,
  jobId: "job-diagnostic",
  status: "interrupted",
  acceptedAt: "2026-08-06T12:00:00.000Z",
  completedAt: "2026-08-06T12:00:01.000Z",
  totalSteps: 1,
  completedSteps: 0,
  viewport: { width: 1_280, height: 720 },
  recordVideo: false,
  flowHash: "a".repeat(64),
  steps: [],
  frameCount: 0,
  failure: { code: "interrupted", step: 0 },
  diagnostic,
};

const activeState = {
  nextSequence: 1,
  activeJob: {
    sequence: 0,
    jobId: "current-job",
    status: "accepted",
    acceptedAt: "2026-08-06T12:00:00.000Z",
    totalSteps: 1,
    completedSteps: 0,
    viewport: { width: 1_280, height: 720 },
    recordVideo: false,
    flowHash: "a".repeat(64),
    steps: [],
    frameCount: 0,
    operationNonce: "current-operation",
    port: 4_173,
    runtimeEpoch: "legacy-runtime",
    deadlineAt: "2026-08-06T12:05:00.000Z",
    stepPlan: [{ name: "Open the app", action: "goto", assertions: ["urlPath"] }],
    routeNonce: "0123456789abcdef",
    previewCookieDigest: "a".repeat(64),
    exposure: "active",
    previewAccounting: emptyEvidencePreviewAccounting(),
  },
  jobs: [],
  artifacts: [],
  pendingDeletes: [],
  retainedBytes: 0,
};

describe("evidence contracts", () => {
  it("decodes the bounded declarative v2 job without retaining excess input", () => {
    const decoded = decodeBrowserEvidenceJob(evidenceJob);
    assert.ok(Option.isSome(decoded));
    assert.strictEqual(decoded.value.version, 2);
    assert.deepStrictEqual(decoded.value.steps[0], step);
  });

  it("rejects missing, legacy, excess, and otherwise invalid v2 job shapes", () => {
    for (const input of [
      unversionedJob,
      { ...evidenceJob, version: 1 },
      { ...evidenceJob, targetOrigin: "https://example.com" },
      { ...evidenceJob, port: 80 },
      { ...evidenceJob, port: 3_000 },
      { ...evidenceJob, port: 43_117 },
      {
        ...evidenceJob,
        steps: [{ ...step, action: { kind: "goto", path: "https://example.com" } }],
      },
      { ...evidenceJob, steps: Array.from({ length: 13 }, () => step) },
    ]) {
      assert.ok(Option.isNone(decodeBrowserEvidenceJob(input)));
    }
  });

  it("bounds the container tool result to safe metadata and one authenticated summary path", () => {
    const result = {
      jobId: "job-abcd1234",
      status: "failed",
      summaryUrl: "/s/abcdef123456/evidence/job-abcd1234",
      completedSteps: 1,
      frameCount: 1,
      video: false,
      failure: { code: "assertion_mismatch", step: 0 },
    } as const;
    assert.ok(Option.isSome(decodeBrowserEvidenceToolResult(result)));
    const transported = decodeBrowserEvidenceToolResult({
      ...result,
      diagnostic,
      rpcMetadata: "transport-only",
      cookie: "must-not-cross-boundary",
    });
    assert.deepStrictEqual(Option.getOrThrow(transported), result);
    for (const invalid of [
      { ...result, summaryUrl: "https://example.com/evidence/job-abcd1234" },
      { ...result, summaryUrl: "/s/abcdef123456/evidence/different-job" },
      { ...result, frameCount: 13 },
    ]) {
      assert.ok(Option.isNone(decodeBrowserEvidenceToolResult(invalid)));
    }
  });

  it("accepts only current Evidence records and closes diagnostics to declared enums and fields", () => {
    const empty = emptyEvidenceState();
    assert.ok(Result.isSuccess(decodeEvidenceStateResult(empty)));
    assert.ok(
      Result.isSuccess(
        decodeEvidenceStateResult({
          ...empty,
          nextSequence: 1,
          jobs: [internalSummary],
        }),
      ),
    );
    for (const invalidDiagnostic of [
      { ...diagnostic, detail: "private page data" },
      { ...diagnostic, reason: "native_timeout" },
      { ...diagnostic, provider: { cause: "private cause" } },
    ]) {
      assert.ok(
        Result.isFailure(
          decodeEvidenceStateResult({
            ...empty,
            nextSequence: 1,
            jobs: [{ ...internalSummary, diagnostic: invalidDiagnostic }],
          }),
        ),
      );
    }
    assert.ok(
      Result.isFailure(
        decodeEvidenceStateResult({ ...empty, retainedBytes: -1, previewCookie: "secret" }),
      ),
    );
  });

  it("projects a Showcase only from matched passing before and recorded after runs", () => {
    const successfulSummary = (jobId: string, recordVideo: boolean) =>
      publicEvidenceSummaryProjection({
        sequence: recordVideo ? 1 : 0,
        jobId,
        status: "succeeded",
        acceptedAt: "2026-08-06T12:00:00.000Z",
        completedAt: "2026-08-06T12:00:01.000Z",
        totalSteps: 1,
        completedSteps: 1,
        viewport: { width: 1_280, height: 720 },
        recordVideo,
        flowHash: "c".repeat(64),
        ...(recordVideo
          ? {
              video: {
                artifactId: "recording" as const,
                sha256: "d".repeat(64),
                bytes: 12,
                capturedAt: "2026-08-06T12:00:01.000Z",
                offsetMillis: 1_000,
              },
            }
          : {}),
        steps: [
          {
            index: 0,
            name: "Open the app",
            action: "goto",
            status: "passed",
            assertions: [{ kind: "urlPath", passed: true, expected: "/", actual: "/" }],
            startedAt: "2026-08-06T12:00:00.000Z",
            completedAt: "2026-08-06T12:00:01.000Z",
            offsetMillis: 1_000,
            frame: {
              frameId: "frame-1",
              sha256: "e".repeat(64),
              bytes: 12,
              capturedAt: "2026-08-06T12:00:01.000Z",
              offsetMillis: 1_000,
            },
          },
        ],
        frameCount: 1,
      } satisfies EvidenceJobSummary);
    const before = successfulSummary("before-job", false);
    const after = successfulSummary("after-job", true);

    assert.deepInclude(evidenceShowcaseProjection("abcdef123456", before, after), {
      paths: {
        hatch: "/s/abcdef123456/hatch/open",
        video: "/s/abcdef123456/evidence/after-job/video.webm",
      },
    });
    assert.isUndefined(
      evidenceShowcaseProjection("abcdef123456", before, {
        ...after,
        viewport: { width: 390, height: 844 },
      }),
    );
    assert.isUndefined(
      evidenceShowcaseProjection("abcdef123456", before, {
        ...after,
        flowHash: "f".repeat(64),
      }),
    );
    assert.isUndefined(
      evidenceShowcaseProjection("abcdef123456", before, { ...after, video: undefined }),
    );
  });

  it("explicitly omits internal diagnostics from the public summary projection", () => {
    const projected = publicEvidenceSummaryProjection(internalSummary);
    assert.notProperty(projected, "diagnostic");
  });

  it("rejects duplicate or overcommitted persisted permit accounting", () => {
    const permit = {
      requestId: "1".repeat(32),
      state: "admitted",
      cookieDigest: "a".repeat(64),
      ingressBytes: 0,
      admittedAt: "2026-08-06T12:00:00.000Z",
      expiresAt: "2026-08-06T12:00:30.000Z",
    } as const;
    const active = {
      ...activeState.activeJob,
    } as const;
    for (const previewAccounting of [
      { consumedBytes: 0, consumedRequestMillis: 0, permits: [permit, permit] },
      {
        consumedBytes:
          EVIDENCE_PREVIEW_AGGREGATE_BYTES - EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES + 1,
        consumedRequestMillis: 0,
        permits: [permit],
      },
      {
        consumedBytes: 0,
        consumedRequestMillis: 120_000 - EVIDENCE_PREVIEW_REQUEST_DURATION_MILLIS + 1,
        permits: [permit],
      },
    ]) {
      assert.ok(
        Result.isFailure(
          decodeEvidenceStateResult({
            ...activeState,
            activeJob: { ...active, previewAccounting },
          }),
        ),
      );
    }
  });
});
