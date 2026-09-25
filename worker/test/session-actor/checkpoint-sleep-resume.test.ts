import { sessionIdentityPin } from "../runtime-cli/fixtures";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";
import type {
  BackupIdentity,
  ReadinessProof,
  SessionAuthority,
  SessionIdentity,
} from "../../src/session-actor/authority";
import type { AcceptedDecision, Decision, EffectIntent } from "../../src/session-actor/decision";
import type { CommittedProviderEffectIntent } from "../../src/session-actor/effects";
import type { SessionActorInput } from "../../src/session-actor/input";
import type { LifecycleJournalEvent } from "../../src/session-actor/journal";
import { decide } from "../../src/session-actor/reducer";
import {
  executeCreateTransition,
  type CreateTransitionProviderShape,
} from "../../src/session-actor/transitions/create";
import { transitionKind } from "../../src/session-actor/transition";
import {
  CheckpointProviderFailure,
  type CheckpointProviderResult,
  type CheckpointTransitionProviderShape,
  executeCheckpointTransition,
} from "../../src/session-actor/transitions/checkpoint";
import {
  executeResumeTransition,
  ResumeProviderFailure,
  type ResumeTransitionProviderShape,
} from "../../src/session-actor/transitions/resume";
import {
  executeSleepTransition,
  type SleepTransitionProviderShape,
} from "../../src/session-actor/transitions/sleep";

const T0 = "2026-09-01T00:00:00.000Z";
const T1 = "2026-09-01T00:01:00.000Z";
const T2 = "2026-09-01T00:02:00.000Z";
const DEADLINE = "2026-09-01T01:00:00.000Z";
const hardCap = { durationSeconds: 3_600, deadlineAt: DEADLINE, generation: "hard-cap-1" };

const session: SessionIdentity = {
  id: "lifecycle-session",
  title: "Lifecycle session",
  repository: "owner/disposable",
  execution: { provider: "cloudflare", runtimeName: "runtime-lifecycle-session" },
  ...sessionIdentityPin,
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
const readiness: ReadinessProof = { runtime, supervisor, transport };
const backup: BackupIdentity = {
  backupId: "1ed4a6f4-7d9f-46b9-8a07-ef6d9c1dd64c",
  preparedAt: T1,
  confirmedAt: T2,
  sourceRuntimeGeneration: runtime.runtimeGeneration,
};

const warm = (): SessionAuthority => ({
  session,
  hardCap,
  revision: 1,
  state: {
    _tag: "Stable",
    stable: {
      _tag: "Warm",
      readiness,
      backups: { ownedBackupIds: [], prepared: null, currentBackupId: null },
      activity: null,
    },
  },
});

const oldBackup: BackupIdentity = { ...backup, backupId: "legacy-backup" };
const legacyWarm = (): SessionAuthority => ({
  ...warm(),
  state: {
    _tag: "Stable",
    stable: {
      _tag: "Warm",
      readiness,
      backups: {
        ownedBackupIds: [oldBackup.backupId],
        prepared: oldBackup,
        currentBackupId: oldBackup.backupId,
      },
      activity: null,
    },
  },
});

const createCommand = (): SessionActorInput => ({
  _tag: "CreateCommand",
  expectedRevision: 0,
  correlationId: "create-correlation",
  nonce: "create-nonce",
  attempt: "create-attempt",
  timestamp: T0,
  deadlineAt: DEADLINE,
  session,
  hardCap,
});

const command = (
  tag: "CheckpointCommand" | "SleepCommand" | "ResumeCommand",
  expectedRevision: number,
  attempt = backup.backupId,
): SessionActorInput => {
  const fields = {
    expectedRevision,
    correlationId: `${tag}-correlation`,
    nonce: `${tag}-nonce`,
    attempt,
    timestamp: T0,
    deadlineAt: DEADLINE,
  };
  return tag === "ResumeCommand"
    ? { _tag: tag, ...fields, nextHardCap: hardCap }
    : { _tag: tag, ...fields };
};

const accepted = (decision: Decision): AcceptedDecision => {
  assert.ok(Predicate.isTagged(decision, "Accepted"));
  return decision;
};

const providerIntent = (
  decision: AcceptedDecision,
): Exclude<EffectIntent, { readonly _tag: "ArmDeadline" | "ArmReconciliation" }> => {
  const intent = decision.effectIntents.find(
    (candidate) =>
      !Predicate.isTagged(candidate, "ArmDeadline") &&
      !Predicate.isTagged(candidate, "ArmReconciliation"),
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
    transitionKind: transitionKind(transition),
    transitionPhase: transition.phase,
    resultCode: decision.journalEvent.resultCode,
    causeSequence: null,
    causeAttempt: transition.attempt,
  };
  return { authority, journalEvent, intent: providerIntent(decision) };
};

const checkpointProvider = (): CheckpointTransitionProviderShape => ({
  quiescePi: () =>
    Effect.succeed({
      _tag: "PiQuiesced",
      piStoppedAt: T1,
      observedAt: T1,
      resultCode: "pi_stopped",
    } satisfies Extract<CheckpointProviderResult, { _tag: "PiQuiesced" }>),
  syncWorkspace: () =>
    Effect.succeed({ _tag: "WorkspaceSynced", observedAt: T1, resultCode: "workspace_synced" }),
  prepareBackup: () =>
    Effect.succeed({
      _tag: "BackupPrepared",
      backup: { ...backup, confirmedAt: null },
      observedAt: T1,
      resultCode: "backup_prepared",
    }),
  confirmBackup: () =>
    Effect.succeed({
      _tag: "BackupConfirmed",
      backup,
      observedAt: T2,
      resultCode: "backup_confirmed",
    }),
  restartSupervisor: () =>
    Effect.succeed({
      _tag: "SupervisorRestartRequested",
      observedAt: T2,
      resultCode: "supervisor_restart_requested",
    }),
  confirmTransportReady: () =>
    Effect.succeed({
      _tag: "ReadinessRestored",
      supervisor,
      transport,
      observedAt: T2,
      resultCode: "readiness_restored",
    }),
  verifyTransport: () =>
    Effect.succeed({
      _tag: "TransportVerified",
      transport,
      observedAt: T2,
      resultCode: "transport_verified",
    }),
  reconcile: () =>
    Effect.succeed({
      _tag: "TransportVerified",
      transport,
      observedAt: T2,
      resultCode: "transport_reconciled",
    }),
});

const stop = { requestedAt: T1, observedAt: T2, runtimeGeneration: runtime.runtimeGeneration };

const sleepProvider = (
  overrides: Partial<SleepTransitionProviderShape> = {},
): SleepTransitionProviderShape => ({
  quiescePi: () =>
    Effect.succeed({
      _tag: "PiQuiesced",
      piStoppedAt: T1,
      observedAt: T1,
      resultCode: "pi_stopped",
    }),
  syncWorkspace: () =>
    Effect.succeed({ _tag: "WorkspaceSynced", observedAt: T1, resultCode: "workspace_synced" }),
  prepareBackup: () =>
    Effect.succeed({
      _tag: "BackupPrepared",
      backup: { ...backup, confirmedAt: null },
      observedAt: T1,
      resultCode: "backup_prepared",
    }),
  confirmBackup: () =>
    Effect.succeed({
      _tag: "BackupConfirmed",
      backup,
      observedAt: T2,
      resultCode: "backup_confirmed",
    }),
  requestRuntimeStop: () =>
    Effect.succeed({
      _tag: "RuntimeStopRequested",
      requestedAt: stop.requestedAt,
      observedAt: T1,
      resultCode: "runtime_stop_requested",
    }),
  observeRuntimeStopped: () =>
    Effect.succeed({
      _tag: "RuntimeStopped",
      stop,
      observedAt: T2,
      resultCode: "runtime_stopped",
    }),
  confirmRuntimeStopped: () =>
    Effect.succeed({
      _tag: "RuntimeStopConfirmed",
      stop,
      observedAt: T2,
      resultCode: "runtime_stop_confirmed",
    }),
  reconcile: () =>
    Effect.succeed({
      _tag: "RuntimeStopConfirmed",
      stop,
      observedAt: T2,
      resultCode: "runtime_stop_reconciled",
    }),
  ...overrides,
});

const resumedRuntime = { ...runtime, runtimeGeneration: "runtime-generation-2" };
const resumedSupervisor = {
  ...supervisor,
  supervisorEpoch: "supervisor-epoch-2",
  runtimeGeneration: resumedRuntime.runtimeGeneration,
};
const resumedTransport = {
  ...transport,
  transportId: "transport-2",
  supervisorEpoch: resumedSupervisor.supervisorEpoch,
  runtimeGeneration: resumedRuntime.runtimeGeneration,
};

const resumeProvider = (
  overrides: Partial<ResumeTransitionProviderShape> = {},
): ResumeTransitionProviderShape => ({
  restoreCurrentBackup: () =>
    Effect.succeed({
      _tag: "BackupRestored",
      backupId: backup.backupId,
      observedAt: T1,
      resultCode: "backup_restored",
    }),
  confirmRuntimeReady: () =>
    Effect.succeed({
      _tag: "RuntimeReadyConfirmed",
      runtime: resumedRuntime,
      observedAt: T1,
      resultCode: "runtime_ready",
    }),
  startSupervisor: () =>
    Effect.succeed({
      _tag: "SupervisorStartRequested",
      observedAt: T1,
      resultCode: "supervisor_start_requested",
    }),
  confirmSupervisorReady: () =>
    Effect.succeed({
      _tag: "SupervisorReadyConfirmed",
      supervisor: resumedSupervisor,
      observedAt: T2,
      resultCode: "supervisor_ready",
    }),
  verifyTransport: () =>
    Effect.succeed({
      _tag: "TransportVerified",
      transport: resumedTransport,
      observedAt: T2,
      resultCode: "transport_verified",
    }),
  confirmTransportReady: () =>
    Effect.succeed({
      _tag: "TransportReadyConfirmed",
      transport: resumedTransport,
      observedAt: T2,
      resultCode: "transport_ready",
    }),
  reconcile: () =>
    Effect.fail(
      new ResumeProviderFailure({
        outcome: "unknown_after_admission",
        safeResultCode: "resume_still_unknown",
        observedAt: T2,
      }),
    ),
  ...overrides,
});

const createProvider = (): CreateTransitionProviderShape => ({
  lookupPayload: () => Effect.succeed({ reference: "private-create-payload" }),
  prepareWorkspace: () =>
    Effect.succeed({
      _tag: "WorkspacePrepared",
      workspaceId: "workspace-1",
      observedAt: T1,
      resultCode: "workspace_prepared",
    }),
  materializeRuntime: () =>
    Effect.succeed({
      _tag: "RuntimeMaterialized",
      runtime,
      observedAt: T1,
      resultCode: "runtime_materialized",
    }),
  confirmRuntimeReady: () =>
    Effect.succeed({
      _tag: "RuntimeReadyConfirmed",
      runtime,
      observedAt: T1,
      resultCode: "runtime_ready",
    }),
  startSupervisor: () =>
    Effect.succeed({
      _tag: "SupervisorStarted",
      processId: supervisor.processId,
      observedAt: T1,
      resultCode: "supervisor_started",
    }),
  confirmSupervisorReady: () =>
    Effect.succeed({
      _tag: "SupervisorReadyConfirmed",
      supervisor,
      observedAt: T1,
      resultCode: "supervisor_ready",
    }),
  verifyTransport: () =>
    Effect.succeed({
      _tag: "TransportVerified",
      transport,
      observedAt: T1,
      resultCode: "transport_verified",
    }),
  reconcile: () =>
    Effect.succeed({
      _tag: "TransportVerified",
      transport,
      observedAt: T1,
      resultCode: "transport_reconciled",
    }),
});

describe("checkpoint, sleep, and resume transition executors", () => {
  it.effect("runs create, sleep, resume, and sleep through to Sleeping", () =>
    Effect.gen(function* () {
      let decision = accepted(decide(undefined, createCommand()));
      for (let index = 0; index < 7; index += 1) {
        decision = accepted(
          decide(
            decision.nextAuthority,
            yield* executeCreateTransition(createProvider(), committed(decision)),
          ),
        );
      }
      assert.ok(Predicate.isTagged(decision.nextAuthority.state, "Stable"));
      assert.ok(Predicate.isTagged(decision.nextAuthority.state.stable, "Warm"));

      decision = accepted(
        decide(decision.nextAuthority, command("SleepCommand", decision.nextAuthority.revision)),
      );
      for (let index = 0; index < 7; index += 1) {
        decision = accepted(
          decide(
            decision.nextAuthority,
            yield* executeSleepTransition(sleepProvider(), committed(decision)),
          ),
        );
      }
      assert.ok(Predicate.isTagged(decision.nextAuthority.state, "Stable"));
      assert.ok(Predicate.isTagged(decision.nextAuthority.state.stable, "Sleeping"));

      decision = accepted(
        decide(decision.nextAuthority, command("ResumeCommand", decision.nextAuthority.revision)),
      );
      for (let index = 0; index < 6; index += 1) {
        decision = accepted(
          decide(
            decision.nextAuthority,
            yield* executeResumeTransition(resumeProvider(), committed(decision)),
          ),
        );
      }
      assert.ok(Predicate.isTagged(decision.nextAuthority.state, "Stable"));
      assert.ok(Predicate.isTagged(decision.nextAuthority.state.stable, "Warm"));
      assert.deepStrictEqual(decision.nextAuthority.state.stable.backups.confirmed, backup);

      const nextBackup: BackupIdentity = {
        ...backup,
        backupId: "second-sleep-backup",
        sourceRuntimeGeneration: resumedRuntime.runtimeGeneration,
      };
      const nextStop = { ...stop, runtimeGeneration: resumedRuntime.runtimeGeneration };
      const secondSleepProvider = sleepProvider({
        prepareBackup: () =>
          Effect.succeed({
            _tag: "BackupPrepared",
            backup: { ...nextBackup, confirmedAt: null },
            observedAt: T1,
            resultCode: "backup_prepared",
          }),
        confirmBackup: () =>
          Effect.succeed({
            _tag: "BackupConfirmed",
            backup: nextBackup,
            observedAt: T2,
            resultCode: "backup_confirmed",
          }),
        observeRuntimeStopped: () =>
          Effect.succeed({
            _tag: "RuntimeStopped",
            stop: nextStop,
            observedAt: T2,
            resultCode: "runtime_stopped",
          }),
        confirmRuntimeStopped: () =>
          Effect.succeed({
            _tag: "RuntimeStopConfirmed",
            stop: nextStop,
            observedAt: T2,
            resultCode: "runtime_stop_confirmed",
          }),
      });
      decision = accepted(
        decide(
          decision.nextAuthority,
          command("SleepCommand", decision.nextAuthority.revision, nextBackup.backupId),
        ),
      );
      for (let index = 0; index < 7; index += 1) {
        decision = accepted(
          decide(
            decision.nextAuthority,
            yield* executeSleepTransition(secondSleepProvider, committed(decision)),
          ),
        );
      }
      assert.ok(Predicate.isTagged(decision.nextAuthority.state, "Stable"));
      assert.ok(Predicate.isTagged(decision.nextAuthority.state.stable, "Sleeping"));
      assert.deepStrictEqual(decision.nextAuthority.state.stable.backup, nextBackup);
      assert.deepStrictEqual(decision.nextAuthority.state.stable.stop, nextStop);
    }),
  );

  it.effect("resumes only the sleeping current backup and rebuilds fenced readiness", () =>
    Effect.gen(function* () {
      let sleeping = accepted(decide(warm(), command("SleepCommand", 1)));
      for (let index = 0; index < 7; index += 1) {
        sleeping = accepted(
          decide(
            sleeping.nextAuthority,
            yield* executeSleepTransition(sleepProvider(), committed(sleeping)),
          ),
        );
      }
      let decision = accepted(
        decide(sleeping.nextAuthority, command("ResumeCommand", sleeping.nextAuthority.revision)),
      );
      for (let index = 0; index < 6; index += 1) {
        decision = accepted(
          decide(
            decision.nextAuthority,
            yield* executeResumeTransition(resumeProvider(), committed(decision)),
          ),
        );
      }
      assert.ok(Predicate.isTagged(decision.nextAuthority.state, "Stable"));
      assert.ok(Predicate.isTagged(decision.nextAuthority.state.stable, "Warm"));
      assert.deepStrictEqual(decision.nextAuthority.state.stable.readiness, {
        runtime: resumedRuntime,
        supervisor: resumedSupervisor,
        transport: resumedTransport,
      });
      assert.strictEqual(
        decision.nextAuthority.state.stable.backups.currentBackupId,
        backup.backupId,
      );
    }),
  );

  it.effect("sleeps only after the confirmed current backup and stopped runtime", () =>
    Effect.gen(function* () {
      let decision = accepted(decide(warm(), command("SleepCommand", 1)));
      for (let index = 0; index < 7; index += 1) {
        const input = yield* executeSleepTransition(sleepProvider(), committed(decision));
        decision = accepted(decide(decision.nextAuthority, input));
      }
      assert.ok(Predicate.isTagged(decision.nextAuthority.state, "Stable"));
      assert.ok(Predicate.isTagged(decision.nextAuthority.state.stable, "Sleeping"));
      assert.strictEqual(decision.nextAuthority.state.stable.backup.backupId, backup.backupId);
      assert.deepStrictEqual(decision.nextAuthority.state.stable.ownedBackupIds, [backup.backupId]);
      assert.strictEqual(decision.nextAuthority.state.stable.stop.observedAt, T2);
    }),
  );

  it.effect("checkpoints through prepared then confirmed backup before returning Warm", () =>
    Effect.gen(function* () {
      let decision = accepted(decide(warm(), command("CheckpointCommand", 1)));
      const visited: string[] = [];
      const currentBackupIds: Array<string | null> = [];
      const ownedBackupIds: Array<ReadonlyArray<string>> = [];
      for (let index = 0; index < 7; index += 1) {
        assert.ok(Predicate.isTagged(decision.nextAuthority.state, "Transitioning"));
        const transition = decision.nextAuthority.state.transition;
        visited.push(transition.phase);
        assert.ok(Predicate.isTagged(transition, "Checkpoint"));
        currentBackupIds.push(transition.proof.backup.currentBackupId);
        ownedBackupIds.push(transition.proof.backup.ownedBackupIds);
        const input = yield* executeCheckpointTransition(checkpointProvider(), committed(decision));
        decision = accepted(decide(decision.nextAuthority, input));
      }
      assert.deepStrictEqual(visited, [
        "Quiescing",
        "PiStopped",
        "Syncing",
        "BackupPrepared",
        "BackupConfirmed",
        "SupervisorRestarting",
        "TransportReady",
      ]);
      assert.deepStrictEqual(currentBackupIds, [
        null,
        null,
        null,
        null,
        backup.backupId,
        backup.backupId,
        backup.backupId,
      ]);
      assert.deepStrictEqual(ownedBackupIds[2], [backup.backupId]);
      assert.ok(Predicate.isTagged(decision.nextAuthority.state, "Stable"));
      assert.ok(Predicate.isTagged(decision.nextAuthority.state.stable, "Warm"));
      assert.strictEqual(
        decision.nextAuthority.state.stable.backups.currentBackupId,
        backup.backupId,
      );
    }),
  );

  it.effect("does not promote an unconfirmed Warm backup when Sleep prepares another", () =>
    Effect.gen(function* () {
      const initial = warm();
      assert.ok(Predicate.isTagged(initial.state, "Stable"));
      assert.ok(Predicate.isTagged(initial.state.stable, "Warm"));
      const authority: SessionAuthority = {
        ...initial,
        state: {
          _tag: "Stable",
          stable: {
            ...initial.state.stable,
            backups: {
              ownedBackupIds: [oldBackup.backupId],
              prepared: { ...oldBackup, confirmedAt: null },
              confirmed: null,
              currentBackupId: null,
            },
          },
        },
      };
      let decision = accepted(decide(authority, command("SleepCommand", authority.revision)));
      for (let index = 0; index < 3; index += 1)
        decision = accepted(
          decide(
            decision.nextAuthority,
            yield* executeSleepTransition(sleepProvider(), committed(decision)),
          ),
        );
      assert.ok(Predicate.isTagged(decision.nextAuthority.state, "Transitioning"));
      assert.ok(Predicate.isTagged(decision.nextAuthority.state.transition, "Sleep"));
      assert.strictEqual(decision.nextAuthority.state.transition.phase, "BackupPrepared");
      assert.strictEqual(decision.nextAuthority.state.transition.proof.backup.confirmed, null);
    }),
  );

  it.effect(
    "sleeps from legacy Warm without confirmed and preserves the old backup until confirmation",
    () =>
      Effect.gen(function* () {
        let decision = accepted(decide(legacyWarm(), command("SleepCommand", 1)));
        const progressed: SessionAuthority[] = [];
        for (let index = 0; index < 7; index += 1) {
          const input = yield* executeSleepTransition(sleepProvider(), committed(decision));
          decision = accepted(decide(decision.nextAuthority, input));
          progressed.push(decision.nextAuthority);
        }
        const prepared = progressed[2];
        assert.ok(prepared !== undefined);
        assert.ok(Predicate.isTagged(prepared.state, "Transitioning"));
        const transition = prepared.state.transition;
        assert.ok(Predicate.isTagged(transition, "Sleep"));
        assert.strictEqual(transition.phase, "BackupPrepared");
        assert.strictEqual(transition.proof.backup.currentBackupId, oldBackup.backupId);
        assert.deepStrictEqual(transition.proof.backup.confirmed, oldBackup);
        assert.strictEqual(transition.proof.backup.prepared?.confirmedAt, null);
        assert.ok(Predicate.isTagged(decision.nextAuthority.state, "Stable"));
        assert.ok(Predicate.isTagged(decision.nextAuthority.state.stable, "Sleeping"));
        assert.deepStrictEqual(decision.nextAuthority.state.stable.backup, backup);
        assert.deepStrictEqual(decision.nextAuthority.state.stable.stop, stop);
      }),
  );

  it.effect(
    "accepts a recovered confirmed BackupPrepared observation while Sleep is reconciling",
    () =>
      Effect.gen(function* () {
        let decision = accepted(decide(legacyWarm(), command("SleepCommand", 1)));
        for (let index = 0; index < 2; index += 1) {
          decision = accepted(
            decide(
              decision.nextAuthority,
              yield* executeSleepTransition(sleepProvider(), committed(decision)),
            ),
          );
        }
        const effect = committed(decision);
        assert.ok(Predicate.isTagged(effect.authority.state, "Transitioning"));
        assert.ok(Predicate.isTagged(effect.authority.state.transition, "Sleep"));
        assert.strictEqual(effect.authority.state.transition.phase, "Syncing");
        const reconciling: CommittedProviderEffectIntent = {
          ...effect,
          authority: {
            ...effect.authority,
            state: {
              _tag: "Transitioning",
              transition: { ...effect.authority.state.transition, mode: "reconciling" },
            },
          },
          intent: { ...effect.intent, _tag: "ReconcileTransition" },
        };
        const input = yield* executeSleepTransition(
          sleepProvider({
            reconcile: () =>
              Effect.succeed({
                _tag: "BackupPrepared",
                backup,
                observedAt: T2,
                resultCode: "backup_prepared_recovered",
              }),
          }),
          reconciling,
        );
        const progressed = accepted(decide(reconciling.authority, input));
        assert.ok(Predicate.isTagged(progressed.nextAuthority.state, "Transitioning"));
        assert.ok(Predicate.isTagged(progressed.nextAuthority.state.transition, "Sleep"));
        assert.strictEqual(progressed.nextAuthority.state.transition.phase, "BackupPrepared");
        assert.deepStrictEqual(
          progressed.nextAuthority.state.transition.proof.backup.confirmed,
          oldBackup,
        );
        assert.deepStrictEqual(
          progressed.nextAuthority.state.transition.proof.backup.prepared,
          backup,
        );
      }),
  );

  it.effect("rejects restoring any backup other than the current confirmed source", () =>
    Effect.gen(function* () {
      const sleeping: SessionAuthority = {
        session,
        hardCap,
        revision: 2,
        state: {
          _tag: "Stable",
          stable: {
            _tag: "Sleeping",
            backup,
            ownedBackupIds: ["older-backup", backup.backupId],
            stop,
            wakeSource: { backupId: backup.backupId, confirmedAt: T2 },
          },
        },
      };
      const admitted = accepted(decide(sleeping, command("ResumeCommand", 2)));
      const failure = yield* Effect.result(
        executeResumeTransition(
          resumeProvider({
            restoreCurrentBackup: () =>
              Effect.succeed({
                _tag: "BackupRestored",
                backupId: "older-backup",
                observedAt: T1,
                resultCode: "wrong_backup_restored",
              }),
          }),
          committed(admitted),
        ),
      );
      assert.ok(Predicate.isTagged(failure, "Failure"));
      assert.strictEqual(failure.failure.safeResultCode, "resume_stale_provider_proof");
    }),
  );

  it.effect("reconciles an ambiguous phase without redispatching its provider mutation", () =>
    Effect.gen(function* () {
      const admitted = accepted(decide(warm(), command("CheckpointCommand", 1)));
      let quiesceCalls = 0;
      let reconcileCalls = 0;
      const provider: CheckpointTransitionProviderShape = {
        ...checkpointProvider(),
        quiescePi: () => {
          quiesceCalls += 1;
          return Effect.fail(
            new CheckpointProviderFailure({
              outcome: "unknown_after_admission",
              safeResultCode: "quiesce_outcome_unknown",
              observedAt: T1,
            }),
          );
        },
        reconcile: () => {
          reconcileCalls += 1;
          return Effect.succeed({
            _tag: "PiQuiesced",
            piStoppedAt: T1,
            observedAt: T1,
            resultCode: "pi_stop_reconciled",
          });
        },
      };
      const effect = committed(admitted);
      const input = yield* executeCheckpointTransition(provider, {
        ...effect,
        intent: { ...effect.intent, _tag: "ReconcileTransition" },
      });
      const progressed = accepted(decide(admitted.nextAuthority, input));
      assert.ok(Predicate.isTagged(progressed.nextAuthority.state, "Transitioning"));
      assert.strictEqual(progressed.nextAuthority.state.transition.phase, "PiStopped");
      assert.strictEqual(quiesceCalls, 0);
      assert.strictEqual(reconcileCalls, 1);
    }),
  );
});
