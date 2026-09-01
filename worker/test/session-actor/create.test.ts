import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Predicate } from "effect";
import { actorAlarmSchedulerLayer } from "../../src/session-actor/alarm";
import type { ReadinessProof, SessionIdentity } from "../../src/session-actor/authority";
import type { AcceptedDecision, Decision, EffectIntent } from "../../src/session-actor/decision";
import { ActorEffectRunner, actorEffectRunnerLayer } from "../../src/session-actor/effect-runner";
import type { CommittedProviderEffectIntent } from "../../src/session-actor/effects";
import { type EffectObservation, ProviderEffectExecutor } from "../../src/session-actor/effects";
import type { SessionActorInput } from "../../src/session-actor/input";
import type { LifecycleJournalEvent } from "../../src/session-actor/journal";
import { decide } from "../../src/session-actor/reducer";
import {
  CreateProviderFailure,
  type CreateProviderResult,
  type CreateTransitionProviderShape,
  createProviderEffectExecutorLayer,
  createTransitionProviderLayer,
} from "../../src/session-actor/transitions/create";

const T0 = "2026-03-04T00:00:00.000Z";
const T1 = "2026-03-04T00:01:00.000Z";
const DEADLINE = "2026-03-04T01:00:00.000Z";

const session: SessionIdentity = {
  id: "create-session",
  title: "Create session",
  repository: "owner/disposable",
  execution: { provider: "cloudflare", runtimeName: "runtime-create-session" },
  createdAt: T0,
};

const runtime = {
  providerRuntimeId: "provider-runtime-1",
  runtimeGeneration: "runtime-generation-1",
  containerIncarnation: "container-incarnation-1",
};

const supervisor = {
  processId: "supervisor-process-1",
  supervisorEpoch: "supervisor-epoch-1",
  runtimeGeneration: runtime.runtimeGeneration,
  containerIncarnation: runtime.containerIncarnation,
};

const transport = {
  transportId: "transport-1",
  supervisorEpoch: supervisor.supervisorEpoch,
  runtimeGeneration: runtime.runtimeGeneration,
  containerIncarnation: runtime.containerIncarnation,
};

const createCommand = (): SessionActorInput => ({
  _tag: "CreateCommand",
  expectedRevision: 0,
  correlationId: "create-correlation",
  nonce: "create-nonce",
  attempt: "create-attempt",
  timestamp: T0,
  deadlineAt: DEADLINE,
  session,
});

const accepted = (decision: Decision): AcceptedDecision => {
  assert.ok(Predicate.isTagged(decision, "Accepted"));
  return decision;
};

const providerIntent = (
  decision: AcceptedDecision,
): Exclude<EffectIntent, { _tag: "ArmDeadline" }> => {
  const intent = decision.effectIntents.find(
    (candidate) => !Predicate.isTagged(candidate, "ArmDeadline"),
  );
  assert.ok(intent !== undefined);
  return intent;
};

const committed = (decision: AcceptedDecision): CommittedProviderEffectIntent => {
  const authority = decision.nextAuthority;
  assert.ok(Predicate.isTagged(authority.state, "Transitioning"));
  const transition = authority.state.transition;
  const journalEvent: LifecycleJournalEvent = {
    sequence: authority.revision,
    revision: authority.revision,
    timestamp: decision.journalEvent.timestamp,
    correlationId: decision.journalEvent.correlationId,
    transitionNonce: transition.nonce,
    eventType: decision.journalEvent.eventType,
    transitionKind: "Create",
    transitionPhase: transition.phase,
    resultCode: decision.journalEvent.resultCode,
    causeSequence: null,
    causeAttempt: transition.attempt,
  };
  return { authority, journalEvent, intent: providerIntent(decision) };
};

const result = <Tag extends CreateProviderResult["_tag"]>(
  value: Extract<CreateProviderResult, { readonly _tag: Tag }>,
): Extract<CreateProviderResult, { readonly _tag: Tag }> => value;

const successProvider = (
  overrides: Partial<CreateTransitionProviderShape> = {},
): CreateTransitionProviderShape => ({
  lookupPayload: () => Effect.succeed({ reference: "private-create-payload-1" }),
  prepareWorkspace: () =>
    Effect.succeed(
      result({
        _tag: "WorkspacePrepared",
        workspaceId: "workspace-1",
        observedAt: T1,
        resultCode: "workspace_prepared",
      }),
    ),
  materializeRuntime: () =>
    Effect.succeed(
      result({
        _tag: "RuntimeMaterialized",
        runtime,
        observedAt: T1,
        resultCode: "runtime_materialized",
      }),
    ),
  confirmRuntimeReady: () =>
    Effect.succeed(
      result({
        _tag: "RuntimeReadyConfirmed",
        runtime,
        observedAt: T1,
        resultCode: "runtime_ready",
      }),
    ),
  startSupervisor: () =>
    Effect.succeed(
      result({
        _tag: "SupervisorStarted",
        processId: supervisor.processId,
        observedAt: T1,
        resultCode: "supervisor_started",
      }),
    ),
  confirmSupervisorReady: () =>
    Effect.succeed(
      result({
        _tag: "SupervisorReadyConfirmed",
        supervisor,
        observedAt: T1,
        resultCode: "supervisor_ready",
      }),
    ),
  verifyTransport: () =>
    Effect.succeed(
      result({
        _tag: "TransportVerified",
        transport,
        observedAt: T1,
        resultCode: "transport_verified",
      }),
    ),
  reconcile: () =>
    Effect.fail(
      new CreateProviderFailure({
        outcome: "unknown_after_admission",
        safeResultCode: "reconciliation_still_unknown",
        observedAt: T1,
      }),
    ),
  ...overrides,
});

const executorLayer = (provider: CreateTransitionProviderShape) =>
  createProviderEffectExecutorLayer.pipe(Layer.provide(createTransitionProviderLayer(provider)));

const runnerLayer = (provider: CreateTransitionProviderShape) =>
  actorEffectRunnerLayer.pipe(
    Layer.provide(
      Layer.merge(
        actorAlarmSchedulerLayer(() => Effect.void),
        executorLayer(provider),
      ),
    ),
  );

const execute = (provider: CreateTransitionProviderShape, effect: CommittedProviderEffectIntent) =>
  Effect.flatMap(ProviderEffectExecutor, (executor) => executor.execute(effect)).pipe(
    Effect.provide(executorLayer(provider)),
  );

const runThroughBoundary = (
  provider: CreateTransitionProviderShape,
  effect: CommittedProviderEffectIntent,
) =>
  Effect.flatMap(ActorEffectRunner, (runner) => runner.run(effect)).pipe(
    Effect.provide(runnerLayer(provider)),
  );

const observedInput = (observation: EffectObservation): SessionActorInput => {
  assert.ok(Predicate.isTagged(observation, "Observation"));
  return observation.input;
};

describe("create transition executor", () => {
  it.effect("reaches Warm only after matching runtime, supervisor, and transport proof", () =>
    Effect.gen(function* () {
      const provider = successProvider();
      let decision = accepted(decide(undefined, createCommand()));
      const visited: string[] = [];

      for (let index = 0; index < 7; index += 1) {
        const authority = decision.nextAuthority;
        assert.ok(Predicate.isTagged(authority.state, "Transitioning"));
        visited.push(authority.state.transition.phase);
        const input = yield* execute(provider, committed(decision));
        const next = decide(authority, input);
        assert.ok(Predicate.isTagged(next, "Accepted"), JSON.stringify({ visited, next }));
        decision = next;
      }

      assert.ok(Predicate.isTagged(decision.nextAuthority.state, "Stable"));
      assert.ok(Predicate.isTagged(decision.nextAuthority.state.stable, "Warm"));
      const readiness: ReadinessProof = decision.nextAuthority.state.stable.readiness;
      assert.deepStrictEqual(readiness, { runtime, supervisor, transport });
      assert.deepStrictEqual(visited, [
        "IntentCommitted",
        "WorkspacePreparing",
        "RuntimeMaterializing",
        "RuntimeReady",
        "SupervisorStarting",
        "SupervisorReady",
        "TransportVerifying",
      ]);
    }),
  );

  it.effect("fences late reducer input and mismatched generation proof", () =>
    Effect.gen(function* () {
      const provider = successProvider();
      const admitted = accepted(decide(undefined, createCommand()));
      const firstInput = yield* execute(provider, committed(admitted));
      const progressed = accepted(decide(admitted.nextAuthority, firstInput));
      const late = decide(progressed.nextAuthority, firstInput);
      assert.ok(Predicate.isTagged(late, "Rejected"));
      assert.strictEqual(late.code, "duplicate");

      let decision = progressed;
      while (
        Predicate.isTagged(decision.nextAuthority.state, "Transitioning") &&
        decision.nextAuthority.state.transition.phase !== "RuntimeReady"
      ) {
        const input = yield* execute(provider, committed(decision));
        decision = accepted(decide(decision.nextAuthority, input));
      }
      const staleRuntime = { ...runtime, runtimeGeneration: "stale-runtime-generation" };
      const staleProvider = successProvider({
        confirmRuntimeReady: () =>
          Effect.succeed(
            result({
              _tag: "RuntimeReadyConfirmed",
              runtime: staleRuntime,
              observedAt: T1,
              resultCode: "runtime_ready",
            }),
          ),
      });
      const failure = yield* Effect.result(execute(staleProvider, committed(decision)));
      assert.ok(Predicate.isTagged(failure, "Failure"));
      assert.strictEqual(failure.failure.safeResultCode, "create_stale_provider_proof");
    }),
  );

  it.effect("reconciles an unknown provider outcome without redispatching the phase", () =>
    Effect.gen(function* () {
      const admitted = accepted(decide(undefined, createCommand()));
      const payloadInput = yield* execute(successProvider(), committed(admitted));
      const preparing = accepted(decide(admitted.nextAuthority, payloadInput));
      let prepareCalls = 0;
      let reconcileCalls = 0;
      const provider = successProvider({
        prepareWorkspace: () => {
          prepareCalls += 1;
          return Effect.fail(
            new CreateProviderFailure({
              outcome: "unknown_after_admission",
              safeResultCode: "workspace_response_lost",
              observedAt: T1,
            }),
          );
        },
        reconcile: () => {
          reconcileCalls += 1;
          return Effect.succeed(
            result({
              _tag: "WorkspacePrepared",
              workspaceId: "workspace-1",
              observedAt: T1,
              resultCode: "workspace_reconciled",
            }),
          );
        },
      });
      const unknown = observedInput(yield* runThroughBoundary(provider, committed(preparing)));
      const reconciling = accepted(decide(preparing.nextAuthority, unknown));
      assert.ok(Predicate.isTagged(reconciling.nextAuthority.state, "Transitioning"));
      assert.strictEqual(reconciling.nextAuthority.state.transition.mode, "reconciling");

      const reconciledInput = yield* execute(provider, committed(reconciling));
      const progressed = accepted(decide(reconciling.nextAuthority, reconciledInput));
      assert.ok(Predicate.isTagged(progressed.nextAuthority.state, "Transitioning"));
      assert.strictEqual(progressed.nextAuthority.state.transition.phase, "RuntimeMaterializing");
      assert.strictEqual(progressed.nextAuthority.state.transition.mode, "executing");
      assert.strictEqual(prepareCalls, 1);
      assert.strictEqual(reconcileCalls, 1);
    }),
  );

  it.effect("turns a confirmed provider rejection into a fenced Failed observation", () =>
    Effect.gen(function* () {
      const admitted = accepted(decide(undefined, createCommand()));
      const payloadInput = yield* execute(successProvider(), committed(admitted));
      const preparing = accepted(decide(admitted.nextAuthority, payloadInput));
      const provider = successProvider({
        prepareWorkspace: () =>
          Effect.fail(
            new CreateProviderFailure({
              outcome: "rejected_before_admission",
              safeResultCode: "workspace_rejected",
              observedAt: T1,
            }),
          ),
      });
      const failedInput = observedInput(yield* runThroughBoundary(provider, committed(preparing)));
      const failed = accepted(decide(preparing.nextAuthority, failedInput));
      assert.ok(Predicate.isTagged(failed.nextAuthority.state, "Stable"));
      assert.ok(Predicate.isTagged(failed.nextAuthority.state.stable, "Failed"));
      assert.strictEqual(failed.nextAuthority.state.stable.code, "workspace_rejected");
    }),
  );

  it.effect("fails safely after restart when the private payload reference is unavailable", () =>
    Effect.gen(function* () {
      const admitted = accepted(decide(undefined, createCommand()));
      const payloadInput = yield* execute(successProvider(), committed(admitted));
      const preparing = accepted(decide(admitted.nextAuthority, payloadInput));
      let workspaceCalls = 0;
      const restartedProvider = successProvider({
        lookupPayload: () =>
          Effect.fail(
            new CreateProviderFailure({
              outcome: "rejected_before_admission",
              safeResultCode: "create_payload_reference_missing",
              observedAt: T1,
            }),
          ),
        prepareWorkspace: () => {
          workspaceCalls += 1;
          return Effect.succeed(
            result({
              _tag: "WorkspacePrepared",
              workspaceId: "must-not-run",
              observedAt: T1,
              resultCode: "must_not_run",
            }),
          );
        },
      });
      const failedInput = observedInput(
        yield* runThroughBoundary(restartedProvider, committed(preparing)),
      );
      const failed = accepted(decide(preparing.nextAuthority, failedInput));
      assert.ok(Predicate.isTagged(failed.nextAuthority.state, "Stable"));
      assert.ok(Predicate.isTagged(failed.nextAuthority.state.stable, "Failed"));
      assert.strictEqual(
        failed.nextAuthority.state.stable.code,
        "create_payload_reference_missing",
      );
      assert.strictEqual(workspaceCalls, 0);
    }),
  );
});
