import { Context, Effect, Layer, Match, Predicate, Schema } from "effect";
import {
  AuthorityStateSchema,
  type BackupIdentity,
  BackupIdentitySchema,
  type SessionAuthority,
  type StopObservation,
  StopObservationSchema,
  type Transition,
  TransitionSchema,
} from "../authority";
import type { CommittedProviderEffectIntent } from "../effects";
import { ProviderEffectBoundaryFailure, ProviderEffectExecutor } from "../effects";
import type { SessionActorInput } from "../input";

export type SleepTransition = Extract<Transition, { readonly _tag: "Sleep" }>;
export type SleepProof = SleepTransition["proof"];

export class SleepProviderFailure extends Schema.TaggedError<SleepProviderFailure>()(
  "SleepProviderFailure",
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

export const SleepProviderResultSchema = Schema.Union([
  Schema.TaggedStruct("PiQuiesced", { ...ResultBase, piStoppedAt: Schema.String }),
  Schema.TaggedStruct("WorkspaceSynced", ResultBase),
  Schema.TaggedStruct("BackupConfirmed", { ...ResultBase, backup: BackupIdentitySchema }),
  Schema.TaggedStruct("RuntimeStopRequested", { ...ResultBase, requestedAt: Schema.String }),
  Schema.TaggedStruct("RuntimeStopped", { ...ResultBase, stop: StopObservationSchema }),
  Schema.TaggedStruct("RuntimeStopConfirmed", { ...ResultBase, stop: StopObservationSchema }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type SleepProviderResult = typeof SleepProviderResultSchema.Type;

export interface SleepProviderContext {
  readonly authority: SessionAuthority;
  readonly transition: SleepTransition;
}

export interface SleepTransitionProviderShape {
  readonly quiescePi: (
    context: SleepProviderContext,
  ) => Effect.Effect<
    Extract<SleepProviderResult, { readonly _tag: "PiQuiesced" }>,
    SleepProviderFailure
  >;
  readonly syncWorkspace: (
    context: SleepProviderContext,
  ) => Effect.Effect<
    Extract<SleepProviderResult, { readonly _tag: "WorkspaceSynced" }>,
    SleepProviderFailure
  >;
  readonly createConfirmedBackup: (
    context: SleepProviderContext,
  ) => Effect.Effect<
    Extract<SleepProviderResult, { readonly _tag: "BackupConfirmed" }>,
    SleepProviderFailure
  >;
  readonly requestRuntimeStop: (
    context: SleepProviderContext,
  ) => Effect.Effect<
    Extract<SleepProviderResult, { readonly _tag: "RuntimeStopRequested" }>,
    SleepProviderFailure
  >;
  readonly observeRuntimeStopped: (
    context: SleepProviderContext,
  ) => Effect.Effect<
    Extract<SleepProviderResult, { readonly _tag: "RuntimeStopped" }>,
    SleepProviderFailure
  >;
  readonly confirmRuntimeStopped: (
    context: SleepProviderContext,
  ) => Effect.Effect<
    Extract<SleepProviderResult, { readonly _tag: "RuntimeStopConfirmed" }>,
    SleepProviderFailure
  >;
  readonly reconcile: (
    context: SleepProviderContext,
  ) => Effect.Effect<SleepProviderResult, SleepProviderFailure>;
}

export class SleepTransitionProvider extends Context.Service<
  SleepTransitionProvider,
  SleepTransitionProviderShape
>()("scotty/SessionActor/SleepTransitionProvider") {}

export const sleepTransitionProviderLayer = (
  provider: SleepTransitionProviderShape,
): Layer.Layer<SleepTransitionProvider> =>
  Layer.succeed(SleepTransitionProvider)(SleepTransitionProvider.of(provider));

const validBackupForRuntime = (backup: BackupIdentity, transition: SleepTransition): boolean =>
  backup.confirmedAt !== null &&
  backup.sourceRuntimeGeneration === transition.proof.readiness.runtime.runtimeGeneration;

const validStopForRuntime = (stop: StopObservation, transition: SleepTransition): boolean =>
  stop.runtimeGeneration === transition.proof.readiness.runtime.runtimeGeneration;

const boundaryFailure = (
  committed: CommittedProviderEffectIntent,
  transition: SleepTransition,
  failure: SleepProviderFailure,
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
  transition: SleepTransition,
  observedAt: string,
): ProviderEffectBoundaryFailure =>
  boundaryFailure(
    committed,
    transition,
    new SleepProviderFailure({
      outcome: "rejected_before_admission",
      safeResultCode: "sleep_stale_provider_proof",
      observedAt,
    }),
  );

const factBase = (
  committed: CommittedProviderEffectIntent,
  transition: SleepTransition,
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
  transition: SleepTransition,
  nextPhase: SleepTransition["phase"],
  proof: SleepProof,
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
  transition: SleepTransition,
  proof: SleepProof,
  observedAt: string,
  resultCode: string,
): SessionActorInput => ({
  _tag: "TransitionCompleted",
  ...factBase(committed, transition, observedAt),
  proof,
  resultCode,
});

const applyResult = (
  committed: CommittedProviderEffectIntent,
  transition: SleepTransition,
  result: SleepProviderResult,
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
    BackupConfirmed: (value) =>
      transition.phase === "Syncing" && validBackupForRuntime(value.backup, transition)
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "BackupConfirmed",
              {
                ...transition.proof,
                backup: {
                  ownedBackupIds: [
                    ...new Set([...transition.proof.backup.ownedBackupIds, value.backup.backupId]),
                  ],
                  prepared: value.backup,
                  currentBackupId: value.backup.backupId,
                },
              },
              value.observedAt,
              value.resultCode,
            ),
          )
        : Effect.fail(staleProof(committed, transition, value.observedAt)),
    RuntimeStopRequested: (value) =>
      transition.phase === "BackupConfirmed" && value.requestedAt.length > 0
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "StopRequested",
              { ...transition.proof, stopRequestedAt: value.requestedAt },
              value.observedAt,
              value.resultCode,
            ),
          )
        : Effect.fail(staleProof(committed, transition, value.observedAt)),
    RuntimeStopped: (value) => {
      const requestedAt = transition.proof.stopRequestedAt;
      return transition.phase === "StopRequested" &&
        requestedAt !== null &&
        validStopForRuntime(value.stop, transition) &&
        value.stop.requestedAt === requestedAt
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "RuntimeStopped",
              { ...transition.proof, stop: value.stop },
              value.observedAt,
              value.resultCode,
            ),
          )
        : Effect.fail(staleProof(committed, transition, value.observedAt));
    },
    RuntimeStopConfirmed: (value) => {
      const stopped = transition.proof.stop;
      return transition.phase === "RuntimeStopped" &&
        stopped !== null &&
        validStopForRuntime(value.stop, transition) &&
        value.stop.requestedAt === stopped.requestedAt
        ? Effect.succeed(
            complete(
              committed,
              transition,
              { ...transition.proof, stop: value.stop },
              value.observedAt,
              value.resultCode,
            ),
          )
        : Effect.fail(staleProof(committed, transition, value.observedAt));
    },
  });

const dispatch = (
  provider: SleepTransitionProvider["Service"],
  context: SleepProviderContext,
): Effect.Effect<SleepProviderResult, SleepProviderFailure> =>
  Match.value(context.transition.phase).pipe(
    Match.when("Quiescing", () => provider.quiescePi(context)),
    Match.when("PiStopped", () => provider.syncWorkspace(context)),
    Match.when("Syncing", () => provider.createConfirmedBackup(context)),
    Match.when("BackupConfirmed", () => provider.requestRuntimeStop(context)),
    Match.when("StopRequested", () => provider.observeRuntimeStopped(context)),
    Match.when("RuntimeStopped", () => provider.confirmRuntimeStopped(context)),
    Match.exhaustive,
  );

export const executeSleepTransition = Effect.fnUntraced(function* (
  provider: SleepTransitionProvider["Service"],
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
      safeResultCode: "sleep_authority_not_transitioning",
      observedAt: committed.journalEvent.timestamp,
    });
  const transition = committed.authority.state.transition;
  if (!TransitionSchema.guards.Sleep(transition))
    return yield* new ProviderEffectBoundaryFailure({
      expectedRevision: committed.authority.revision,
      transitionNonce: committed.intent.transitionNonce,
      attempt: committed.intent.attempt,
      expectedPhase: committed.intent.phase,
      expectedProviderRuntimeId: null,
      outcome: "rejected_before_admission",
      safeResultCode: "sleep_transition_not_supported",
      observedAt: committed.journalEvent.timestamp,
    });
  if (
    committed.intent.transitionKind !== "Sleep" ||
    committed.intent.transitionNonce !== transition.nonce ||
    committed.intent.attempt !== transition.attempt ||
    committed.intent.phase !== transition.phase
  )
    return yield* boundaryFailure(
      committed,
      transition,
      new SleepProviderFailure({
        outcome: "rejected_before_admission",
        safeResultCode: "sleep_intent_fence_mismatch",
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

export const sleepProviderEffectExecutorLayer: Layer.Layer<
  ProviderEffectExecutor,
  never,
  SleepTransitionProvider
> = Layer.effect(
  ProviderEffectExecutor,
  Effect.map(SleepTransitionProvider, (provider) =>
    ProviderEffectExecutor.of({
      execute: (committed) => executeSleepTransition(provider, committed),
    }),
  ),
);
