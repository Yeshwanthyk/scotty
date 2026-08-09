import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Fiber } from "effect";
import { vi } from "vitest";

vi.mock("@cloudflare/playwright", () => ({ launch: vi.fn() }));
import { TestClock } from "effect/testing";
import {
  emptyEvidencePreviewAccounting,
  type BrowserEvidenceJobV2,
  type CompleteEvidenceStepPublicationV2,
  type CompleteEvidenceVideoPublicationV2,
  type EvidenceActiveJobV2,
  type EvidenceDiagnostic,
  type EvidenceFailure,
  type EvidenceJobSummaryV2,
} from "../src/evidence-contracts";
import {
  EVIDENCE_ASSERTION_TIMEOUT_MILLIS,
  EvidenceWorkflowControl,
  EvidenceWorkflowControlError,
  runEvidenceWorkflow,
  type EvidenceWorkflowControlShape,
} from "../src/evidence-workflow";
import {
  KitesurfClient,
  KitesurfClientError,
  type KitesurfClientShape,
  type KitesurfPage,
} from "../src/kitesurf-client";

const NOW = Date.parse("2026-08-06T12:00:00.000Z");
const PNG = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
]);

const defaultJob: BrowserEvidenceJobV2 = {
  version: 2,
  port: 4_173,
  viewport: { width: 1_280, height: 720 },
  capture: { screenshots: "after-each-step", video: false },
  steps: [
    {
      name: "Open app",
      action: { kind: "goto", path: "/ready" },
      expect: [
        { kind: "visible", locator: { kind: "testId", value: "ready" } },
        {
          kind: "textExact",
          locator: { kind: "testId", value: "ready" },
          expected: "Ready",
        },
        { kind: "count", locator: { kind: "css", value: "main" }, expected: 1 },
        { kind: "urlPath", expected: "/ready" },
      ],
    },
  ],
};

const stepPlanFor = (
  step: BrowserEvidenceJobV2["steps"][number],
): EvidenceActiveJobV2["stepPlan"][number] => ({
  name: step.name,
  action: step.action.kind,
  assertions: [step.expect[0].kind, ...step.expect.slice(1).map((assertion) => assertion.kind)],
});

const activeFor = (
  job: BrowserEvidenceJobV2,
  deadlineAt = new Date(NOW + 60_000).toISOString(),
): EvidenceActiveJobV2 => ({
  version: 2,
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

const makePage = (overrides: Partial<KitesurfPage> = {}): KitesurfPage => ({
  goto: () => Effect.void,
  click: () => Effect.void,
  fill: () => Effect.void,
  press: () => Effect.void,
  isVisible: () => Effect.succeed(true),
  textContent: () => Effect.succeed("Ready"),
  count: () => Effect.succeed(1),
  urlPath: Effect.succeed("/ready"),
  screenshot: Effect.succeed(PNG),
  ...overrides,
});

const makeClient = (
  page: KitesurfPage,
  events: Array<string>,
  options: {
    readonly closeBrowserFails?: boolean;
    readonly closePageFails?: boolean;
    readonly closePageInterrupts?: boolean;
    readonly videoBytes?: Uint8Array;
  } = {},
): KitesurfClientShape => {
  const videoBytes = options.videoBytes;
  const withLifecycle = <A, E, R>(use: (page: KitesurfPage) => Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => events.push("browser:open")),
      () =>
        Effect.acquireUseRelease(
          Effect.sync(() => events.push("context:open")),
          () =>
            Effect.acquireUseRelease(
              Effect.sync(() => events.push("page:open")),
              () => use(page),
              () =>
                Effect.sync(() => events.push("page:close")).pipe(
                  Effect.andThen(
                    options.closePageInterrupts === true
                      ? Effect.interrupt
                      : options.closePageFails === true
                        ? Effect.fail(
                            new KitesurfClientError({
                              operation: "close_page",
                              reason: "cleanup",
                            }),
                          )
                        : Effect.void,
                  ),
                ),
            ),
          () => Effect.sync(() => events.push("context:close")),
        ),
      () =>
        Effect.sync(() => events.push("browser:close")).pipe(
          Effect.andThen(
            options.closeBrowserFails === true
              ? Effect.fail(
                  new KitesurfClientError({ operation: "close_browser", reason: "cleanup" }),
                )
              : Effect.void,
          ),
        ),
    );
  return KitesurfClient.of({
    withPage: (_pageOptions, use) => withLifecycle(use),
    ...(videoBytes === undefined
      ? {}
      : {
          withRecordedPage: (_pageOptions, use) =>
            withLifecycle(use).pipe(
              Effect.map((value) => {
                events.push("video:flush");
                return { value, video: videoBytes };
              }),
            ),
        }),
  });
};

interface ControlState {
  readonly events: Array<string>;
  readonly publications: Array<CompleteEvidenceStepPublicationV2>;
  videoPublication: CompleteEvidenceVideoPublicationV2 | undefined;
  failure: EvidenceFailure | undefined;
  diagnostic: EvidenceDiagnostic | undefined;
}

const makeControl = (
  state: ControlState,
  options: { readonly exposeFailsAtDeadline?: boolean; readonly finalizeFails?: boolean } = {},
): EvidenceWorkflowControlShape =>
  EvidenceWorkflowControl.of({
    expose: () =>
      options.exposeFailsAtDeadline === true
        ? Effect.sync(() => state.events.push("preview:expose:start")).pipe(
            Effect.andThen(Effect.sleep(60_000)),
            Effect.andThen(
              Effect.fail(
                new EvidenceWorkflowControlError({
                  operation: "expose",
                  failureCode: "interrupted",
                }),
              ),
            ),
          )
        : Effect.sync(() => {
            state.events.push("preview:expose");
            return {
              origin: "https://4173-session-route.preview.scotty.example",
              cookieSecret: "private-preview-cookie",
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
      options.finalizeFails === true
        ? Effect.sync(() => state.events.push("finalize:attempt")).pipe(
            Effect.andThen(
              Effect.fail(
                new EvidenceWorkflowControlError({
                  operation: "finalize",
                  failureCode: "interrupted",
                }),
              ),
            ),
          )
        : Effect.sync(() => {
            state.events.push("preview:unexpose");
            state.events.push(`terminal:${status}`);
            return {
              version: 2,
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
              frameCount: state.publications.filter(
                (publication) => publication.frame !== undefined,
              ).length,
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
            } satisfies EvidenceJobSummaryV2;
          }),
  });

const execute = (
  job: BrowserEvidenceJobV2,
  page: KitesurfPage,
  state: ControlState,
  options: {
    readonly closeBrowserFails?: boolean;
    readonly closePageFails?: boolean;
    readonly closePageInterrupts?: boolean;
    readonly exposeFailsAtDeadline?: boolean;
    readonly finalizeFails?: boolean;
    readonly videoBytes?: Uint8Array;
  } = {},
) =>
  runEvidenceWorkflow({
    active: activeFor(job),
    job,
    summaryUrl: "/s/session/evidence/job-test",
  }).pipe(
    Effect.provideService(KitesurfClient, makeClient(page, state.events, options)),
    Effect.provideService(EvidenceWorkflowControl, makeControl(state, options)),
  );

const emptyState = (): ControlState => ({
  events: [],
  publications: [],
  videoPublication: undefined,
  failure: undefined,
  diagnostic: undefined,
});

describe("Kitesurf evidence workflow", () => {
  it.effect(
    "executes every assertion sequentially, publishes the PNG, and cleans up before success",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const state = emptyState();
        const result = yield* execute(defaultJob, makePage(), state);

        assert.deepStrictEqual(result, {
          version: 2,
          jobId: "job-test",
          status: "succeeded",
          summaryUrl: "/s/session/evidence/job-test",
          completedSteps: 1,
          frameCount: 1,
          video: false,
        });
        assert.deepStrictEqual(state.publications[0].frame?.bytes, PNG);
        assert.isBelow(state.events.indexOf("step:0"), state.events.indexOf("page:close"));
        assert.isBelow(state.events.indexOf("page:close"), state.events.indexOf("context:close"));
        assert.isBelow(
          state.events.indexOf("context:close"),
          state.events.indexOf("browser:close"),
        );
        assert.isBelow(
          state.events.indexOf("browser:close"),
          state.events.indexOf("preview:unexpose"),
        );
        assert.isBelow(
          state.events.indexOf("preview:unexpose"),
          state.events.indexOf("terminal:succeeded"),
        );
      }),
  );

  it.effect("publishes a real WebM only after the recorded browser context closes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const state = emptyState();
      const webm = Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x81, 0x00]);
      const result = yield* execute(
        {
          ...defaultJob,
          capture: { screenshots: "after-each-step", video: true },
        },
        makePage(),
        state,
        { videoBytes: webm },
      );

      assert.deepInclude(result, { status: "succeeded", frameCount: 1, video: true });
      assert.deepStrictEqual(state.videoPublication?.bytes, webm);
      assert.isBelow(state.events.indexOf("context:close"), state.events.indexOf("video:flush"));
      assert.isBelow(state.events.indexOf("video:flush"), state.events.indexOf("video:publish"));
      assert.isBelow(
        state.events.indexOf("video:publish"),
        state.events.indexOf("terminal:succeeded"),
      );
    }),
  );

  it.effect("polls transient assertion mismatches with the Effect clock", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const state = emptyState();
      let visibleCalls = 0;
      const fiber = yield* execute(
        defaultJob,
        makePage({
          isVisible: () =>
            Effect.sync(() => {
              visibleCalls += 1;
              return visibleCalls >= 3;
            }),
        }),
        state,
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      assert.strictEqual(visibleCalls, 1);
      yield* TestClock.adjust(100);
      assert.strictEqual(visibleCalls, 2);
      yield* TestClock.adjust(100);
      const result = yield* Fiber.join(fiber);

      assert.strictEqual(visibleCalls, 3);
      assert.strictEqual(result.status, "succeeded");
    }),
  );

  it.effect("dispatches all four declarative action kinds exactly once and appends in order", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const state = emptyState();
      const actions: Array<string> = [];
      const locator = { kind: "testId", value: "control" } as const;
      const job: BrowserEvidenceJobV2 = {
        version: 2,
        port: 4_173,
        viewport: defaultJob.viewport,
        capture: defaultJob.capture,
        steps: [
          {
            name: "Goto",
            action: { kind: "goto", path: "/ready" },
            expect: [{ kind: "urlPath", expected: "/ready" }],
          },
          {
            name: "Click",
            action: { kind: "click", locator },
            expect: [{ kind: "visible", locator }],
          },
          {
            name: "Fill",
            action: { kind: "fill", locator, value: "private-fill" },
            expect: [{ kind: "count", locator, expected: 1 }],
          },
          {
            name: "Press",
            action: { kind: "press", locator, key: "Enter" },
            expect: [{ kind: "textExact", locator, expected: "Ready" }],
          },
        ],
      };
      const result = yield* execute(
        job,
        makePage({
          goto: () => Effect.sync(() => actions.push("goto")),
          click: () => Effect.sync(() => actions.push("click")),
          fill: () => Effect.sync(() => actions.push("fill")),
          press: () => Effect.sync(() => actions.push("press")),
        }),
        state,
      );

      assert.strictEqual(result.status, "succeeded");
      assert.deepStrictEqual(actions, ["goto", "click", "fill", "press"]);
      assert.deepStrictEqual(
        state.publications.map((publication) => publication.index),
        [0, 1, 2, 3],
      );
    }),
  );

  it.effect("publishes an assertion failure without undeclared page text", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const state = emptyState();
      const privatePageText = "undeclared-page-secret";
      const fiber = yield* execute(
        defaultJob,
        makePage({ textContent: () => Effect.succeed(privatePageText) }),
        state,
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* TestClock.adjust(EVIDENCE_ASSERTION_TIMEOUT_MILLIS);
      const result = yield* Fiber.join(fiber);

      assert.strictEqual(result.status, "failed");
      assert.deepInclude(result, { failure: { code: "assertion_mismatch", step: 0 } });
      assert.isFalse(JSON.stringify({ result, state }).includes(privatePageText));
      assert.strictEqual(state.publications[0].assertions[1].passed, false);
      assert.notProperty(state.publications[0].assertions[1], "actual");
      assert.deepStrictEqual(state.publications[0].frame?.bytes, PNG);
    }),
  );

  it.effect("reports a screenshot failure stage without exposing page data", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => vi.spyOn(console, "error").mockImplementation(() => undefined)),
      (errorLog) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(NOW);
          const state = emptyState();
          const result = yield* execute(
            defaultJob,
            makePage({
              screenshot: Effect.fail(
                new KitesurfClientError({ operation: "screenshot", reason: "ambiguous" }),
              ),
            }),
            state,
          );

          assert.strictEqual(result.status, "interrupted");
          assert.deepStrictEqual(result.failure, { code: "interrupted", step: 0 });
          assert.lengthOf(state.publications, 0);
          assert.strictEqual(errorLog.mock.calls[0]?.[0], "Evidence workflow failed");
          assert.deepStrictEqual(state.diagnostic, {
            operation: "screenshot",
            reason: "ambiguous",
            step: 0,
            kitesurf: { operation: "screenshot", reason: "ambiguous" },
          });
          assert.deepStrictEqual(errorLog.mock.calls[0]?.[1], {
            jobId: "job-test",
            operation: "screenshot",
            reason: "ambiguous",
            step: 0,
            kitesurf: { operation: "screenshot", reason: "ambiguous" },
          });
        }),
      (errorLog) => Effect.sync(() => errorLog.mockRestore()),
    ),
  );

  it.effect(
    "persists screenshot ambiguity before cleanup and keeps it through outer interruption",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() => vi.spyOn(console, "error").mockImplementation(() => undefined)),
        () =>
          Effect.gen(function* () {
            yield* TestClock.setTime(NOW);
            const state = emptyState();
            const exit = yield* execute(
              defaultJob,
              makePage({
                screenshot: Effect.fail(
                  new KitesurfClientError({ operation: "screenshot", reason: "ambiguous" }),
                ),
              }),
              state,
              { closePageInterrupts: true },
            ).pipe(Effect.exit);

            assert.isTrue(Exit.hasInterrupts(exit));
            assert.deepStrictEqual(state.failure, { code: "interrupted", step: 0 });
            assert.deepStrictEqual(state.diagnostic, {
              operation: "screenshot",
              reason: "ambiguous",
              step: 0,
              kitesurf: { operation: "screenshot", reason: "ambiguous" },
            });
            assert.isBelow(
              state.events.indexOf("failure:interrupted"),
              state.events.indexOf("page:close"),
            );
            assert.strictEqual(
              state.events.filter((event) => event === "failure:interrupted").length,
              2,
            );
          }),
        (errorLog) => Effect.sync(() => errorLog.mockRestore()),
      ),
  );

  it.effect("classifies unsupported actions and never publishes a step", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const state = emptyState();
      const job: BrowserEvidenceJobV2 = {
        ...defaultJob,
        steps: [
          {
            name: "Click",
            action: { kind: "click", locator: { kind: "testId", value: "submit" } },
            expect: [{ kind: "visible", locator: { kind: "testId", value: "done" } }],
          },
        ],
      };
      const result = yield* execute(
        job,
        makePage({
          click: () =>
            Effect.fail(new KitesurfClientError({ operation: "click", reason: "unsupported" })),
        }),
        state,
      );

      assert.strictEqual(result.status, "unsupported");
      assert.deepStrictEqual(result.failure, { code: "unsupported", step: 0 });
      assert.lengthOf(state.publications, 0);
      assert.isBelow(
        state.events.indexOf("browser:close"),
        state.events.indexOf("terminal:unsupported"),
      );
    }),
  );

  it.effect("does not leak a private fill value when a later close is ambiguous", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const state = emptyState();
      const privateFill = "private-fill-value";
      const job: BrowserEvidenceJobV2 = {
        ...defaultJob,
        capture: { screenshots: "after-each-step", video: false },
        steps: [
          {
            name: "Fill",
            action: {
              kind: "fill",
              locator: { kind: "testId", value: "token" },
              value: privateFill,
            },
            expect: [{ kind: "visible", locator: { kind: "testId", value: "token" } }],
          },
        ],
      };
      const result = yield* execute(job, makePage(), state, { closePageFails: true });

      assert.strictEqual(result.status, "interrupted");
      assert.deepStrictEqual(result.failure, { code: "interrupted" });
      assert.deepStrictEqual(state.publications[0].frame?.bytes, PNG);
      assert.isFalse(JSON.stringify({ result, state }).includes(privateFill));
      assert.isBelow(state.events.indexOf("page:close"), state.events.indexOf("context:close"));
      assert.isBelow(state.events.indexOf("context:close"), state.events.indexOf("browser:close"));
      assert.isBelow(
        state.events.indexOf("browser:close"),
        state.events.indexOf("preview:unexpose"),
      );
      assert.isNotTrue(state.events.includes("terminal:succeeded"));
    }),
  );

  it.effect("does not report success when browser cleanup remains ambiguous", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const state = emptyState();
      const result = yield* execute(defaultJob, makePage(), state, { closeBrowserFails: true });

      assert.strictEqual(result.status, "interrupted");
      assert.deepStrictEqual(result.failure, { code: "interrupted" });
      assert.deepInclude(state.diagnostic, {
        operation: "browser",
        reason: "cleanup",
        kitesurf: { operation: "close_browser", reason: "cleanup" },
      });
      assert.include(state.events, "browser:close");
      assert.notInclude(state.events, "terminal:succeeded");
    }),
  );

  it.effect("does not report success when preview finalization remains ambiguous", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const state = emptyState();

      yield* Effect.flip(execute(defaultJob, makePage(), state, { finalizeFails: true }));

      assert.isAtLeast(state.events.filter((event) => event === "finalize:attempt").length, 1);
      assert.notInclude(state.events, "terminal:succeeded");
      assert.isBelow(
        state.events.indexOf("browser:close"),
        state.events.indexOf("finalize:attempt"),
      );
    }),
  );

  it.effect(
    "lets the exposure authority own its deadline instead of interrupting it externally",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const state = emptyState();
        const fiber = yield* execute(defaultJob, makePage(), state, {
          exposeFailsAtDeadline: true,
        }).pipe(Effect.forkChild({ startImmediately: true }));
        while (!state.events.includes("preview:expose:start")) yield* Effect.yieldNow;
        yield* TestClock.adjust(60_000);
        const result = yield* Fiber.join(fiber);

        assert.strictEqual(result.status, "interrupted");
        assert.deepStrictEqual(result.failure, { code: "interrupted" });
        assert.notInclude(state.events, "browser:open");
        assert.include(state.events, "terminal:interrupted");
      }),
  );

  it.effect("marks deadline and caller interruption without bypassing cleanup", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const deadlineState = emptyState();
      const deadlineProgram = execute(
        defaultJob,
        makePage({ goto: () => Effect.never }),
        deadlineState,
      );
      const deadlineFiber = yield* deadlineProgram.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(60_000);
      const deadlineResult = yield* Fiber.join(deadlineFiber);
      assert.strictEqual(deadlineResult.status, "interrupted");
      assert.deepStrictEqual(deadlineResult.failure, { code: "deadline", step: 0 });
      assert.isBelow(
        deadlineState.events.indexOf("browser:close"),
        deadlineState.events.indexOf("terminal:interrupted"),
      );

      yield* TestClock.setTime(NOW);
      const interruptedState = emptyState();
      const interruptedFiber = yield* execute(
        defaultJob,
        makePage({ goto: () => Effect.never }),
        interruptedState,
      ).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(interruptedFiber);
      assert.include(interruptedState.events, "failure:interrupted");
      assert.include(interruptedState.events, "terminal:interrupted");
      assert.isBelow(
        interruptedState.events.indexOf("browser:close"),
        interruptedState.events.indexOf("preview:unexpose"),
      );
    }),
  );

  it.effect("allows a first navigation to take longer than a generic action", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const state = emptyState();
      const fiber = yield* execute(
        defaultJob,
        makePage({ goto: () => Effect.sleep(5_001) }),
        state,
      ).pipe(Effect.forkChild({ startImmediately: true }));

      yield* Effect.yieldNow;
      yield* TestClock.adjust(5_001);
      const result = yield* Fiber.join(fiber);

      assert.strictEqual(result.status, "succeeded");
      assert.include(state.events, "step:0");
      assert.include(state.events, "terminal:succeeded");
    }),
  );

  it.effect("allows one shared assertion phase to wait for app hydration", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const state = emptyState();
      const fiber = yield* execute(
        defaultJob,
        makePage({ isVisible: () => Effect.sleep(5_001).pipe(Effect.as(true)) }),
        state,
      ).pipe(Effect.forkChild({ startImmediately: true }));

      yield* Effect.yieldNow;
      yield* TestClock.adjust(5_001);
      const result = yield* Fiber.join(fiber);

      assert.strictEqual(result.status, "succeeded");
      assert.deepStrictEqual(
        state.publications[0].assertions.map((assertion) => assertion.passed),
        [true, true, true, true],
      );
    }),
  );

  it.effect("allows a link click to wait for navigation longer than a generic action", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const state = emptyState();
      const clickJob: BrowserEvidenceJobV2 = {
        ...defaultJob,
        steps: [
          {
            ...defaultJob.steps[0],
            action: { kind: "click", locator: { kind: "css", value: ".feature-link" } },
          },
        ],
      };
      const fiber = yield* execute(
        clickJob,
        makePage({ click: () => Effect.sleep(5_001) }),
        state,
      ).pipe(Effect.forkChild({ startImmediately: true }));

      yield* Effect.yieldNow;
      yield* TestClock.adjust(5_001);
      const result = yield* Fiber.join(fiber);

      assert.strictEqual(result.status, "succeeded");
      assert.include(state.events, "step:0");
      assert.include(state.events, "terminal:succeeded");
    }),
  );
});
