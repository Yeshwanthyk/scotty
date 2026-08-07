import { Clock, Context, Effect, Exit, Predicate, Ref, Result, Schema } from "effect";
import {
  type BrowserEvidenceJobV1,
  type BrowserEvidenceResultV1,
  type CompleteEvidenceStepPublicationV1,
  type EvidenceActiveJobV1,
  type EvidenceAssertion,
  type EvidenceAssertionResult,
  type EvidenceFailure,
  type EvidenceFailureCode,
  type EvidenceJobSummaryV1,
  type EvidenceTerminalStatus,
  type ExposedEvidencePreviewV1,
} from "./evidence-contracts";
import {
  KitesurfClient,
  type KitesurfClientError,
  type KitesurfClientShape,
  type KitesurfPage,
} from "./kitesurf-client";

export const EVIDENCE_ASSERTION_TIMEOUT_MILLIS = 5_000;
export const EVIDENCE_ACTION_TIMEOUT_MILLIS = 5_000;
export const EVIDENCE_STEP_TIMEOUT_MILLIS = 30_000;

export class EvidenceWorkflowError extends Schema.TaggedErrorClass<EvidenceWorkflowError>()(
  "EvidenceWorkflowError",
  {
    operation: Schema.Literals([
      "validate",
      "preview",
      "phase",
      "browser",
      "action",
      "assertion",
      "screenshot",
      "publish",
      "finalize",
    ]),
    reason: Schema.Literals([
      "invalid",
      "unsupported",
      "ambiguous",
      "assertion",
      "deadline",
      "cleanup",
      "state",
      "upstream",
    ]),
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
    active: EvidenceActiveJobV1,
  ) => Effect.Effect<ExposedEvidencePreviewV1, EvidenceWorkflowControlError>;
  readonly markRunning: (
    active: EvidenceActiveJobV1,
  ) => Effect.Effect<void, EvidenceWorkflowControlError>;
  readonly completeStep: (
    active: EvidenceActiveJobV1,
    input: CompleteEvidenceStepPublicationV1,
  ) => Effect.Effect<void, EvidenceWorkflowControlError>;
  readonly recordFailure: (
    active: EvidenceActiveJobV1,
    failure: EvidenceFailure,
  ) => Effect.Effect<void, EvidenceWorkflowControlError>;
  readonly finalize: (
    active: EvidenceActiveJobV1,
    status: EvidenceTerminalStatus,
  ) => Effect.Effect<EvidenceJobSummaryV1, EvidenceWorkflowControlError>;
}

export class EvidenceWorkflowControl extends Context.Service<
  EvidenceWorkflowControl,
  EvidenceWorkflowControlShape
>()("scotty/EvidenceWorkflowControl") {}

export interface RunEvidenceWorkflowInput {
  readonly active: EvidenceActiveJobV1;
  readonly job: BrowserEvidenceJobV1;
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

const mapClientError = (
  error: KitesurfClientError,
  operation: EvidenceWorkflowError["operation"],
  step?: number,
): EvidenceWorkflowError =>
  workflowError(error.reason === "cleanup" ? "browser" : operation, error.reason, {
    failureCode: error.reason === "unsupported" ? "unsupported" : "interrupted",
    ...(step === undefined ? {} : { step }),
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

const activeMatchesJob = (active: EvidenceActiveJobV1, job: BrowserEvidenceJobV1): boolean =>
  active.status === "accepted" &&
  active.exposure === "not_exposed" &&
  active.previewCookieDigest === null &&
  active.completedSteps === 0 &&
  active.steps.length === 0 &&
  active.frameCount === 0 &&
  active.port === job.port &&
  active.totalSteps === job.steps.length &&
  active.replay === (job.capture?.replay ?? false) &&
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
  action: BrowserEvidenceJobV1["steps"][number]["action"],
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
  return boundedClientEffect(effect, "action", step, EVIDENCE_ACTION_TIMEOUT_MILLIS);
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

const executeAssertion = (
  page: KitesurfPage,
  assertion: EvidenceAssertion,
  step: number,
): Effect.Effect<EvidenceAssertionResult, EvidenceWorkflowError> =>
  boundedClientEffect(
    assertionEffect(page, assertion),
    "assertion",
    step,
    EVIDENCE_ASSERTION_TIMEOUT_MILLIS,
  ).pipe(Effect.map((passed) => ({ kind: assertion.kind, passed })));

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
  for (const assertion of step.expect) {
    assertions.push(yield* executeAssertion(page, assertion, index));
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
        boundedClientEffect(page.screenshot, "screenshot", index, EVIDENCE_ACTION_TIMEOUT_MILLIS),
      )
    : Result.succeed<Uint8Array | undefined>(undefined);
  const completedAtMillis = yield* Clock.currentTimeMillis;
  const completedAt = new Date(completedAtMillis).toISOString();
  const offsetMillis = Math.max(0, completedAtMillis - jobStartedAtMillis);
  const publication: CompleteEvidenceStepPublicationV1 = {
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
  if (Result.isFailure(screenshot)) return yield* screenshot.failure;
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
  const execution = Effect.gen(function* () {
    const preview = yield* control
      .expose(input.active)
      .pipe(Effect.mapError((error) => mapControlError(error, "preview")));
    const jobStartedAtMillis = yield* Clock.currentTimeMillis;
    return yield* client
      .withPage(
        {
          origin: preview.origin,
          cookieSecret: preview.cookieSecret,
          ...(input.job.viewport === undefined ? {} : { viewport: input.job.viewport }),
        },
        (page) =>
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
          }),
      )
      .pipe(
        Effect.mapError((error) =>
          Predicate.isTagged(error, "KitesurfClientError")
            ? mapClientError(error, "browser")
            : error,
        ),
      );
  });
  return yield* execution.pipe(
    Effect.timeoutOrElse({
      duration: deadlineMillis - nowMillis,
      orElse: () => Effect.fail(workflowError("browser", "deadline", { failureCode: "deadline" })),
    }),
  );
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
  summary: EvidenceJobSummaryV1,
  summaryUrl: string,
): BrowserEvidenceResultV1 => ({
  version: 1,
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
    yield* Ref.set(requestedStatus, status);
    yield* Ref.set(requestedFailure, failure);
    if (failure !== undefined)
      yield* control
        .recordFailure(input.active, failure)
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
