import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Match, Predicate, Result, Schema } from "effect";
import {
  ActorAlarmOutcomeUnknown,
  actorAlarmSchedulerLayer,
  type ActorAlarmFence,
} from "../../src/session-actor/alarm";
import { SessionActor, sessionActorLayer } from "../../src/session-actor/actor";
import { actorEffectRunnerLayer } from "../../src/session-actor/effect-runner";
import {
  ProviderEffectBoundaryFailure,
  providerEffectExecutorLayer,
  type CommittedProviderEffectIntent,
} from "../../src/session-actor/effects";
import type {
  BackupProof,
  ReadinessProof,
  SessionAuthority,
  Transition,
} from "../../src/session-actor/authority";
import { AuthorityStateSchema, StableStateSchema } from "../../src/session-actor/authority";
import type { SessionActorInput } from "../../src/session-actor/input";
import { ActorFactSchema } from "../../src/session-actor/input";
import {
  actorStoreLayer,
  makeActorStore,
  type ActorStoragePort,
  type RawActorStorageSnapshot,
} from "../../src/session-actor/store";
import { phases, type TransitionKind } from "../../src/session-actor/transition";

const T0 = "2026-03-03T00:00:00.000Z";
const T1 = "2026-03-03T00:01:00.000Z";
const DEADLINE = "2026-03-03T01:00:00.000Z";
const session = {
  id: "session-restart",
  title: "Restart",
  repository: "owner/repository",
  execution: { provider: "cloudflare" as const, runtimeName: "runtime-restart" },
  createdAt: T0,
};
const readiness: ReadinessProof = {
  runtime: {
    providerRuntimeId: "provider-1",
    runtimeGeneration: "runtime-1",
    containerIncarnation: "container-1",
  },
  supervisor: {
    processId: "pi-1",
    supervisorEpoch: "supervisor-1",
    runtimeGeneration: "runtime-1",
    containerIncarnation: "container-1",
  },
  transport: {
    transportId: "transport-1",
    supervisorEpoch: "supervisor-1",
    runtimeGeneration: "runtime-1",
    containerIncarnation: "container-1",
  },
};
const backupIdentity = {
  backupId: "backup-1",
  preparedAt: T0,
  confirmedAt: T1,
  sourceRuntimeGeneration: "runtime-1",
};
const backups: BackupProof = {
  ownedBackupIds: ["backup-1"],
  prepared: backupIdentity,
  currentBackupId: "backup-1",
};
const isActorFact = Schema.is(ActorFactSchema);

const transition = (kind: TransitionKind, phase: string): Transition => {
  const common = {
    nonce: `nonce-${kind}`,
    attempt: `attempt-${kind}`,
    startedAt: T0,
    lastProgressAt: T1,
    deadlineAt: DEADLINE,
    mode: "executing" as const,
  };
  return Match.value(kind).pipe(
    Match.when(
      "Create",
      () =>
        ({
          _tag: "Create",
          ...common,
          origin: "Absent",
          phase: phase as (typeof phases.Create)[number],
          proof: { workspaceId: "workspace-1", readiness },
        }) satisfies Transition,
    ),
    Match.when(
      "Checkpoint",
      () =>
        ({
          _tag: "Checkpoint",
          ...common,
          origin: "Warm",
          phase: phase as (typeof phases.Checkpoint)[number],
          proof: { readiness, piStoppedAt: T1, backup: backups },
        }) satisfies Transition,
    ),
    Match.when(
      "Sleep",
      () =>
        ({
          _tag: "Sleep",
          ...common,
          origin: "Warm",
          phase: phase as (typeof phases.Sleep)[number],
          proof: {
            readiness,
            piStoppedAt: T1,
            backup: backups,
            stop: { requestedAt: T0, observedAt: T1, runtimeGeneration: "runtime-1" },
          },
        }) satisfies Transition,
    ),
    Match.when(
      "Resume",
      () =>
        ({
          _tag: "Resume",
          ...common,
          origin: "Sleeping",
          phase: phase as (typeof phases.Resume)[number],
          proof: {
            backup: backupIdentity,
            ownedBackupIds: backups.ownedBackupIds,
            lastStable: "Sleeping",
            watchdogArmedAt: T0,
            readiness,
          },
        }) satisfies Transition,
    ),
    Match.when(
      "WarmWork",
      () =>
        ({
          _tag: "WarmWork",
          ...common,
          origin: "Warm",
          phase: phase as (typeof phases.WarmWork)[number],
          workKind: "Evidence",
          proof: {
            readiness,
            backups,
            activity: null,
            activityGeneration: "activity-1",
            resultCode: "settled",
          },
        }) satisfies Transition,
    ),
    Match.when(
      "Vaporize",
      () =>
        ({
          _tag: "Vaporize",
          ...common,
          origin: "Warm",
          phase: phase as (typeof phases.Vaporize)[number],
          proof: {
            revokedAt: T1,
            cleanup: {
              absent: [
                "runtime",
                "backups",
                "evidence",
                "grants",
                "hatch",
                "idempotency",
                "schedules",
              ],
              lastObservedAt: T1,
            },
          },
        }) satisfies Transition,
    ),
    Match.exhaustive,
  );
};

const authority = (transition: Transition): SessionAuthority => ({
  session,
  revision: 1,
  state: { _tag: "Transitioning", transition },
});

describe("session actor restart", () => {
  it.effect("reconstructs every transition phase from storage without runtime-memory state", () =>
    Effect.gen(function* () {
      for (const kind of Object.keys(phases) as ReadonlyArray<TransitionKind>) {
        for (const phase of phases[kind]) {
          const expectedTransition = transition(kind, phase);
          const expected = authority(expectedTransition);
          const port: ActorStoragePort = {
            read: () =>
              Promise.resolve({
                authority: expected,
                revision: 1,
                journalSequence: 1,
                journalTail: {
                  sequence: 1,
                  revision: 1,
                  timestamp: T1,
                  correlationId: `correlation-${kind}`,
                  transitionNonce: expectedTransition.nonce,
                  eventType: "progressed",
                  transitionKind: kind,
                  transitionPhase: phase,
                  resultCode: "persisted",
                  causeSequence: null,
                  causeAttempt: expectedTransition.attempt,
                },
              }),
            transaction: () => Promise.reject(new Error("not used")),
          };
          const reconstructed = yield* makeActorStore(port).read;
          assert.deepStrictEqual(reconstructed.authority, expected);
          assert.strictEqual(reconstructed.revision, 1);
          assert.strictEqual(reconstructed.journalTail?.transitionPhase, phase);
        }
      }
    }),
  );

  const createCommand = (): SessionActorInput => ({
    _tag: "CreateCommand",
    expectedRevision: 0,
    correlationId: "correlation-create",
    nonce: "nonce-create",
    attempt: "attempt-create",
    timestamp: T0,
    deadlineAt: DEADLINE,
    session,
  });

  const actorPort = (cutTransaction: number | undefined, afterCommit: boolean) => {
    let raw: RawActorStorageSnapshot = {};
    let transactionCount = 0;
    const port: ActorStoragePort = {
      read: () => Promise.resolve(raw),
      transaction: (operation) => {
        transactionCount += 1;
        const plan = operation(raw);
        if (Predicate.isTagged(plan, "NoCommit")) return Promise.resolve(plan.outcome);
        const cut = transactionCount === cutTransaction;
        if (cut && !afterCommit) return Promise.reject(new Error("cut"));
        raw = {
          authority: plan.write.authority,
          revision: plan.write.revision,
          journalSequence: plan.write.journalSequence,
          journalTail: plan.write.appendJournal,
          evidence: raw.evidence,
        };
        return cut ? Promise.reject(new Error("cut")) : Promise.resolve(plan.outcome);
      },
    };
    return { port, snapshot: () => raw };
  };

  const staleObservation = (committed: CommittedProviderEffectIntent): SessionActorInput => {
    assert.ok(AuthorityStateSchema.guards.Transitioning(committed.authority.state));
    if (!AuthorityStateSchema.guards.Transitioning(committed.authority.state))
      return createCommand();
    const current = committed.authority.state.transition;
    return {
      _tag: "ActorFact",
      revision: committed.authority.revision,
      transitionNonce: "stale-nonce",
      attempt: current.attempt,
      expectedPhase: current.phase,
      timestamp: T1,
      correlationId: "correlation-observation",
      nextPhase: "WorkspacePreparing",
      proof: current.proof,
      resultCode: "observed",
    };
  };

  const validObservation = (committed: CommittedProviderEffectIntent): SessionActorInput => {
    const stale = staleObservation(committed);
    assert.ok(isActorFact(stale));
    if (!isActorFact(stale)) return stale;
    assert.ok(AuthorityStateSchema.guards.Transitioning(committed.authority.state));
    if (!AuthorityStateSchema.guards.Transitioning(committed.authority.state)) return stale;
    return { ...stale, transitionNonce: committed.authority.state.transition.nonce };
  };

  const runActor = (
    port: ActorStoragePort,
    execute: (
      committed: CommittedProviderEffectIntent,
    ) => Effect.Effect<SessionActorInput, ProviderEffectBoundaryFailure>,
    arm: (fence: ActorAlarmFence) => Effect.Effect<void, ActorAlarmOutcomeUnknown> = () =>
      Effect.void,
  ) => {
    const runner = actorEffectRunnerLayer.pipe(
      Layer.provide(
        Layer.merge(actorAlarmSchedulerLayer(arm), providerEffectExecutorLayer(execute)),
      ),
    );
    const actor = sessionActorLayer.pipe(Layer.provide(Layer.merge(actorStoreLayer(port), runner)));
    return Effect.flatMap(SessionActor, (service) => service.handle(createCommand())).pipe(
      Effect.provide(actor),
    );
  };

  it.effect("does not dispatch when an ambiguous intent commit cannot be confirmed", () =>
    Effect.gen(function* () {
      const memory = actorPort(1, false);
      let providerCalls = 0;
      const result = yield* Effect.result(
        runActor(memory.port, (committed) => {
          providerCalls += 1;
          return Effect.succeed(staleObservation(committed));
        }),
      );
      assert.ok(Result.isFailure(result));
      assert.ok(Predicate.isTagged(result.failure, "ActorStoreUnconfirmedCommit"));
      assert.strictEqual(providerCalls, 0);
      assert.deepStrictEqual(memory.snapshot(), {});
    }),
  );

  it.effect("does not dispatch a provider effect after alarm scheduling is ambiguous", () =>
    Effect.gen(function* () {
      const memory = actorPort(undefined, false);
      let providerCalls = 0;
      const result = yield* Effect.result(
        runActor(
          memory.port,
          (committed) => {
            providerCalls += 1;
            return Effect.succeed(staleObservation(committed));
          },
          (fence) =>
            Effect.fail(
              new ActorAlarmOutcomeUnknown({
                alarmId: fence.alarmId,
                transitionNonce: fence.transitionNonce,
                attempt: fence.attempt,
              }),
            ),
        ),
      );
      assert.ok(Result.isFailure(result));
      assert.ok(Predicate.isTagged(result.failure, "ActorAlarmOutcomeUnknown"));
      assert.strictEqual(providerCalls, 0);
      assert.strictEqual(memory.snapshot().revision, 1);
    }),
  );

  it.effect("rereads an after-commit ambiguity before dispatching committed intents", () =>
    Effect.gen(function* () {
      const memory = actorPort(1, true);
      let providerCalls = 0;
      const result = yield* runActor(memory.port, (committed) => {
        providerCalls += 1;
        return Effect.succeed(staleObservation(committed));
      });
      assert.strictEqual(providerCalls, 1);
      assert.ok(Predicate.isTagged(result.decision, "Rejected"));
      assert.deepInclude(result.decision, { code: "stale_nonce" });
      assert.strictEqual(memory.snapshot().revision, 1);
    }),
  );

  it.effect("enters reconciliation when a provider acted before observation commit was lost", () =>
    Effect.gen(function* () {
      const memory = actorPort(2, false);
      const providerIntents: string[] = [];
      const result = yield* runActor(memory.port, (committed) => {
        providerIntents.push(
          Predicate.isTagged(committed.intent, "ExecutePhase")
            ? "ExecutePhase"
            : "ReconcileTransition",
        );
        return Effect.succeed(
          Predicate.isTagged(committed.intent, "ExecutePhase")
            ? validObservation(committed)
            : staleObservation(committed),
        );
      });
      assert.deepStrictEqual(providerIntents, ["ExecutePhase", "ReconcileTransition"]);
      assert.strictEqual(result.committed.length, 2);
      const reconciled = result.committed[1]?.authority;
      assert.ok(
        reconciled !== undefined && AuthorityStateSchema.guards.Transitioning(reconciled.state),
      );
      assert.strictEqual(reconciled.state.transition.mode, "reconciling");
      assert.strictEqual(reconciled.revision, 2);
      assert.deepInclude(result.committed[1]?.journalEvent, {
        eventType: "provider_reconciling",
        resultCode: "observation_commit_unknown",
      });
      assert.strictEqual(memory.snapshot().revision, 2);
    }),
  );

  it.effect("feeds a confirmed pre-admission rejection back through the reducer", () =>
    Effect.gen(function* () {
      const memory = actorPort(undefined, false);
      const result = yield* runActor(memory.port, (committed) =>
        Effect.fail(
          new ProviderEffectBoundaryFailure({
            expectedRevision: committed.authority.revision,
            transitionNonce: committed.intent.transitionNonce,
            attempt: committed.intent.attempt,
            expectedPhase: committed.intent.phase,
            expectedProviderRuntimeId: null,
            outcome: "rejected_before_admission",
            safeResultCode: "dispatch_rejected",
            observedAt: T1,
          }),
        ),
      );
      assert.ok(Predicate.isTagged(result.decision, "Accepted"));
      assert.strictEqual(result.committed.length, 2);
      assert.strictEqual(result.committed[1]?.journalEvent.resultCode, "dispatch_rejected");
      assert.strictEqual(memory.snapshot().revision, 2);
      const failed = result.committed[1]?.authority;
      assert.ok(failed !== undefined && AuthorityStateSchema.guards.Stable(failed.state));
      assert.ok(StableStateSchema.guards.Failed(failed.state.stable));
      assert.deepInclude(failed.state.stable, { code: "dispatch_rejected" });
    }),
  );

  it.effect("journals an admitted unknown provider outcome as reconciliation", () =>
    Effect.gen(function* () {
      const memory = actorPort(undefined, false);
      let providerCalls = 0;
      const result = yield* runActor(memory.port, (committed) => {
        providerCalls += 1;
        if (providerCalls > 1) return Effect.succeed(staleObservation(committed));
        return Effect.fail(
          new ProviderEffectBoundaryFailure({
            expectedRevision: committed.authority.revision,
            transitionNonce: committed.intent.transitionNonce,
            attempt: committed.intent.attempt,
            expectedPhase: committed.intent.phase,
            expectedProviderRuntimeId: null,
            outcome: "unknown_after_admission",
            safeResultCode: "provider_response_lost",
            observedAt: T1,
          }),
        );
      });
      assert.strictEqual(providerCalls, 2);
      assert.strictEqual(result.committed.length, 2);
      const reconciled = result.committed[1]?.authority;
      assert.strictEqual(reconciled?.revision, 2);
      assert.ok(
        reconciled !== undefined && AuthorityStateSchema.guards.Transitioning(reconciled.state),
      );
      assert.strictEqual(reconciled.state.transition.mode, "reconciling");
      assert.deepInclude(result.committed[1]?.journalEvent, {
        eventType: "provider_reconciling",
        resultCode: "provider_response_lost",
      });
    }),
  );

  it.effect("does not loop when a reconciliation observation commit is ambiguous", () =>
    Effect.gen(function* () {
      const memory = actorPort(3, false);
      let providerCalls = 0;
      const result = yield* Effect.result(
        runActor(memory.port, (committed) => {
          providerCalls += 1;
          if (providerCalls > 1) return Effect.succeed(validObservation(committed));
          return Effect.fail(
            new ProviderEffectBoundaryFailure({
              expectedRevision: committed.authority.revision,
              transitionNonce: committed.intent.transitionNonce,
              attempt: committed.intent.attempt,
              expectedPhase: committed.intent.phase,
              expectedProviderRuntimeId: null,
              outcome: "unknown_after_admission",
              safeResultCode: "provider_response_lost",
              observedAt: T1,
            }),
          );
        }),
      );
      assert.ok(Result.isFailure(result));
      assert.ok(Predicate.isTagged(result.failure, "ActorStoreUnconfirmedCommit"));
      assert.strictEqual(providerCalls, 2);
      assert.strictEqual(memory.snapshot().revision, 2);
      const retained = yield* makeActorStore(memory.port).read;
      assert.ok(
        retained.authority !== undefined &&
          AuthorityStateSchema.guards.Transitioning(retained.authority.state),
      );
      assert.strictEqual(retained.authority.state.transition.mode, "reconciling");
    }),
  );
});
