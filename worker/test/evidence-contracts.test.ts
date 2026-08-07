import { assert, describe, it } from "@effect/vitest";
import { Option, Result } from "effect";
import {
  EVIDENCE_COMPATIBILITY_ROUTE_NONCE,
  EVIDENCE_PREVIEW_AGGREGATE_BYTES,
  EVIDENCE_PREVIEW_REQUEST_DURATION_MILLIS,
  EVIDENCE_PREVIEW_RESERVED_RESPONSE_BYTES,
  decodeBrowserEvidenceJob,
  decodeBrowserEvidenceToolResult,
  decodeEvidenceStateResult,
  decodeStoredEvidenceStateResult,
  emptyEvidencePreviewAccounting,
  emptyEvidenceState,
  publicEvidenceSummaryProjection,
  type EvidenceJobSummaryV1,
} from "../src/evidence-contracts";

const step = {
  name: "Open the app",
  action: { kind: "goto", path: "/" },
  expect: [{ kind: "urlPath", expected: "/" }],
} as const;

const diagnostic = {
  operation: "screenshot",
  reason: "ambiguous",
  step: 0,
  kitesurf: { operation: "screenshot", reason: "ambiguous" },
} as const;

const internalSummary: EvidenceJobSummaryV1 = {
  version: 1,
  sequence: 0,
  jobId: "job-diagnostic",
  status: "interrupted",
  acceptedAt: "2026-08-06T12:00:00.000Z",
  completedAt: "2026-08-06T12:00:01.000Z",
  totalSteps: 1,
  completedSteps: 0,
  replay: true,
  steps: [],
  frameCount: 0,
  failure: { code: "interrupted", step: 0 },
  diagnostic,
};

const legacyActiveState = {
  version: 1,
  nextSequence: 1,
  activeJob: {
    version: 1,
    sequence: 0,
    jobId: "legacy-job",
    status: "accepted",
    acceptedAt: "2026-08-06T12:00:00.000Z",
    totalSteps: 1,
    completedSteps: 0,
    replay: false,
    steps: [],
    frameCount: 0,
    operationNonce: "legacy-operation",
    port: 4_173,
    runtimeEpoch: "legacy-runtime",
    deadlineAt: "2026-08-06T12:05:00.000Z",
    stepPlan: [{ name: "Open the app", action: "goto", assertions: ["urlPath"] }],
  },
  jobs: [],
  artifacts: [],
  pendingDeletes: [],
  retainedBytes: 0,
};

describe("evidence contracts", () => {
  it("decodes the bounded declarative job without retaining excess input", () => {
    const decoded = decodeBrowserEvidenceJob({
      version: 1,
      port: 4_173,
      viewport: { width: 1_280, height: 720 },
      capture: { screenshots: "after-each-step", replay: true },
      steps: [step],
    });
    assert.ok(Option.isSome(decoded));
    assert.deepStrictEqual(decoded.value.steps[0], step);
  });

  it("rejects invalid ports, arbitrary paths, excess fields, and oversized graphs", () => {
    for (const input of [
      { version: 1, port: 80, steps: [step] },
      { version: 1, port: 3_000, steps: [step] },
      { version: 1, port: 43_117, steps: [step] },
      {
        version: 1,
        port: 4_173,
        steps: [{ ...step, action: { kind: "goto", path: "https://example.com" } }],
      },
      { version: 1, port: 4_173, steps: [step], targetOrigin: "https://example.com" },
      { version: 1, port: 4_173, steps: Array.from({ length: 13 }, () => step) },
    ]) {
      assert.ok(Option.isNone(decodeBrowserEvidenceJob(input)));
    }
  });

  it("bounds the container tool result to safe metadata and one authenticated summary path", () => {
    const result = {
      version: 1,
      jobId: "job-abcd1234",
      status: "failed",
      summaryUrl: "/s/abcdef123456/evidence/job-abcd1234",
      completedSteps: 1,
      frameCount: 1,
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

  it("decodes old records and closes durable diagnostics to declared enums and fields", () => {
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
      { ...diagnostic, kitesurf: { ...diagnostic.kitesurf, cause: "private cause" } },
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

  it("explicitly omits internal diagnostics from the public summary projection", () => {
    const projected = publicEvidenceSummaryProjection(internalSummary);
    assert.notProperty(projected, "diagnostic");
    assert.isFalse(JSON.stringify(projected).includes("kitesurf"));
  });

  it("normalizes only the legacy active storage shape into closed preview authority", () => {
    assert.ok(Result.isFailure(decodeEvidenceStateResult(legacyActiveState)));
    const stored = decodeStoredEvidenceStateResult(legacyActiveState);
    assert.ok(Result.isSuccess(stored));
    assert.deepInclude(stored.success.activeJob, {
      status: "interrupted",
      failure: { code: "interrupted" },
      routeNonce: EVIDENCE_COMPATIBILITY_ROUTE_NONCE,
      previewCookieDigest: null,
      exposure: "closed",
      previewAccounting: emptyEvidencePreviewAccounting(),
    });
    assert.ok(Result.isSuccess(decodeEvidenceStateResult(stored.success)));
    assert.ok(
      Result.isFailure(
        decodeStoredEvidenceStateResult({
          ...legacyActiveState,
          activeJob: { ...legacyActiveState.activeJob, routeNonce: "partially_migrated" },
        }),
      ),
    );
  });

  it("closes the storage-only unaccounted preview shape without reopening its authority", () => {
    const unaccounted = {
      ...legacyActiveState,
      activeJob: {
        ...legacyActiveState.activeJob,
        routeNonce: "0123456789abcdef",
        previewCookieDigest: "a".repeat(64),
        exposure: "active",
      },
    };
    assert.ok(Result.isFailure(decodeEvidenceStateResult(unaccounted)));
    const stored = decodeStoredEvidenceStateResult(unaccounted);
    assert.ok(Result.isSuccess(stored));
    assert.deepInclude(stored.success.activeJob, {
      status: "interrupted",
      failure: { code: "interrupted" },
      routeNonce: "0123456789abcdef",
      previewCookieDigest: null,
      exposure: "unexpose_pending",
      previewAccounting: emptyEvidencePreviewAccounting(),
    });
    assert.ok(Result.isSuccess(decodeEvidenceStateResult(stored.success)));
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
      ...legacyActiveState.activeJob,
      routeNonce: "0123456789abcdef",
      previewCookieDigest: "a".repeat(64),
      exposure: "active",
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
            ...legacyActiveState,
            activeJob: { ...active, previewAccounting },
          }),
        ),
      );
    }
  });
});
