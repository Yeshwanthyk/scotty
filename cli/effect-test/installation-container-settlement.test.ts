import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Predicate, Result } from "effect";
import { TestClock } from "effect/testing";
import type { Plan } from "alchemy";
import { EXIT } from "../src/core.ts";
import { installationCommandFailure } from "../src/installation-diagnostics.ts";
import {
  assertContainerBaselineSettled,
  InstallationDeploymentError,
  isContainerPlanChanged,
  waitForContainerRollout,
  type ContainerControlPlaneReader,
} from "../src/installation-deployment.ts";
import type {
  ContainerControlPlaneHealthInstances,
  ContainerControlPlaneRollout,
  ContainerControlPlaneSnapshot,
} from "../../scripts/container-control-plane.mjs";

const failed = <A, E>(result: Result.Result<A, E>): E => {
  assert.isTrue(Result.isFailure(result));
  return (result as Result.Failure<E>).failure;
};

const makeSnapshot = (
  overrides: {
    readonly version?: number;
    readonly updatedAt?: string;
    readonly activeRolloutId?: string | null;
    readonly configurationDigest?: string;
    readonly health?: Partial<ContainerControlPlaneHealthInstances>;
    readonly rollouts?: ReadonlyArray<ContainerControlPlaneRollout>;
  } = {},
): ContainerControlPlaneSnapshot => ({
  application: {
    id: "app-test-123",
    name: "scotty-test-sandbox",
    version: overrides.version ?? 1,
    updatedAt: overrides.updatedAt ?? "2026-08-16T12:00:00.000Z",
    activeRolloutId: overrides.activeRolloutId ?? null,
    configurationDigest: overrides.configurationDigest ?? "digest-v1",
    health: {
      active: 1,
      assigned: 0,
      healthy: 0,
      stopped: 0,
      failed: 0,
      scheduling: 0,
      starting: 0,
      ...overrides.health,
    },
  },
  rollouts: overrides.rollouts ?? [],
});

const makeRollout = (
  overrides: {
    readonly id?: string;
    readonly status?: string;
    readonly currentVersion?: number;
    readonly targetVersion?: number;
    readonly healthy?: number;
    readonly failed?: number;
    readonly updatedInstances?: number;
    readonly totalInstances?: number;
  } = {},
): ContainerControlPlaneRollout => ({
  id: overrides.id ?? "rollout-1",
  status: overrides.status ?? "progressing",
  createdAt: "2026-08-16T12:00:01.000Z",
  lastUpdatedAt: "2026-08-16T12:00:05.000Z",
  currentVersion: overrides.currentVersion ?? 1,
  targetVersion: overrides.targetVersion ?? 2,
  health: {
    healthy: overrides.healthy ?? 0,
    failed: overrides.failed ?? 0,
    scheduling: 0,
    starting: 0,
  },
  progress: {
    totalSteps: 1,
    currentStep: 1,
    updatedInstances: overrides.updatedInstances ?? 0,
    totalInstances: overrides.totalInstances ?? 1,
  },
});

const makeSyntheticPlan = (resources: Record<string, "create" | "update" | "noop">): Plan.Plan => ({
  resources: Object.fromEntries(
    Object.entries(resources).map(([id, action]) => [
      id,
      {
        action,
        bindings: [],
        downstream: [],
        props: {},
        provider: {} as never,
        mode: undefined,
        resource: {} as never,
        state: {} as never,
      },
    ]),
  ),
  actions: {},
  deletions: {},
  actionDeletions: {},
  output: {},
});

describe("installation container rollout settlement", () => {
  it.effect("settled rollout completes the deployment wait", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const before = makeSnapshot({ version: 1 });
      let callCount = 0;
      const readControlPlane: ContainerControlPlaneReader = () =>
        Effect.sync(() => {
          callCount++;
          if (callCount === 1) {
            return makeSnapshot({
              version: 1,
              activeRolloutId: "rollout-1",
              rollouts: [makeRollout({ status: "progressing" })],
            });
          }
          return makeSnapshot({
            version: 2,
            configurationDigest: "digest-v2",
            rollouts: [
              makeRollout({
                status: "completed",
                updatedInstances: 1,
                totalInstances: 1,
              }),
            ],
          });
        });

      const fiber = yield* waitForContainerRollout(
        before,
        { accountId: "acc-1", applicationId: "app-test-123" },
        { readControlPlane, pollMs: 5_000 },
      ).pipe(Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust(5_000);
      const settled = yield* Fiber.join(fiber);
      assert.strictEqual(settled.application.version, 2);
      assert.strictEqual(callCount, 2);
    }),
  );

  it.effect("rollout reported failed yields a typed error", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const before = makeSnapshot({ version: 1 });
      const readControlPlane: ContainerControlPlaneReader = () =>
        Effect.succeed(
          makeSnapshot({
            version: 1,
            rollouts: [makeRollout({ status: "failed" })],
          }),
        );

      const result = yield* Effect.result(
        waitForContainerRollout(
          before,
          { accountId: "acc-1", applicationId: "app-test-123" },
          { readControlPlane, pollMs: 5_000 },
        ),
      );

      const error = failed(result);
      assert.isTrue(Predicate.isTagged(error, "InstallationDeploymentError"));
      assert.strictEqual(error.message, "Container rollout finished as failed.");
    }),
  );

  it.effect("times out when rollout does not settle within timeout limit", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const before = makeSnapshot({ version: 1 });
      const readControlPlane: ContainerControlPlaneReader = () =>
        Effect.succeed(
          makeSnapshot({
            version: 1,
            activeRolloutId: "rollout-1",
            rollouts: [makeRollout({ status: "progressing" })],
          }),
        );

      const fiber = yield* waitForContainerRollout(
        before,
        { accountId: "acc-1", applicationId: "app-test-123" },
        { readControlPlane, pollMs: 5_000, timeoutMs: 600_000 },
      ).pipe(Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust(600_000);
      const result = yield* Effect.result(Fiber.join(fiber));

      const error = failed(result);
      assert.isTrue(Predicate.isTagged(error, "InstallationDeploymentError"));
      assert.strictEqual(
        error.message,
        "Container rollout did not settle within 10 minutes: Container rollout is progressing.",
      );
    }),
  );

  it.effect("waits for health convergence before considering rollout completed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const before = makeSnapshot({ version: 1 });
      let callCount = 0;
      const readControlPlane: ContainerControlPlaneReader = () =>
        Effect.sync(() => {
          callCount++;
          if (callCount === 1) {
            return makeSnapshot({
              version: 2,
              configurationDigest: "digest-v2",
              rollouts: [
                makeRollout({
                  status: "completed",
                  failed: 1,
                  updatedInstances: 0,
                  totalInstances: 1,
                }),
              ],
            });
          }
          return makeSnapshot({
            version: 2,
            configurationDigest: "digest-v2",
            rollouts: [
              makeRollout({
                status: "completed",
                failed: 0,
                updatedInstances: 1,
                totalInstances: 1,
              }),
            ],
          });
        });

      const fiber = yield* waitForContainerRollout(
        before,
        { accountId: "acc-1", applicationId: "app-test-123" },
        { readControlPlane, pollMs: 5_000 },
      ).pipe(Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust(5_000);
      const settled = yield* Fiber.join(fiber);
      assert.strictEqual(settled.application.version, 2);
      assert.strictEqual(callCount, 2);
    }),
  );

  it.effect("settles application-only updates after quiet period", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000);
      const before = makeSnapshot({
        version: 1,
        updatedAt: "2026-08-16T12:00:00.000Z",
      });
      const readControlPlane: ContainerControlPlaneReader = () =>
        Effect.succeed(
          makeSnapshot({
            version: 1,
            updatedAt: "2026-08-16T12:01:00.000Z",
            rollouts: [],
          }),
        );

      const fiber = yield* waitForContainerRollout(
        before,
        { accountId: "acc-1", applicationId: "app-test-123" },
        { readControlPlane, containerAction: "updated", pollMs: 5_000 },
      ).pipe(Effect.forkChild({ startImmediately: true }));

      yield* TestClock.adjust(60_000);
      const settled = yield* Fiber.join(fiber);
      assert.strictEqual(settled.application.version, 1);
    }),
  );

  it("detects container plan changes correctly", () => {
    const noopPlan = makeSyntheticPlan({
      SandboxContainer: "noop",
      MonolithWorker: "update",
    });
    assert.isFalse(isContainerPlanChanged(noopPlan));

    const absentPlan = makeSyntheticPlan({
      MonolithWorker: "update",
    });
    assert.isFalse(isContainerPlanChanged(absentPlan));

    const updatePlan = makeSyntheticPlan({
      SandboxContainer: "update",
    });
    assert.isTrue(isContainerPlanChanged(updatePlan));

    const createPlan = makeSyntheticPlan({
      SandboxContainer: "create",
    });
    assert.isTrue(isContainerPlanChanged(createPlan));
  });

  it.effect("asserts settled container baseline before deploy", () =>
    Effect.gen(function* () {
      const cleanBaseline = makeSnapshot({ version: 1, activeRolloutId: null, rollouts: [] });
      const cleanResult = yield* Effect.result(assertContainerBaselineSettled(cleanBaseline));
      assert.isTrue(Result.isSuccess(cleanResult));

      const activeRolloutIdBaseline = makeSnapshot({
        version: 1,
        activeRolloutId: "rollout-prior",
        rollouts: [],
      });
      const activeRolloutResult = yield* Effect.result(
        assertContainerBaselineSettled(activeRolloutIdBaseline),
      );
      const activeRolloutError = failed(activeRolloutResult);
      assert.isTrue(Predicate.isTagged(activeRolloutError, "InstallationDeploymentError"));
      assert.strictEqual(
        activeRolloutError.message,
        "Container application already has an active rollout.",
      );

      const progressingRolloutBaseline = makeSnapshot({
        version: 1,
        activeRolloutId: null,
        rollouts: [makeRollout({ status: "progressing" })],
      });
      const progressingResult = yield* Effect.result(
        assertContainerBaselineSettled(progressingRolloutBaseline),
      );
      const progressingError = failed(progressingResult);
      assert.isTrue(Predicate.isTagged(progressingError, "InstallationDeploymentError"));
      assert.strictEqual(
        progressingError.message,
        "Container application already has an active rollout.",
      );
    }),
  );

  it.effect("surfaces rollout settlement failure through the diagnostic error envelope", () =>
    Effect.gen(function* () {
      const home = yield* Effect.tryPromise({
        try: () => mkdtemp(join(tmpdir(), "scotty-settlement-diag-")),
        catch: (cause) => new Error(String(cause)),
      });
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const error = new InstallationDeploymentError({
            message: "Container rollout finished as failed.",
          });
          const failureResult = yield* Effect.result(
            installationCommandFailure(home, {})(error, {
              code: "installation_deploy_failed",
              message: "Could not deploy the Scotty installation",
              hint: "Check Cloudflare authentication and Docker, then retry scotty deploy.",
              operation: "deploy",
              phase: "apply",
              installationName: "home",
              profile: "default",
            }),
          );
          const failure = failed(failureResult);
          assert.strictEqual(failure.code, "installation_deploy_failed");
          assert.strictEqual(failure.message, "Could not deploy the Scotty installation");
          assert.strictEqual(failure.exitCode, EXIT.GENERIC);
          assert.isTrue(failure.hint.includes("Diagnostic:"));
          const diagPath = join(home, ".scotty", "diagnostics", "deploy-apply.json");
          const content = yield* Effect.tryPromise({
            try: () => readFile(diagPath, "utf8"),
            catch: (cause) => new Error(String(cause)),
          });
          assert.isTrue(content.includes("Container rollout finished as failed."));
        }),
        Effect.promise(() => rm(home, { recursive: true, force: true })),
      );
    }),
  );
});
