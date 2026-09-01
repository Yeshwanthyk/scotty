import { Context, Effect, Layer, Match, Predicate, Schema } from "effect";
import {
  AuthorityStateSchema,
  type RuntimeProof,
  RuntimeProofSchema,
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

export type ResumeTransition = Extract<Transition, { readonly _tag: "Resume" }>;
export type ResumeProof = ResumeTransition["proof"];

export class ResumeProviderFailure extends Schema.TaggedError<ResumeProviderFailure>()(
  "ResumeProviderFailure",
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

export const ResumeProviderResultSchema = Schema.Union([
  Schema.TaggedStruct("BackupRestored", { ...ResultBase, backupId: Schema.String }),
  Schema.TaggedStruct("RuntimeReadyConfirmed", { ...ResultBase, runtime: RuntimeProofSchema }),
  Schema.TaggedStruct("SupervisorStartRequested", ResultBase),
  Schema.TaggedStruct("SupervisorReadyConfirmed", {
    ...ResultBase,
    supervisor: SupervisorProofSchema,
  }),
  Schema.TaggedStruct("TransportVerified", { ...ResultBase, transport: TransportProofSchema }),
  Schema.TaggedStruct("TransportReadyConfirmed", {
    ...ResultBase,
    transport: TransportProofSchema,
  }),
]).pipe(Schema.toTaggedUnion("_tag"));
export type ResumeProviderResult = typeof ResumeProviderResultSchema.Type;

export interface ResumeProviderContext {
  readonly authority: SessionAuthority;
  readonly transition: ResumeTransition;
}

export interface ResumeTransitionProviderShape {
  readonly restoreCurrentBackup: (
    context: ResumeProviderContext,
  ) => Effect.Effect<
    Extract<ResumeProviderResult, { readonly _tag: "BackupRestored" }>,
    ResumeProviderFailure
  >;
  readonly confirmRuntimeReady: (
    context: ResumeProviderContext,
  ) => Effect.Effect<
    Extract<ResumeProviderResult, { readonly _tag: "RuntimeReadyConfirmed" }>,
    ResumeProviderFailure
  >;
  readonly startSupervisor: (
    context: ResumeProviderContext,
  ) => Effect.Effect<
    Extract<ResumeProviderResult, { readonly _tag: "SupervisorStartRequested" }>,
    ResumeProviderFailure
  >;
  readonly confirmSupervisorReady: (
    context: ResumeProviderContext,
  ) => Effect.Effect<
    Extract<ResumeProviderResult, { readonly _tag: "SupervisorReadyConfirmed" }>,
    ResumeProviderFailure
  >;
  readonly verifyTransport: (
    context: ResumeProviderContext,
  ) => Effect.Effect<
    Extract<ResumeProviderResult, { readonly _tag: "TransportVerified" }>,
    ResumeProviderFailure
  >;
  readonly confirmTransportReady: (
    context: ResumeProviderContext,
  ) => Effect.Effect<
    Extract<ResumeProviderResult, { readonly _tag: "TransportReadyConfirmed" }>,
    ResumeProviderFailure
  >;
  readonly reconcile: (
    context: ResumeProviderContext,
  ) => Effect.Effect<ResumeProviderResult, ResumeProviderFailure>;
}

export class ResumeTransitionProvider extends Context.Service<
  ResumeTransitionProvider,
  ResumeTransitionProviderShape
>()("scotty/SessionActor/ResumeTransitionProvider") {}

export const resumeTransitionProviderLayer = (
  provider: ResumeTransitionProviderShape,
): Layer.Layer<ResumeTransitionProvider> =>
  Layer.succeed(ResumeTransitionProvider)(ResumeTransitionProvider.of(provider));

const supervisorMatches = (supervisor: SupervisorProof, runtime: RuntimeProof): boolean =>
  supervisor.runtimeGeneration === runtime.runtimeGeneration &&
  supervisor.containerIncarnation === runtime.containerIncarnation;

const transportMatches = (
  transport: TransportProof,
  runtime: RuntimeProof,
  supervisor: SupervisorProof,
): boolean =>
  transport.runtimeGeneration === runtime.runtimeGeneration &&
  transport.containerIncarnation === runtime.containerIncarnation &&
  transport.supervisorEpoch === supervisor.supervisorEpoch;

const currentProviderRuntimeId = (transition: ResumeTransition): string | null =>
  transition.proof.readiness.runtime?.providerRuntimeId ?? null;

const boundaryFailure = (
  committed: CommittedProviderEffectIntent,
  transition: ResumeTransition,
  failure: ResumeProviderFailure,
): ProviderEffectBoundaryFailure =>
  new ProviderEffectBoundaryFailure({
    expectedRevision: committed.authority.revision,
    transitionNonce: transition.nonce,
    attempt: transition.attempt,
    expectedPhase: transition.phase,
    expectedProviderRuntimeId: currentProviderRuntimeId(transition),
    outcome: failure.outcome,
    safeResultCode: failure.safeResultCode,
    observedAt: failure.observedAt,
  });

const staleProof = (
  committed: CommittedProviderEffectIntent,
  transition: ResumeTransition,
  observedAt: string,
): ProviderEffectBoundaryFailure =>
  boundaryFailure(
    committed,
    transition,
    new ResumeProviderFailure({
      outcome: "rejected_before_admission",
      safeResultCode: "resume_stale_provider_proof",
      observedAt,
    }),
  );

const factBase = (
  committed: CommittedProviderEffectIntent,
  transition: ResumeTransition,
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
  transition: ResumeTransition,
  nextPhase: ResumeTransition["phase"],
  proof: ResumeProof,
  observedAt: string,
  resultCode: string,
): SessionActorInput => ({
  _tag: "ProviderObservation",
  ...factBase(committed, transition, observedAt),
  expectedProviderRuntimeId: currentProviderRuntimeId(transition),
  nextPhase,
  proof,
  resultCode,
});

const complete = (
  committed: CommittedProviderEffectIntent,
  transition: ResumeTransition,
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
  transition: ResumeTransition,
  result: ResumeProviderResult,
): Effect.Effect<SessionActorInput, ProviderEffectBoundaryFailure> =>
  Match.valueTags(result, {
    BackupRestored: (value) =>
      transition.phase === "WatchdogArmed" && value.backupId === transition.proof.backup.backupId
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "BackupRestoring",
              transition.proof,
              value.observedAt,
              value.resultCode,
            ),
          )
        : Effect.fail(staleProof(committed, transition, value.observedAt)),
    RuntimeReadyConfirmed: (value) =>
      transition.phase === "BackupRestoring" &&
      value.runtime.runtimeGeneration.length > 0 &&
      value.runtime.containerIncarnation.length > 0
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "RuntimeReady",
              {
                ...transition.proof,
                readiness: { ...transition.proof.readiness, runtime: value.runtime },
              },
              value.observedAt,
              value.resultCode,
            ),
          )
        : Effect.fail(staleProof(committed, transition, value.observedAt)),
    SupervisorStartRequested: (value) =>
      transition.phase === "RuntimeReady" && transition.proof.readiness.runtime !== null
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "SupervisorStarting",
              transition.proof,
              value.observedAt,
              value.resultCode,
            ),
          )
        : Effect.fail(staleProof(committed, transition, value.observedAt)),
    SupervisorReadyConfirmed: (value) => {
      const runtime = transition.proof.readiness.runtime;
      return transition.phase === "SupervisorStarting" &&
        runtime !== null &&
        supervisorMatches(value.supervisor, runtime)
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "SupervisorReady",
              {
                ...transition.proof,
                readiness: { ...transition.proof.readiness, supervisor: value.supervisor },
              },
              value.observedAt,
              value.resultCode,
            ),
          )
        : Effect.fail(staleProof(committed, transition, value.observedAt));
    },
    TransportVerified: (value) => {
      const runtime = transition.proof.readiness.runtime;
      const supervisor = transition.proof.readiness.supervisor;
      return transition.phase === "SupervisorReady" &&
        runtime !== null &&
        supervisor !== null &&
        transportMatches(value.transport, runtime, supervisor)
        ? Effect.succeed(
            progress(
              committed,
              transition,
              "TransportReady",
              {
                ...transition.proof,
                readiness: { ...transition.proof.readiness, transport: value.transport },
              },
              value.observedAt,
              value.resultCode,
            ),
          )
        : Effect.fail(staleProof(committed, transition, value.observedAt));
    },
    TransportReadyConfirmed: (value) => {
      const runtime = transition.proof.readiness.runtime;
      const supervisor = transition.proof.readiness.supervisor;
      const transport = transition.proof.readiness.transport;
      return transition.phase === "TransportReady" &&
        runtime !== null &&
        supervisor !== null &&
        transport !== null &&
        transportMatches(value.transport, runtime, supervisor) &&
        value.transport.transportId === transport.transportId
        ? Effect.succeed(complete(committed, transition, value.observedAt, value.resultCode))
        : Effect.fail(staleProof(committed, transition, value.observedAt));
    },
  });

const dispatch = (
  provider: ResumeTransitionProvider["Service"],
  context: ResumeProviderContext,
): Effect.Effect<ResumeProviderResult, ResumeProviderFailure> =>
  Match.value(context.transition.phase).pipe(
    Match.when("WatchdogArmed", () => provider.restoreCurrentBackup(context)),
    Match.when("BackupRestoring", () => provider.confirmRuntimeReady(context)),
    Match.when("RuntimeReady", () => provider.startSupervisor(context)),
    Match.when("SupervisorStarting", () => provider.confirmSupervisorReady(context)),
    Match.when("SupervisorReady", () => provider.verifyTransport(context)),
    Match.when("TransportReady", () => provider.confirmTransportReady(context)),
    Match.exhaustive,
  );

export const executeResumeTransition = Effect.fnUntraced(function* (
  provider: ResumeTransitionProvider["Service"],
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
      safeResultCode: "resume_authority_not_transitioning",
      observedAt: committed.journalEvent.timestamp,
    });
  const transition = committed.authority.state.transition;
  if (!TransitionSchema.guards.Resume(transition))
    return yield* new ProviderEffectBoundaryFailure({
      expectedRevision: committed.authority.revision,
      transitionNonce: committed.intent.transitionNonce,
      attempt: committed.intent.attempt,
      expectedPhase: committed.intent.phase,
      expectedProviderRuntimeId: null,
      outcome: "rejected_before_admission",
      safeResultCode: "resume_transition_not_supported",
      observedAt: committed.journalEvent.timestamp,
    });
  if (
    committed.intent.transitionKind !== "Resume" ||
    committed.intent.transitionNonce !== transition.nonce ||
    committed.intent.attempt !== transition.attempt ||
    committed.intent.phase !== transition.phase
  )
    return yield* boundaryFailure(
      committed,
      transition,
      new ResumeProviderFailure({
        outcome: "rejected_before_admission",
        safeResultCode: "resume_intent_fence_mismatch",
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

export const resumeProviderEffectExecutorLayer: Layer.Layer<
  ProviderEffectExecutor,
  never,
  ResumeTransitionProvider
> = Layer.effect(
  ProviderEffectExecutor,
  Effect.map(ResumeTransitionProvider, (provider) =>
    ProviderEffectExecutor.of({
      execute: (committed) => executeResumeTransition(provider, committed),
    }),
  ),
);
