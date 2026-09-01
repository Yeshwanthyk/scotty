import { Context, Effect, Layer, Match, Predicate, Schema } from "effect";
import {
  AuthorityStateSchema,
  type BackupIdentity,
  BackupIdentitySchema,
  type ReadinessProof,
  type SessionAuthority,
  type SupervisorProof,
  SupervisorProofSchema,
  type TransportProof,
  TransportProofSchema,
  type Transition,
  TransitionSchema,
} from "../authority";
import type { CommittedProviderEffectIntent } from "../effects";
import { ProviderEffectBoundaryFailure, ProviderEffectExecutor } from "../effects";
import type { SessionActorInput } from "../input";

export type CheckpointTransition = Extract<Transition, { readonly _tag: "Checkpoint" }>;
export type CheckpointProof = CheckpointTransition["proof"];

export class CheckpointProviderFailure extends Schema.TaggedError<CheckpointProviderFailure>()(
  "CheckpointProviderFailure",
  {
    outcome: Schema.Literals(["rejected_before_admission", "unknown_after_admission"]),
    safeResultCode: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
    observedAt: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  },
) {}

const ResultBase = {
  observedAt: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  resultCode: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
};

export const CheckpointProviderResultSchema = Schema.Union([
  Schema.TaggedStruct("PiQuiesced", { ...ResultBase, piStoppedAt: Schema.String }),
  Schema.TaggedStruct("WorkspaceSynced", ResultBase),
  Schema.TaggedStruct("BackupPrepared", { ...ResultBase, backup: BackupIdentitySchema }),
  Schema.TaggedStruct("BackupConfirmed", { ...ResultBase, backup: BackupIdentitySchema }),
  Schema.TaggedStruct("SupervisorRestartRequested", ResultBase),
  Schema.TaggedStruct("ReadinessRestored", {
    ...ResultBase,
    supervisor: SupervisorProofSchema,
    transport: TransportProofSchema,
  }),
  Schema.TaggedStruct("TransportVerified", { ...ResultBase, transport: TransportProofSchema }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type CheckpointProviderResult = typeof CheckpointProviderResultSchema.Type;

export interface CheckpointProviderContext {
  readonly authority: SessionAuthority;
  readonly transition: CheckpointTransition;
}

export interface CheckpointTransitionProviderShape {
  readonly quiescePi: (
    context: CheckpointProviderContext,
  ) => Effect.Effect<
    Extract<CheckpointProviderResult, { readonly _tag: "PiQuiesced" }>,
    CheckpointProviderFailure
  >;
  readonly syncWorkspace: (
    context: CheckpointProviderContext,
  ) => Effect.Effect<
    Extract<CheckpointProviderResult, { readonly _tag: "WorkspaceSynced" }>,
    CheckpointProviderFailure
  >;
  readonly prepareBackup: (
    context: CheckpointProviderContext,
  ) => Effect.Effect<
    Extract<CheckpointProviderResult, { readonly _tag: "BackupPrepared" }>,
    CheckpointProviderFailure
  >;
  readonly confirmBackup: (
    context: CheckpointProviderContext,
  ) => Effect.Effect<
    Extract<CheckpointProviderResult, { readonly _tag: "BackupConfirmed" }>,
    CheckpointProviderFailure
  >;
  readonly restartSupervisor: (
    context: CheckpointProviderContext,
  ) => Effect.Effect<
    Extract<CheckpointProviderResult, { readonly _tag: "SupervisorRestartRequested" }>,
    CheckpointProviderFailure
  >;
  readonly confirmTransportReady: (
    context: CheckpointProviderContext,
  ) => Effect.Effect<
    Extract<CheckpointProviderResult, { readonly _tag: "ReadinessRestored" }>,
    CheckpointProviderFailure
  >;
  readonly verifyTransport: (
    context: CheckpointProviderContext,
  ) => Effect.Effect<
    Extract<CheckpointProviderResult, { readonly _tag: "TransportVerified" }>,
    CheckpointProviderFailure
  >;
  readonly reconcile: (
    context: CheckpointProviderContext,
  ) => Effect.Effect<CheckpointProviderResult, CheckpointProviderFailure>;
}

export class CheckpointTransitionProvider extends Context.Service<
  CheckpointTransitionProvider,
  CheckpointTransitionProviderShape
>()("scotty/SessionActor/CheckpointTransitionProvider") {}

export const checkpointTransitionProviderLayer = (
  provider: CheckpointTransitionProviderShape,
): Layer.Layer<CheckpointTransitionProvider> =>
  Layer.succeed(CheckpointTransitionProvider)(CheckpointTransitionProvider.of(provider));

const sameBackup = (left: BackupIdentity, right: BackupIdentity): boolean =>
  left.backupId === right.backupId &&
  left.preparedAt === right.preparedAt &&
  left.sourceRuntimeGeneration === right.sourceRuntimeGeneration;

const supervisorMatches = (supervisor: SupervisorProof, readiness: ReadinessProof): boolean =>
  supervisor.runtimeGeneration === readiness.runtime.runtimeGeneration &&
  supervisor.containerIncarnation === readiness.runtime.containerIncarnation;

const transportMatches = (
  transport: TransportProof,
  readiness: ReadinessProof,
  supervisor: SupervisorProof,
): boolean =>
  transport.runtimeGeneration === readiness.runtime.runtimeGeneration &&
  transport.containerIncarnation === readiness.runtime.containerIncarnation &&
  transport.supervisorEpoch === supervisor.supervisorEpoch;

const boundaryFailure = (
  committed: CommittedProviderEffectIntent,
  transition: CheckpointTransition,
  failure: CheckpointProviderFailure,
): ProviderEffectBoundaryFailure =>
  new ProviderEffectBoundaryFailure({
    expectedRevision: committed.authority.revision,
    transitionNonce: transition.nonce,
    attempt: transition.attempt,
    expectedPhase: transition.phase,
    expectedProviderRuntimeId: transition.proof.readiness.runtime.providerRuntimeId,
    outcome: failure.outcome,
    safeResultCode: failure.safeResultCode,
    observedAt: failure.observedAt,
  });

const staleProof = (
  committed: CommittedProviderEffectIntent,
  transition: CheckpointTransition,
  observedAt: string,
): ProviderEffectBoundaryFailure =>
  boundaryFailure(
    committed,
    transition,
    new CheckpointProviderFailure({
      outcome: "rejected_before_admission",
      safeResultCode: "checkpoint_stale_provider_proof",
      observedAt,
    }),
  );

const factBase = (
  committed: CommittedProviderEffectIntent,
  transition: CheckpointTransition,
  observedAt: string,
) => ({
  revision: committed.authority.revision,
  transitionNonce: transition.nonce,
  attempt: transition.attempt,
  expectedPhase: transition.phase,
  timestamp: observedAt,
  correlationId: committed.journalEvent.correlationId,
});

const progress = (
  committed: CommittedProviderEffectIntent,
  transition: CheckpointTransition,
  nextPhase: CheckpointTransition["phase"],
  proof: CheckpointProof,
  observedAt: string,
  resultCode: string,
): SessionActorInput => ({
  _tag: "ProviderObservation",
  ...factBase(committed, transition, observedAt),
  expectedProviderRuntimeId: transition.proof.readiness.runtime.providerRuntimeId,
  nextPhase,
  proof,
  resultCode,
});

const complete = (
  committed: CommittedProviderEffectIntent,
  transition: CheckpointTransition,
  observedAt: string,
  resultCode: string,
): SessionActorInput => ({
  _tag: "TransitionCompleted",
  ...factBase(committed, transition, observedAt),
  proof: transition.proof,
  resultCode,
});

const applyResult = (
  committed: CommittedProviderEffectIntent,
  transition: CheckpointTransition,
  result: CheckpointProviderResult,
): Effect.Effect<SessionActorInput, ProviderEffectBoundaryFailure> =>
  Match.valueTags(result, {
    PiQuiesced: (value) =>
      transition.phase === "Quiescing" && value.piStoppedAt.length > 0
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "PiStopped",
              { ...transition.proof, piStoppedAt: value.piStoppedAt },
              value.observedAt,
              value.resultCode,
            ),
          )
        : Effect.fail(staleProof(committed, transition, value.observedAt)),
    WorkspaceSynced: (value) =>
      transition.phase === "PiStopped"
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "Syncing",
              transition.proof,
              value.observedAt,
              value.resultCode,
            ),
          )
        : Effect.fail(staleProof(committed, transition, value.observedAt)),
    BackupPrepared: (value) =>
      transition.phase === "Syncing" &&
      value.backup.confirmedAt === null &&
      value.backup.sourceRuntimeGeneration === transition.proof.readiness.runtime.runtimeGeneration
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "BackupPrepared",
              {
                ...transition.proof,
                backup: {
                  ownedBackupIds: [
                    ...new Set([...transition.proof.backup.ownedBackupIds, value.backup.backupId]),
                  ],
                  prepared: value.backup,
                  currentBackupId: transition.proof.backup.currentBackupId,
                },
              },
              value.observedAt,
              value.resultCode,
            ),
          )
        : Effect.fail(staleProof(committed, transition, value.observedAt)),
    BackupConfirmed: (value) => {
      const prepared = transition.proof.backup.prepared;
      return transition.phase === "BackupPrepared" &&
        prepared !== null &&
        value.backup.confirmedAt !== null &&
        sameBackup(value.backup, prepared)
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "BackupConfirmed",
              {
                ...transition.proof,
                backup: {
                  ...transition.proof.backup,
                  prepared: value.backup,
                  currentBackupId: value.backup.backupId,
                },
              },
              value.observedAt,
              value.resultCode,
            ),
          )
        : Effect.fail(staleProof(committed, transition, value.observedAt));
    },
    SupervisorRestartRequested: (value) =>
      transition.phase === "BackupConfirmed"
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "SupervisorRestarting",
              transition.proof,
              value.observedAt,
              value.resultCode,
            ),
          )
        : Effect.fail(staleProof(committed, transition, value.observedAt)),
    ReadinessRestored: (value) =>
      transition.phase === "SupervisorRestarting" &&
      supervisorMatches(value.supervisor, transition.proof.readiness) &&
      transportMatches(value.transport, transition.proof.readiness, value.supervisor)
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "TransportReady",
              {
                ...transition.proof,
                readiness: {
                  ...transition.proof.readiness,
                  supervisor: value.supervisor,
                  transport: value.transport,
                },
              },
              value.observedAt,
              value.resultCode,
            ),
          )
        : Effect.fail(staleProof(committed, transition, value.observedAt)),
    TransportVerified: (value) =>
      transition.phase === "TransportReady" &&
      transportMatches(
        value.transport,
        transition.proof.readiness,
        transition.proof.readiness.supervisor,
      ) &&
      value.transport.transportId === transition.proof.readiness.transport.transportId
        ? Effect.succeed(complete(committed, transition, value.observedAt, value.resultCode))
        : Effect.fail(staleProof(committed, transition, value.observedAt)),
  });

const dispatch = (
  provider: CheckpointTransitionProvider["Service"],
  context: CheckpointProviderContext,
): Effect.Effect<CheckpointProviderResult, CheckpointProviderFailure> =>
  Match.value(context.transition.phase).pipe(
    Match.when("Quiescing", () => provider.quiescePi(context)),
    Match.when("PiStopped", () => provider.syncWorkspace(context)),
    Match.when("Syncing", () => provider.prepareBackup(context)),
    Match.when("BackupPrepared", () => provider.confirmBackup(context)),
    Match.when("BackupConfirmed", () => provider.restartSupervisor(context)),
    Match.when("SupervisorRestarting", () => provider.confirmTransportReady(context)),
    Match.when("TransportReady", () => provider.verifyTransport(context)),
    Match.exhaustive,
  );

export const executeCheckpointTransition = Effect.fnUntraced(function* (
  provider: CheckpointTransitionProvider["Service"],
  committed: CommittedProviderEffectIntent,
) {
  if (!AuthorityStateSchema.guards.Transitioning(committed.authority.state))
    return yield* new ProviderEffectBoundaryFailure({
      expectedRevision: committed.authority.revision,
      transitionNonce: committed.intent.transitionNonce,
      attempt: committed.intent.attempt,
      expectedPhase: committed.intent.phase,
      expectedProviderRuntimeId: null,
      outcome: "rejected_before_admission",
      safeResultCode: "checkpoint_authority_not_transitioning",
      observedAt: committed.journalEvent.timestamp,
    });
  const transition = committed.authority.state.transition;
  if (!TransitionSchema.guards.Checkpoint(transition))
    return yield* new ProviderEffectBoundaryFailure({
      expectedRevision: committed.authority.revision,
      transitionNonce: committed.intent.transitionNonce,
      attempt: committed.intent.attempt,
      expectedPhase: committed.intent.phase,
      expectedProviderRuntimeId: null,
      outcome: "rejected_before_admission",
      safeResultCode: "checkpoint_transition_not_supported",
      observedAt: committed.journalEvent.timestamp,
    });
  if (
    committed.intent.transitionKind !== "Checkpoint" ||
    committed.intent.transitionNonce !== transition.nonce ||
    committed.intent.attempt !== transition.attempt ||
    committed.intent.phase !== transition.phase
  )
    return yield* boundaryFailure(
      committed,
      transition,
      new CheckpointProviderFailure({
        outcome: "rejected_before_admission",
        safeResultCode: "checkpoint_intent_fence_mismatch",
        observedAt: committed.journalEvent.timestamp,
      }),
    );
  const context = { authority: committed.authority, transition };
  const result = yield* (
    Predicate.isTagged(committed.intent, "ReconcileTransition")
      ? provider.reconcile(context)
      : dispatch(provider, context)
  ).pipe(Effect.mapError((failure) => boundaryFailure(committed, transition, failure)));
  return yield* applyResult(committed, transition, result);
});

export const checkpointProviderEffectExecutorLayer: Layer.Layer<
  ProviderEffectExecutor,
  never,
  CheckpointTransitionProvider
> = Layer.effect(
  ProviderEffectExecutor,
  Effect.map(CheckpointTransitionProvider, (provider) =>
    ProviderEffectExecutor.of({
      execute: (committed) => executeCheckpointTransition(provider, committed),
    }),
  ),
);
