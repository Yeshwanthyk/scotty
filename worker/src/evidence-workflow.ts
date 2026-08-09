import { Clock, Context, Effect, Exit, Ref, Result, Schema } from "effect";
import {
  type BrowserEvidenceJobV2,
  type BrowserEvidenceResultV2,
  type CompleteEvidenceStepPublicationV2,
  type CompleteEvidenceVideoPublicationV2,
  type EvidenceActiveJobV2,
  EvidenceWorkflowOperationSchema,
  EvidenceWorkflowReasonSchema,
  type EvidenceDiagnostic,
  type EvidenceFailure,
  type EvidenceFailureCode,
  type EvidenceJobSummaryV2,
  type EvidenceTerminalStatus,
  type ExposedEvidencePreviewV2,
} from "./evidence-contracts";
import {
  ContainerEvidenceRecorder,
  type ContainerEvidenceRecorderError,
  type ContainerEvidenceRecording,
} from "./container-evidence-recorder";

export class EvidenceWorkflowError extends Schema.TaggedErrorClass<EvidenceWorkflowError>()(
  "EvidenceWorkflowError",
  {
    operation: EvidenceWorkflowOperationSchema,
    reason: EvidenceWorkflowReasonSchema,
    failureCode: Schema.optionalKey(
      Schema.Literals([
        "assertion_mismatch",
        "artifact_invalid",
        "artifact_over_budget",
        "artifact_put_unknown",
        "deadline",
        "interrupted",
        "unsupported",
      ]),
    ),
    step: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  },
) {}

export class EvidenceWorkflowControlError extends Schema.TaggedErrorClass<EvidenceWorkflowControlError>()(
  "EvidenceWorkflowControlError",
  {
    operation: Schema.Literals([
      "expose",
      "mark_running",
      "complete_step",
      "complete_video",
      "record_failure",
      "finalize",
    ]),
    failureCode: Schema.Literals([
      "assertion_mismatch",
      "artifact_invalid",
      "artifact_over_budget",
      "artifact_put_unknown",
      "deadline",
      "interrupted",
      "unsupported",
    ]),
  },
) {}

export interface EvidenceWorkflowControlShape {
  readonly expose: (
    active: EvidenceActiveJobV2,
  ) => Effect.Effect<ExposedEvidencePreviewV2, EvidenceWorkflowControlError>;
  readonly markRunning: (
    active: EvidenceActiveJobV2,
  ) => Effect.Effect<void, EvidenceWorkflowControlError>;
  readonly completeStep: (
    active: EvidenceActiveJobV2,
    input: CompleteEvidenceStepPublicationV2,
  ) => Effect.Effect<void, EvidenceWorkflowControlError>;
  readonly completeVideo: (
    active: EvidenceActiveJobV2,
    input: CompleteEvidenceVideoPublicationV2,
  ) => Effect.Effect<void, EvidenceWorkflowControlError>;
  readonly recordFailure: (
    active: EvidenceActiveJobV2,
    failure: EvidenceFailure,
    diagnostic?: EvidenceDiagnostic,
  ) => Effect.Effect<void, EvidenceWorkflowControlError>;
  readonly finalize: (
    active: EvidenceActiveJobV2,
    status: EvidenceTerminalStatus,
  ) => Effect.Effect<EvidenceJobSummaryV2, EvidenceWorkflowControlError>;
}

export class EvidenceWorkflowControl extends Context.Service<
  EvidenceWorkflowControl,
  EvidenceWorkflowControlShape
>()("scotty/EvidenceWorkflowControl") {}

export interface RunEvidenceWorkflowInput {
  readonly active: EvidenceActiveJobV2;
  readonly job: BrowserEvidenceJobV2;
  readonly summaryUrl: string;
}

const workflowError = (
  operation: EvidenceWorkflowError["operation"],
  reason: EvidenceWorkflowError["reason"],
  options: {
    readonly failureCode?: EvidenceFailureCode;
    readonly step?: number;
  } = {},
): EvidenceWorkflowError =>
  new EvidenceWorkflowError({
    operation,
    reason,
    ...(options.failureCode === undefined ? {} : { failureCode: options.failureCode }),
    ...(options.step === undefined ? {} : { step: options.step }),
  });

const mapControlError = (
  error: EvidenceWorkflowControlError,
  operation: EvidenceWorkflowError["operation"],
  step?: number,
): EvidenceWorkflowError =>
  workflowError(operation, error.failureCode === "unsupported" ? "unsupported" : "upstream", {
    failureCode: error.failureCode,
    ...(step === undefined ? {} : { step }),
  });

const failureFor = (error: EvidenceWorkflowError): EvidenceFailure => ({
  code:
    error.failureCode ??
    (error.reason === "unsupported"
      ? "unsupported"
      : error.reason === "deadline"
        ? "deadline"
        : "interrupted"),
  ...(error.step === undefined ? {} : { step: error.step }),
});

const diagnosticFor = (error: EvidenceWorkflowError): EvidenceDiagnostic => ({
  operation: error.operation,
  reason: error.reason,
  ...(error.step === undefined ? {} : { step: error.step }),
});

const activeMatchesJob = (active: EvidenceActiveJobV2, job: BrowserEvidenceJobV2): boolean =>
  active.status === "accepted" &&
  active.exposure === "not_exposed" &&
  active.previewCookieDigest === null &&
  active.completedSteps === 0 &&
  active.steps.length === 0 &&
  active.frameCount === 0 &&
  active.port === job.port &&
  active.totalSteps === job.steps.length &&
  active.viewport.width === job.viewport.width &&
  active.viewport.height === job.viewport.height &&
  active.recordVideo === job.capture.video &&
  active.stepPlan.length === job.steps.length &&
  active.stepPlan.every((plan, index) => {
    const step = job.steps[index];
    return (
      step !== undefined &&
      plan.name === step.name &&
      plan.action === step.action.kind &&
      plan.assertions.length === step.expect.length &&
      plan.assertions.every((kind, assertionIndex) => kind === step.expect[assertionIndex]?.kind)
    );
  });

const publishContainerRecording = Effect.fnUntraced(function* (
  control: EvidenceWorkflowControlShape,
  input: RunEvidenceWorkflowInput,
  recording: ContainerEvidenceRecording,
) {
  for (const step of recording.steps) {
    const firstAssertion = step.assertions[0];
    if (firstAssertion === undefined)
      return yield* workflowError("validate", "invalid", {
        failureCode: "interrupted",
        step: step.index,
      });
    yield* control
      .completeStep(input.active, {
        index: step.index,
        startedAt: step.startedAt,
        completedAt: step.completedAt,
        offsetMillis: step.offsetMillis,
        assertions: [firstAssertion, ...step.assertions.slice(1)],
        frame: {
          frameId: `frame-${step.index + 1}`,
          bytes: step.frame.bytes,
          capturedAt: step.frame.capturedAt,
          offsetMillis: step.frame.offsetMillis,
        },
      })
      .pipe(Effect.mapError((error) => mapControlError(error, "publish", step.index)));
  }
  if (recording.status === "succeeded") {
    if (
      recording.completedSteps !== input.job.steps.length ||
      (input.job.capture.video ? recording.video === undefined : recording.video !== undefined)
    )
      return yield* workflowError(input.job.capture.video ? "video" : "screenshot", "invalid", {
        failureCode: "interrupted",
      });
    if (recording.video !== undefined)
      yield* control
        .completeVideo(input.active, {
          artifactId: "recording",
          bytes: recording.video.bytes,
          capturedAt: recording.video.capturedAt,
          offsetMillis: recording.video.offsetMillis,
        })
        .pipe(Effect.mapError((error) => mapControlError(error, "publish")));
    return;
  }
  const failure = recording.failure;
  if (failure === undefined)
    return yield* workflowError(input.job.capture.video ? "video" : "screenshot", "invalid", {
      failureCode: "interrupted",
    });
  return yield* workflowError(
    failure.code === "assertion_mismatch"
      ? "assertion"
      : input.job.capture.video
        ? "video"
        : "screenshot",
    failure.code === "unsupported"
      ? "unsupported"
      : failure.code === "deadline"
        ? "deadline"
        : failure.code === "assertion_mismatch"
          ? "assertion"
          : "ambiguous",
    {
      failureCode: failure.code,
      ...(failure.step === undefined ? {} : { step: failure.step }),
    },
  );
});

const executeJob = Effect.fnUntraced(function* (
  recorder: ContainerEvidenceRecorder["Service"],
  control: EvidenceWorkflowControlShape,
  input: RunEvidenceWorkflowInput,
) {
  if (!activeMatchesJob(input.active, input.job))
    return yield* workflowError("validate", "invalid", {
      failureCode: "interrupted",
    });
  const deadlineMillis = Date.parse(input.active.deadlineAt);
  const nowMillis = yield* Clock.currentTimeMillis;
  if (!Number.isFinite(deadlineMillis) || deadlineMillis <= nowMillis)
    return yield* workflowError("browser", "deadline", { failureCode: "deadline" });
  const jobStartedAtMillis = yield* Clock.currentTimeMillis;
  const artifactOperation = input.job.capture.video ? "video" : "screenshot";
  yield* control
    .markRunning(input.active)
    .pipe(Effect.mapError((error) => mapControlError(error, "phase")));
  const recording = yield* recorder.record(input.job).pipe(
    Effect.mapError((error: ContainerEvidenceRecorderError) =>
      workflowError(error.operation === "cleanup" ? "browser" : artifactOperation, error.reason, {
        failureCode: error.reason === "unsupported" ? "unsupported" : "interrupted",
      }),
    ),
    Effect.timeoutOrElse({
      duration: deadlineMillis - jobStartedAtMillis,
      orElse: () =>
        Effect.fail(workflowError(artifactOperation, "deadline", { failureCode: "deadline" })),
    }),
  );
  yield* publishContainerRecording(control, input, recording);
});

const terminalStatus = (
  result: Result.Result<void, EvidenceWorkflowError>,
): EvidenceTerminalStatus =>
  Result.isSuccess(result)
    ? "succeeded"
    : result.failure.failureCode === "unsupported" || result.failure.reason === "unsupported"
      ? "unsupported"
      : result.failure.failureCode === "deadline" ||
          result.failure.failureCode === "interrupted" ||
          result.failure.reason === "deadline" ||
          result.failure.reason === "ambiguous" ||
          result.failure.reason === "cleanup"
        ? "interrupted"
        : "failed";

const workflowResult = (
  summary: EvidenceJobSummaryV2,
  summaryUrl: string,
): BrowserEvidenceResultV2 => ({
  version: 2,
  jobId: summary.jobId,
  status:
    summary.status === "succeeded" ||
    summary.status === "failed" ||
    summary.status === "interrupted" ||
    summary.status === "unsupported"
      ? summary.status
      : "interrupted",
  summaryUrl,
  completedSteps: summary.completedSteps,
  frameCount: summary.frameCount,
  video: summary.video !== undefined,
  ...(summary.failure === undefined ? {} : { failure: summary.failure }),
});

export const runEvidenceWorkflow = Effect.fnUntraced(function* (input: RunEvidenceWorkflowInput) {
  const recorder = yield* ContainerEvidenceRecorder;
  const control = yield* EvidenceWorkflowControl;
  const terminalCommitted = yield* Ref.make(false);
  const requestedStatus = yield* Ref.make<EvidenceTerminalStatus>("interrupted");
  const requestedFailure = yield* Ref.make<EvidenceFailure | undefined>(undefined);
  const main = Effect.gen(function* () {
    const execution = yield* Effect.result(executeJob(recorder, control, input));
    const status = terminalStatus(execution);
    const failure = Result.isFailure(execution) ? failureFor(execution.failure) : undefined;
    const diagnostic = Result.isFailure(execution) ? diagnosticFor(execution.failure) : undefined;
    if (diagnostic !== undefined)
      yield* Effect.sync(() =>
        console.error("Evidence workflow failed", {
          jobId: input.active.jobId,
          ...diagnostic,
        }),
      );
    yield* Ref.set(requestedStatus, status);
    yield* Ref.set(requestedFailure, failure);
    if (failure !== undefined)
      yield* control
        .recordFailure(input.active, failure, diagnostic)
        .pipe(Effect.mapError((error) => mapControlError(error, "finalize", failure.step)));
    const summary = yield* control
      .finalize(input.active, status)
      .pipe(Effect.mapError((error) => mapControlError(error, "finalize", failure?.step)));
    yield* Ref.set(terminalCommitted, true);
    return workflowResult(summary, input.summaryUrl);
  });
  return yield* main.pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        if (yield* Ref.get(terminalCommitted)) return;
        const interrupted = Exit.hasInterrupts(exit);
        const status = interrupted ? "interrupted" : yield* Ref.get(requestedStatus);
        const failure = interrupted
          ? ({ code: "interrupted" } as const)
          : yield* Ref.get(requestedFailure);
        if (failure !== undefined)
          yield* control.recordFailure(input.active, failure).pipe(Effect.ignore);
        yield* control.finalize(input.active, status);
        yield* Ref.set(terminalCommitted, true);
      }),
    ),
  );
});
