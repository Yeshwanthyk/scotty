import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import {
  emptyEvidencePreviewAccounting,
  type BrowserEvidenceJob,
  type CompleteEvidenceStepPublication,
  type CompleteEvidenceVideoPublication,
  type EvidenceActiveJob,
  type EvidenceDiagnostic,
  type EvidenceFailure,
  type EvidenceJobSummary,
} from "../../src/evidence/contracts";
import {
  ContainerEvidenceRecorder,
  ContainerEvidenceRecorderError,
  type ContainerEvidenceRecording,
} from "../../src/evidence/recorder";
import {
  EvidenceWorkflowControl,
  runEvidenceWorkflow,
  type EvidenceWorkflowControlShape,
} from "../../src/evidence/workflow";

const NOW = Date.parse("2026-08-06T12:00:00.000Z");
const PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
]);
const WEBM = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x81, 0x00]);

const defaultJob: BrowserEvidenceJob = {
  port: 4_173,
  viewport: { width: 1_280, height: 720 },
  capture: { screenshots: "after-each-step", video: false },
  steps: [
    {
      name: "Open app",
      action: { kind: "goto", path: "/ready" },
      expect: [{ kind: "urlPath", expected: "/ready" }],
    },
  ],
};

const stepPlanFor = (
  step: BrowserEvidenceJob["steps"][number],
): EvidenceActiveJob["stepPlan"][number] => ({
  name: step.name,
  action: step.action.kind,
  assertions: [step.expect[0].kind, ...step.expect.slice(1).map((assertion) => assertion.kind)],
});

const activeFor = (
  job: BrowserEvidenceJob,
  deadlineAt = new Date(NOW + 60_000).toISOString(),
): EvidenceActiveJob => ({
  sequence: 0,
  jobId: "job-test",
  status: "accepted",
  acceptedAt: new Date(NOW).toISOString(),
  totalSteps: job.steps.length,
  completedSteps: 0,
  viewport: job.viewport,
  recordVideo: job.capture.video,
  flowHash: "a".repeat(64),
  steps: [],
  frameCount: 0,
  operationNonce: "operation-test",
  port: job.port,
  runtimeEpoch: "runtime-test",
  routeNonce: "route_nonce_test",
  previewCookieDigest: null,
  exposure: "not_exposed",
  previewAccounting: emptyEvidencePreviewAccounting(),
  deadlineAt,
  stepPlan: [stepPlanFor(job.steps[0]), ...job.steps.slice(1).map(stepPlanFor)],
});

interface ControlState {
  readonly events: Array<string>;
  readonly publications: Array<CompleteEvidenceStepPublication>;
  videoPublication: CompleteEvidenceVideoPublication | undefined;
  failure: EvidenceFailure | undefined;
  diagnostic: EvidenceDiagnostic | undefined;
}

const emptyState = (): ControlState => ({
  events: [],
  publications: [],
  videoPublication: undefined,
  failure: undefined,
  diagnostic: undefined,
});

const makeControl = (state: ControlState): EvidenceWorkflowControlShape =>
  EvidenceWorkflowControl.of({
    expose: () =>
      Effect.sync(() => {
        state.events.push("preview:expose");
        return {
          origin: "https://unused.preview.scotty.example",
          cookieSecret: "unused-preview-cookie",
          expiresAt: new Date(NOW + 60_000).toISOString(),
        };
      }),
    markRunning: () => Effect.sync(() => state.events.push("job:running")),
    completeStep: (_active, input) =>
      Effect.sync(() => {
        state.events.push(`step:${input.index}`);
        state.publications.push(input);
      }),
    completeVideo: (_active, input) =>
      Effect.sync(() => {
        state.events.push("video:publish");
        state.videoPublication = input;
      }),
    recordFailure: (_active, failure, diagnostic) =>
      Effect.sync(() => {
        state.events.push(`failure:${failure.code}`);
        if (state.failure !== undefined) return;
        state.failure = failure;
        state.diagnostic = diagnostic;
      }),
    finalize: (active, status) =>
      Effect.sync(() => {
        state.events.push(`terminal:${status}`);
        return {
          sequence: active.sequence,
          jobId: active.jobId,
          status,
          acceptedAt: active.acceptedAt,
          completedAt: new Date(NOW + 1).toISOString(),
          totalSteps: active.totalSteps,
          completedSteps: state.publications.length,
          viewport: active.viewport,
          recordVideo: active.recordVideo,
          flowHash: active.flowHash,
          steps: [],
          frameCount: state.publications.length,
          ...(state.videoPublication === undefined
            ? {}
            : {
                video: {
                  artifactId: "recording" as const,
                  sha256: "b".repeat(64),
                  bytes: state.videoPublication.bytes.byteLength,
                  capturedAt: state.videoPublication.capturedAt,
                  offsetMillis: state.videoPublication.offsetMillis,
                },
              }),
          ...(state.failure === undefined ? {} : { failure: state.failure }),
          ...(state.diagnostic === undefined ? {} : { diagnostic: state.diagnostic }),
        } satisfies EvidenceJobSummary;
      }),
  });

const successfulRecording = (
  options: { readonly video?: Uint8Array; readonly passed?: boolean } = {},
): ContainerEvidenceRecording => {
  const capturedAt = new Date(NOW + 1_000).toISOString();
  const passed = options.passed ?? true;
  return {
    status: passed ? "succeeded" : "failed",
    completedSteps: 1,
    steps: [
      {
        index: 0,
        startedAt: new Date(NOW).toISOString(),
        completedAt: capturedAt,
        offsetMillis: 1_000,
        assertions: [{ kind: "urlPath", passed }],
        frame: { bytes: PNG, capturedAt, offsetMillis: 1_000 },
      },
    ],
    ...(options.video === undefined
      ? {}
      : { video: { bytes: options.video, capturedAt, offsetMillis: 1_000 } }),
    ...(passed ? {} : { failure: { code: "assertion_mismatch" as const, step: 0 } }),
  };
};

const execute = (
  job: BrowserEvidenceJob,
  state: ControlState,
  record: ContainerEvidenceRecorder["Service"]["record"],
  deadlineAt?: string,
) =>
  runEvidenceWorkflow({
    active: activeFor(job, deadlineAt),
    job,
    summaryUrl: "/s/session/evidence/job-test",
  }).pipe(
    Effect.provideService(
      ContainerEvidenceRecorder,
      ContainerEvidenceRecorder.of({
        record: (input) =>
          record(input).pipe(
            Effect.tap(() => Effect.sync(() => state.events.push("recorder:closed"))),
          ),
      }),
    ),
    Effect.provideService(EvidenceWorkflowControl, makeControl(state)),
  );

describe("Container evidence workflow", () => {
  it.effect("publishes a non-video PNG after the local recorder closes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const state = emptyState();
      const result = yield* execute(defaultJob, state, () => Effect.succeed(successfulRecording()));

      assert.deepStrictEqual(result, {
        jobId: "job-test",
        status: "succeeded",
        summaryUrl: "/s/session/evidence/job-test",
        completedSteps: 1,
        frameCount: 1,
        video: false,
      });
      assert.deepStrictEqual(state.publications[0].frame?.bytes, PNG);
      assert.isBelow(state.events.indexOf("recorder:closed"), state.events.indexOf("step:0"));
      assert.notInclude(state.events, "preview:expose");
      assert.notInclude(state.events, "video:publish");
    }),
  );

  it.effect("publishes WebM only for a successful video recording", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const state = emptyState();
      const job = {
        ...defaultJob,
        capture: { screenshots: "after-each-step", video: true },
      } satisfies BrowserEvidenceJob;
      const result = yield* execute(job, state, () =>
        Effect.succeed(successfulRecording({ video: WEBM })),
      );

      assert.deepInclude(result, { status: "succeeded", frameCount: 1, video: true });
      assert.deepStrictEqual(state.videoPublication?.bytes, WEBM);
      assert.isBelow(
        state.events.indexOf("recorder:closed"),
        state.events.indexOf("video:publish"),
      );
      assert.isBelow(
        state.events.indexOf("video:publish"),
        state.events.indexOf("terminal:succeeded"),
      );
    }),
  );

  it.effect("publishes the failed-step PNG before preserving assertion_mismatch", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const state = emptyState();
      const result = yield* execute(defaultJob, state, () =>
        Effect.succeed(successfulRecording({ passed: false })),
      );

      assert.deepInclude(result, {
        status: "failed",
        failure: { code: "assertion_mismatch", step: 0 },
        completedSteps: 1,
        frameCount: 1,
        video: false,
      });
      assert.deepStrictEqual(state.publications[0].frame?.bytes, PNG);
      assert.strictEqual(state.publications[0].assertions[0].passed, false);
      assert.notInclude(state.events, "video:publish");
    }),
  );

  it.effect("maps a non-video recorder rejection to bounded screenshot diagnostics", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const state = emptyState();
      const result = yield* execute(defaultJob, state, () =>
        Effect.fail(
          new ContainerEvidenceRecorderError({ operation: "run", reason: "unsupported" }),
        ),
      );

      assert.deepInclude(result, { status: "unsupported", failure: { code: "unsupported" } });
      assert.deepStrictEqual(state.diagnostic, {
        operation: "screenshot",
        reason: "unsupported",
      });
      assert.lengthOf(state.publications, 0);
    }),
  );

  it.effect("enforces the authoritative job deadline around the local recorder", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const state = emptyState();
      const fiber = yield* execute(defaultJob, state, () => Effect.never).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(60_000);
      const result = yield* Fiber.join(fiber);

      assert.deepInclude(result, { status: "interrupted", failure: { code: "deadline" } });
      assert.include(state.events, "terminal:interrupted");
      assert.lengthOf(state.publications, 0);
    }),
  );
});
