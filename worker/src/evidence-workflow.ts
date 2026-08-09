import { Clock, Context, Effect, Exit, Predicate, Ref, Result, Schema } from "effect";
import {
  type BrowserEvidenceJobV2,
  type BrowserEvidenceResultV2,
  type CompleteEvidenceStepPublicationV2,
  type CompleteEvidenceVideoPublicationV2,
  type EvidenceActiveJobV2,
  type EvidenceAssertion,
  EvidenceKitesurfDiagnosticSchema,
  EvidenceWorkflowOperationSchema,
  EvidenceWorkflowReasonSchema,
  type EvidenceAssertionResult,
  type EvidenceDiagnostic,
  type EvidenceFailure,
  type EvidenceFailureCode,
  type EvidenceJobSummaryV2,
  type EvidenceTerminalStatus,
  type ExposedEvidencePreviewV2,
} from "./evidence-contracts";
import {
  KITESURF_NAVIGATION_TIMEOUT_MILLIS,
  KITESURF_SCREENSHOT_TIMEOUT_MILLIS,
  KitesurfClient,
  type KitesurfClientError,
  type KitesurfClientShape,
  type KitesurfPage,
  type KitesurfPageResult,
} from "./kitesurf-client";

export const EVIDENCE_ASSERTION_TIMEOUT_MILLIS = 15_000;
export const EVIDENCE_ASSERTION_POLL_INTERVAL_MILLIS = 100;
export const EVIDENCE_ACTION_TIMEOUT_MILLIS = 5_000;
export const EVIDENCE_STEP_TIMEOUT_MILLIS = 45_000;

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
    kitesurf: Schema.optionalKey(EvidenceKitesurfDiagnosticSchema),
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
    readonly kitesurf?: EvidenceDiagnostic["kitesurf"];
  } = {},
): EvidenceWorkflowError =>
  new EvidenceWorkflowError({
    operation,
    reason,
    ...(options.failureCode === undefined ? {} : { failureCode: options.failureCode }),
    ...(options.step === undefined ? {} : { step: options.step }),
    ...(options.kitesurf === undefined ? {} : { kitesurf: options.kitesurf }),
  });

const mapClientError = (
  error: KitesurfClientError,
  operation: EvidenceWorkflowError["operation"],
  step?: number,
): EvidenceWorkflowError =>
  workflowError(error.reason === "cleanup" ? "browser" : operation, error.reason, {
    failureCode: error.reason === "unsupported" ? "unsupported" : "interrupted",
    ...(step === undefined ? {} : { step }),
    kitesurf: { operation: error.operation, reason: error.reason },
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
  ...(error.kitesurf === undefined ? {} : { kitesurf: error.kitesurf }),
});

const boundedClientEffect = <A>(
  effect: Effect.Effect<A, KitesurfClientError>,
  operation: Extract<EvidenceWorkflowError["operation"], "action" | "assertion" | "screenshot">,
  step: number,
  timeoutMillis: number,
): Effect.Effect<A, EvidenceWorkflowError> =>
  effect.pipe(
    Effect.mapError((error) => mapClientError(error, operation, step)),
    Effect.timeoutOrElse({
      duration: timeoutMillis,
      orElse: () =>
        Effect.fail(workflowError(operation, "deadline", { failureCode: "deadline", step })),
    }),
  );

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

const executeAction = (
  page: KitesurfPage,
  action: BrowserEvidenceJobV2["steps"][number]["action"],
  step: number,
): Effect.Effect<void, EvidenceWorkflowError> => {
  const effect =
    action.kind === "goto"
      ? page.goto(action.path)
      : action.kind === "click"
        ? page.click(action.locator)
        : action.kind === "fill"
          ? page.fill(action.locator, action.value)
          : page.press(action.locator, action.key);
  return boundedClientEffect(
    effect,
    "action",
    step,
    action.kind === "goto" || action.kind === "click"
      ? KITESURF_NAVIGATION_TIMEOUT_MILLIS
      : EVIDENCE_ACTION_TIMEOUT_MILLIS,
  );
};

const assertionEffect = (
  page: KitesurfPage,
  assertion: EvidenceAssertion,
): Effect.Effect<boolean, KitesurfClientError> =>
  assertion.kind === "visible"
    ? page.isVisible(assertion.locator)
    : assertion.kind === "textExact"
      ? page
          .textContent(assertion.locator)
          .pipe(Effect.map((actual) => actual === assertion.expected))
      : assertion.kind === "count"
        ? page.count(assertion.locator).pipe(Effect.map((actual) => actual === assertion.expected))
        : page.urlPath.pipe(Effect.map((actual) => actual === assertion.expected));

const executeAssertion = Effect.fnUntraced(function* (
  page: KitesurfPage,
  assertion: EvidenceAssertion,
  step: number,
  deadlineMillis: number,
) {
  const startedAtMillis = yield* Clock.currentTimeMillis;
  const remainingMillis = Math.max(0, deadlineMillis - startedAtMillis);
  if (remainingMillis === 0)
    return { kind: assertion.kind, passed: false } satisfies EvidenceAssertionResult;
  const poll = Effect.gen(function* () {
    for (;;) {
      const passed = yield* assertionEffect(page, assertion).pipe(
        Effect.mapError((error) => mapClientError(error, "assertion", step)),
      );
      if (passed) return true;
      const nowMillis = yield* Clock.currentTimeMillis;
      if (nowMillis >= deadlineMillis) return false;
      yield* Effect.sleep(
        Math.min(EVIDENCE_ASSERTION_POLL_INTERVAL_MILLIS, deadlineMillis - nowMillis),
      );
    }
  });
  const passed = yield* poll.pipe(
    Effect.timeoutOrElse({
      duration: remainingMillis,
      orElse: () => Effect.succeed(false),
    }),
  );
  return { kind: assertion.kind, passed } satisfies EvidenceAssertionResult;
});

const executeStep = Effect.fnUntraced(function* (
  control: EvidenceWorkflowControlShape,
  page: KitesurfPage,
  input: RunEvidenceWorkflowInput,
  jobStartedAtMillis: number,
  index: number,
) {
  const step = input.job.steps[index];
  if (step === undefined)
    return yield* workflowError("validate", "invalid", {
      failureCode: "interrupted",
      step: index,
    });
  const startedAtMillis = yield* Clock.currentTimeMillis;
  const startedAt = new Date(startedAtMillis).toISOString();
  yield* executeAction(page, step.action, index);
  const assertions: EvidenceAssertionResult[] = [];
  const assertionDeadlineMillis =
    (yield* Clock.currentTimeMillis) + EVIDENCE_ASSERTION_TIMEOUT_MILLIS;
  for (const assertion of step.expect) {
    assertions.push(yield* executeAssertion(page, assertion, index, assertionDeadlineMillis));
  }
  const firstAssertion = assertions[0];
  if (firstAssertion === undefined)
    return yield* workflowError("validate", "invalid", {
      failureCode: "interrupted",
      step: index,
    });
  const passed = assertions.every((assertion) => assertion.passed);
  const capture = input.job.capture?.screenshots === "after-each-step";
  const screenshot = capture
    ? yield* Effect.result(
        boundedClientEffect(
          page.screenshot,
          "screenshot",
          index,
          KITESURF_SCREENSHOT_TIMEOUT_MILLIS,
        ),
      )
    : Result.succeed<Uint8Array | undefined>(undefined);
  if (passed && Result.isFailure(screenshot)) {
    const failure = failureFor(screenshot.failure);
    yield* control
      .recordFailure(input.active, failure, diagnosticFor(screenshot.failure))
      .pipe(Effect.mapError((error) => mapControlError(error, "finalize", index)));
    return yield* screenshot.failure;
  }
  const completedAtMillis = yield* Clock.currentTimeMillis;
  const completedAt = new Date(completedAtMillis).toISOString();
  const offsetMillis = Math.max(0, completedAtMillis - jobStartedAtMillis);
  const publication: CompleteEvidenceStepPublicationV2 = {
    index,
    startedAt,
    completedAt,
    offsetMillis,
    assertions: [firstAssertion, ...assertions.slice(1)],
    ...(Result.isSuccess(screenshot) && screenshot.success !== undefined
      ? {
          frame: {
            frameId: `frame-${index + 1}`,
            bytes: screenshot.success,
            capturedAt: completedAt,
            offsetMillis,
          },
        }
      : {}),
  };
  yield* control
    .completeStep(input.active, publication)
    .pipe(Effect.mapError((error) => mapControlError(error, "publish", index)));
  if (!passed)
    return yield* workflowError("assertion", "assertion", {
      failureCode: "assertion_mismatch",
      step: index,
    });
});

const executeJob = Effect.fnUntraced(function* (
  client: KitesurfClientShape,
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
  const preview = yield* control
    .expose(input.active)
    .pipe(Effect.mapError((error) => mapControlError(error, "preview")));
  const jobStartedAtMillis = yield* Clock.currentTimeMillis;
  if (jobStartedAtMillis >= deadlineMillis)
    return yield* workflowError("browser", "deadline", { failureCode: "deadline" });
  const pageOptions = {
    origin: preview.origin,
    cookieSecret: preview.cookieSecret,
    viewport: input.job.viewport,
  };
  const usePage = (page: KitesurfPage) =>
    Effect.gen(function* () {
      yield* control
        .markRunning(input.active)
        .pipe(Effect.mapError((error) => mapControlError(error, "phase")));
      for (let index = 0; index < input.job.steps.length; index += 1) {
        yield* executeStep(control, page, input, jobStartedAtMillis, index).pipe(
          Effect.timeoutOrElse({
            duration: EVIDENCE_STEP_TIMEOUT_MILLIS,
            orElse: () =>
              Effect.fail(
                workflowError("action", "deadline", {
                  failureCode: "deadline",
                  step: index,
                }),
              ),
          }),
        );
      }
    });
  const recorded = input.job.capture.video ? client.withRecordedPage : undefined;
  if (input.job.capture.video && recorded === undefined)
    return yield* workflowError("video", "unsupported", { failureCode: "unsupported" });
  const execution = (
    recorded === undefined
      ? client
          .withPage(pageOptions, usePage)
          .pipe(Effect.map((value): KitesurfPageResult<void> => ({ value })))
      : recorded(pageOptions, usePage)
  ).pipe(
    Effect.mapError((error) =>
      Predicate.isTagged(error, "KitesurfClientError") ? mapClientError(error, "browser") : error,
    ),
  );
  const pageResult = yield* execution.pipe(
    Effect.timeoutOrElse({
      duration: deadlineMillis - jobStartedAtMillis,
      orElse: () => Effect.fail(workflowError("browser", "deadline", { failureCode: "deadline" })),
    }),
  );
  if (!input.job.capture.video) return;
  if (pageResult.video === undefined)
    return yield* workflowError("video", "unsupported", { failureCode: "unsupported" });
  const capturedAtMillis = yield* Clock.currentTimeMillis;
  yield* control
    .completeVideo(input.active, {
      artifactId: "recording",
      bytes: pageResult.video,
      capturedAt: new Date(capturedAtMillis).toISOString(),
      offsetMillis: Math.max(0, capturedAtMillis - jobStartedAtMillis),
    })
    .pipe(Effect.mapError((error) => mapControlError(error, "publish")));
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
  const client = yield* KitesurfClient;
  const control = yield* EvidenceWorkflowControl;
  const terminalCommitted = yield* Ref.make(false);
  const requestedStatus = yield* Ref.make<EvidenceTerminalStatus>("interrupted");
  const requestedFailure = yield* Ref.make<EvidenceFailure | undefined>(undefined);
  const main = Effect.gen(function* () {
    const execution = yield* Effect.result(executeJob(client, control, input));
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
