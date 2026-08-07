import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { vi } from "vitest";

vi.mock("@cloudflare/playwright", () => ({ launch: vi.fn() }));
import { TestClock } from "effect/testing";
import {
  emptyEvidencePreviewAccounting,
  type BrowserEvidenceJobV1,
  type CompleteEvidenceStepPublicationV1,
  type EvidenceActiveJobV1,
  type EvidenceFailure,
  type EvidenceJobSummaryV1,
} from "../src/evidence-contracts";
import {
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

const defaultJob: BrowserEvidenceJobV1 = {
  version: 1,
  port: 4_173,
  capture: { screenshots: "after-each-step", replay: true },
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
  step: BrowserEvidenceJobV1["steps"][number],
): EvidenceActiveJobV1["stepPlan"][number] => ({
  name: step.name,
  action: step.action.kind,
  assertions: [step.expect[0].kind, ...step.expect.slice(1).map((assertion) => assertion.kind)],
});

const activeFor = (
  job: BrowserEvidenceJobV1,
  deadlineAt = new Date(NOW + 60_000).toISOString(),
): EvidenceActiveJobV1 => ({
  version: 1,
  sequence: 0,
  jobId: "job-test",
  status: "accepted",
  acceptedAt: new Date(NOW).toISOString(),
  totalSteps: job.steps.length,
  completedSteps: 0,
  replay: job.capture?.replay ?? false,
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
  options: { readonly closePageFails?: boolean } = {},
): KitesurfClientShape =>
  KitesurfClient.of({
    withPage: (_pageOptions, use) =>
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
                      options.closePageFails === true
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
        () => Effect.sync(() => events.push("browser:close")),
      ),
  });

interface ControlState {
  readonly events: Array<string>;
  readonly publications: Array<CompleteEvidenceStepPublicationV1>;
  failure: EvidenceFailure | undefined;
}

const makeControl = (
  state: ControlState,
  options: { readonly exposeNever?: boolean; readonly finalizeFails?: boolean } = {},
): EvidenceWorkflowControlShape =>
  EvidenceWorkflowControl.of({
    expose: () =>
      options.exposeNever === true
        ? Effect.never
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
    recordFailure: (_active, failure) =>
      Effect.sync(() => {
        state.events.push(`failure:${failure.code}`);
        state.failure = failure;
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
              version: 1,
              sequence: active.sequence,
              jobId: active.jobId,
              status,
              acceptedAt: active.acceptedAt,
              completedAt: new Date(NOW + 1).toISOString(),
              totalSteps: active.totalSteps,
              completedSteps: state.publications.length,
              replay: active.replay,
              steps: [],
              frameCount: state.publications.filter(
                (publication) => publication.frame !== undefined,
              ).length,
              ...(state.failure === undefined ? {} : { failure: state.failure }),
            } satisfies EvidenceJobSummaryV1;
          }),
  });

const execute = (
  job: BrowserEvidenceJobV1,
  page: KitesurfPage,
  state: ControlState,
  options: {
    readonly closePageFails?: boolean;
    readonly exposeNever?: boolean;
    readonly finalizeFails?: boolean;
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

const emptyState = (): ControlState => ({ events: [], publications: [], failure: undefined });

describe("Kitesurf evidence workflow", () => {
  it.effect(
    "executes every assertion sequentially, publishes the PNG, and cleans up before success",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW);
        const state = emptyState();
        const result = yield* execute(defaultJob, makePage(), state);

        assert.deepStrictEqual(result, {
          version: 1,
          jobId: "job-test",
          status: "succeeded",
          summaryUrl: "/s/session/evidence/job-test",
          completedSteps: 1,
          frameCount: 1,
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

  it.effect("dispatches all four declarative action kinds exactly once and appends in order", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const state = emptyState();
      const actions: Array<string> = [];
      const locator = { kind: "testId", value: "control" } as const;
      const job: BrowserEvidenceJobV1 = {
        version: 1,
        port: 4_173,
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
      const result = yield* execute(
        defaultJob,
        makePage({ textContent: () => Effect.succeed(privatePageText) }),
        state,
      );

      assert.strictEqual(result.status, "failed");
      assert.deepInclude(result, { failure: { code: "assertion_mismatch", step: 0 } });
      assert.isFalse(JSON.stringify({ result, state }).includes(privatePageText));
      assert.strictEqual(state.publications[0].assertions[1].passed, false);
      assert.notProperty(state.publications[0].assertions[1], "actual");
      assert.deepStrictEqual(state.publications[0].frame?.bytes, PNG);
    }),
  );

  it.effect("classifies unsupported actions and never publishes a step", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const state = emptyState();
      const job: BrowserEvidenceJobV1 = {
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
      const job: BrowserEvidenceJobV1 = {
        ...defaultJob,
        capture: undefined,
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
      assert.strictEqual(state.publications[0].frame, undefined);
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

  it.effect("bounds preview exposure by the accepted job deadline", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const state = emptyState();
      const fiber = yield* execute(defaultJob, makePage(), state, {
        exposeNever: true,
      }).pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.yieldNow;
      yield* TestClock.adjust(60_000);
      const result = yield* Fiber.join(fiber);

      assert.strictEqual(result.status, "interrupted");
      assert.deepStrictEqual(result.failure, { code: "deadline" });
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
});
